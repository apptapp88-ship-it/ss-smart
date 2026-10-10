"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createObservability = createObservability;
exports.redactForLogs = redactForLogs;
const crypto_1 = require("crypto");
const errors_1 = require("./http/errors");
const METRIC_NAMESPACE = "BookingEngine/Api";
const REDACTED = "[REDACTED]";
const MAX_REDACTION_DEPTH = 5;
const LOG_LEVEL_PRIORITY = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 50,
};
const SENSITIVE_KEY_PATTERN = /authorization|cookie|token|secret|password|passwordhash|api[-_]?key|apikey|signature|session[-_]?token|session[-_]?secret|paypal[-_]?transmission[-_]?sig|x[-_]?smoobu[-_]?webhook[-_]?secret|booking[-_]?encryption[-_]?key|portal[-_]?session[-_]?secret|portal[-_]?password|portal[-_]?password[-_]?hash|^email$|guest[-_.]?email|^phone$|guest[-_.]?phone|^firstName$|^lastName$|guest[-_.]?first[-_]?name|guest[-_.]?last[-_]?name/i;
function createObservability(config, writer = defaultLogWriter) {
    function createLogger(baseFields = {}) {
        return {
            debug: (message, fields) => writeStructuredLog("debug", message, baseFields, fields),
            info: (message, fields) => writeStructuredLog("info", message, baseFields, fields),
            warn: (message, fields) => writeStructuredLog("warn", message, baseFields, fields),
            error: (message, fields) => writeStructuredLog("error", message, baseFields, fields),
        };
    }
    function createRouteObservability(baseFields) {
        const logger = createLogger(baseFields);
        return {
            logger,
            recordProviderCall: (observation) => recordProviderCall(baseFields, observation),
            recordStateTransition: (observation) => recordStateTransition(baseFields, observation),
            recordSecurityEvent: (observation) => recordSecurityEvent(baseFields, observation),
        };
    }
    function recordHttpRequest(observation) {
        const statusCodeClass = `${Math.floor(observation.statusCode / 100)}xx`;
        const errorCode = getErrorCode(observation.error);
        const route = observation.routePattern ?? observation.path;
        const baseFields = {
            correlationId: observation.correlationId,
            awsRequestId: observation.awsRequestId,
            method: observation.method,
            path: observation.path,
            route,
            statusCode: observation.statusCode,
            statusCodeClass,
            durationMs: observation.durationMs,
            abusePolicy: observation.abusePolicy,
            clientIpHash: hashLogValue(observation.clientIp),
            userAgentHash: hashLogValue(observation.userAgent),
            errorCode,
            errorDetail: getErrorDetail(observation.error),
            retryable: isRetryableError(observation.error),
        };
        const level = getHttpLogLevel(observation.statusCode, errorCode);
        writeStructuredLog(level, "http_request_completed", baseFields);
        const metricValues = {
            RequestCount: 1,
            RequestLatencyMs: observation.durationMs,
        };
        if (observation.statusCode >= 400) {
            metricValues.ErrorCount = 1;
        }
        if (observation.statusCode >= 400 && observation.statusCode < 500) {
            metricValues.ClientErrorCount = 1;
        }
        if (observation.statusCode >= 500) {
            metricValues.ServerErrorCount = 1;
        }
        if (observation.statusCode === 429) {
            metricValues.RateLimitedCount = 1;
        }
        if (errorCode === "captcha_required") {
            metricValues.CaptchaRequiredCount = 1;
        }
        if (errorCode === "not_implemented") {
            metricValues.NotImplementedCount = 1;
        }
        if (route.startsWith("/api/webhooks") && observation.statusCode >= 400) {
            metricValues.WebhookRejectedCount = 1;
        }
        if (route.startsWith("/api/webhooks") && observation.statusCode === 401) {
            metricValues.UnauthorizedWebhookCount = 1;
        }
        emitMetric("http_request_metrics", metricValues, {
            route,
            method: observation.method,
            statusCodeClass,
        });
        const alertName = getHttpAlertName(route, observation.statusCode, errorCode);
        if (alertName) {
            writeStructuredLog("error", "operational_alert", {
                ...baseFields,
                alertName,
                severity: alertName === "booking_api_unhandled_error" ? "critical" : "warning",
            });
            emitMetric("operational_alert_metrics", { OperationalAlertCount: 1 }, { alertName, route });
        }
    }
    function recordProviderCall(baseFields, observation) {
        const level = observation.errorCode || isProviderFailure(observation.statusCode) ? "warn" : "info";
        writeStructuredLog(level, "provider_call_completed", {
            ...baseFields,
            provider: observation.provider,
            operation: observation.operation,
            statusCode: observation.statusCode,
            durationMs: observation.durationMs,
            retryable: observation.retryable,
            rateLimitRemaining: observation.rateLimitRemaining,
            rateLimitResetSeconds: observation.rateLimitResetSeconds,
            errorCode: observation.errorCode,
            errorDetail: observation.errorDetail,
        });
        const metricValues = {
            ProviderRequestCount: 1,
            ProviderLatencyMs: observation.durationMs,
        };
        if (observation.errorCode || isProviderFailure(observation.statusCode)) {
            metricValues.ProviderErrorCount = 1;
        }
        if (observation.provider === "smoobu" && observation.statusCode === 429) {
            metricValues.SmoobuRateLimitedCount = 1;
        }
        emitMetric("provider_call_metrics", metricValues, {
            provider: observation.provider,
            operation: observation.operation,
        });
        if (observation.provider === "smoobu" && (observation.statusCode === 429 || observation.errorCode)) {
            writeStructuredLog("error", "operational_alert", {
                ...baseFields,
                alertName: "smoobu_provider_degraded",
                severity: "warning",
                provider: observation.provider,
                operation: observation.operation,
                statusCode: observation.statusCode,
                errorCode: observation.errorCode,
            });
        }
    }
    function recordStateTransition(baseFields, observation) {
        writeStructuredLog(observation.success ? "info" : "error", "booking_state_transition", {
            ...baseFields,
            ...redactRecord(observation),
        });
        emitMetric("booking_state_transition_metrics", {
            BookingStateTransitionCount: 1,
            BookingStateTransitionFailureCount: observation.success ? 0 : 1,
        }, {
            entityType: observation.entityType,
            action: observation.action,
            toState: observation.toState,
        });
        if (!observation.success) {
            writeStructuredLog("error", "operational_alert", {
                ...baseFields,
                alertName: "booking_state_transition_failed",
                severity: "critical",
                entityType: observation.entityType,
                action: observation.action,
                toState: observation.toState,
                errorCode: observation.errorCode,
            });
        }
    }
    function recordSecurityEvent(baseFields, observation) {
        const level = observation.severity === "info" ? "info" : observation.severity;
        writeStructuredLog(level, "security_event", {
            ...baseFields,
            ...redactRecord(observation),
        });
        emitMetric("security_event_metrics", { SecurityEventCount: 1 }, {
            securityEvent: observation.name,
            severity: observation.severity,
        });
    }
    function writeStructuredLog(level, message, baseFields = {}, fields = {}) {
        if (!isLevelEnabled(config.logLevel, level)) {
            return;
        }
        writer(level, {
            timestamp: new Date().toISOString(),
            level,
            service: config.serviceName,
            environment: config.environment,
            eventType: message,
            ...redactRecord(baseFields),
            ...redactRecord(fields),
        });
    }
    function emitMetric(eventType, metricValues, dimensions) {
        if (!config.metricsEnabled) {
            return;
        }
        const metricNames = Object.keys(metricValues);
        writer("info", {
            timestamp: new Date().toISOString(),
            level: "info",
            service: config.serviceName,
            environment: config.environment,
            eventType,
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                    {
                        Namespace: METRIC_NAMESPACE,
                        Dimensions: [
                            ["Service", "Environment"],
                            ["Service", "Environment", ...Object.keys(dimensions).map(toPascalCase)],
                        ],
                        Metrics: metricNames.map((name) => ({
                            Name: name,
                            Unit: name.endsWith("LatencyMs") ? "Milliseconds" : "Count",
                        })),
                    },
                ],
            },
            Service: config.serviceName,
            Environment: config.environment,
            ...mapMetricDimensions(dimensions),
            ...metricValues,
        });
    }
    return {
        createLogger,
        createRouteObservability,
        recordHttpRequest,
    };
}
function redactForLogs(value, depth = 0) {
    if (depth > MAX_REDACTION_DEPTH) {
        return "[MAX_DEPTH]";
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactForLogs(item, depth + 1));
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            redacted[key] = REDACTED;
        }
        else {
            redacted[key] = redactForLogs(item, depth + 1);
        }
    }
    return redacted;
}
function redactRecord(value) {
    return redactForLogs(value);
}
function defaultLogWriter(level, entry) {
    const line = JSON.stringify(entry);
    if (level === "error") {
        console.error(line);
        return;
    }
    if (level === "warn") {
        console.warn(line);
        return;
    }
    console.log(line);
}
function getHttpLogLevel(statusCode, errorCode) {
    if (statusCode >= 500 && errorCode !== "not_implemented") {
        return "error";
    }
    if (statusCode >= 400) {
        return "warn";
    }
    return "info";
}
function getHttpAlertName(route, statusCode, errorCode) {
    if (route.startsWith("/api/webhooks/paypal") && statusCode >= 400) {
        return "paypal_webhook_rejected";
    }
    if (route.startsWith("/api/webhooks/smoobu") && statusCode === 401) {
        return "smoobu_webhook_auth_failure";
    }
    if (errorCode === "rate_limited") {
        return "public_rate_limit_triggered";
    }
    if (errorCode === "captcha_required") {
        return "captcha_escalation_triggered";
    }
    if (statusCode >= 500 && errorCode !== "not_implemented") {
        return "booking_api_unhandled_error";
    }
    return undefined;
}
function getErrorCode(error) {
    if (error instanceof errors_1.ApiError) {
        return error.code;
    }
    if (error) {
        return "internal_error";
    }
    return undefined;
}
// Duck-typed rather than importing PayPalProviderError, to keep this
// generic observability module from depending on a specific provider client.
function getErrorDetail(error) {
    if (error && typeof error === "object" && "providerDetail" in error) {
        const detail = error.providerDetail;
        return typeof detail === "string" ? detail : undefined;
    }
    return undefined;
}
function isRetryableError(error) {
    if (error instanceof errors_1.ApiError) {
        return error.retryable;
    }
    if (error) {
        return true;
    }
    return undefined;
}
function isProviderFailure(statusCode) {
    return typeof statusCode === "number" && statusCode >= 400;
}
function isLevelEnabled(configured, actual) {
    return LOG_LEVEL_PRIORITY[actual] >= LOG_LEVEL_PRIORITY[configured];
}
function hashLogValue(value) {
    if (!value) {
        return undefined;
    }
    return (0, crypto_1.createHash)("sha256").update(value).digest("hex").slice(0, 32);
}
function mapMetricDimensions(dimensions) {
    const mapped = {};
    for (const [key, value] of Object.entries(dimensions)) {
        mapped[toPascalCase(key)] = String(value ?? "unknown");
    }
    return mapped;
}
function toPascalCase(value) {
    return value
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}
