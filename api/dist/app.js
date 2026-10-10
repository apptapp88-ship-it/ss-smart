"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBookingApiHandler = createBookingApiHandler;
const config_1 = require("./config");
const abuseProtection_1 = require("./abuseProtection");
const bookingSessions_1 = require("./bookingSessions");
const db_1 = require("./db");
const holds_1 = require("./holds");
const payments_1 = require("./payments");
const paypalWebhooks_1 = require("./paypalWebhooks");
const portalSessions_1 = require("./portalSessions");
const router_1 = require("./http/router");
const observability_1 = require("./observability");
const request_1 = require("./http/request");
const response_1 = require("./http/response");
const routes_1 = require("./routes");
// Holds the in-flight or resolved repository initialisation promise so that
// concurrent requests that arrive before the first pool connection completes
// all await the same Promise rather than each spawning a separate getPool() call.
const repositoryInitializationByConfig = new WeakMap();
function createBookingApiHandler(config = (0, config_1.loadConfig)()) {
    const runtimeConfig = { ...config };
    const router = (0, routes_1.createRouter)(runtimeConfig);
    const abuseGuard = new abuseProtection_1.AbuseGuard(runtimeConfig.abuseProtection, Date.now, runtimeConfig.secrets);
    const observability = (0, observability_1.createObservability)(runtimeConfig.observability);
    return async function bookingApiHandler(event) {
        const startedAtMs = Date.now();
        const headers = (0, request_1.normalizeHeaders)(event.headers);
        const correlationId = (0, request_1.getCorrelationId)(headers);
        const responseHeaders = (0, response_1.buildHeaders)(runtimeConfig, correlationId, (0, request_1.getHeader)(headers, "origin"));
        let method = "GET";
        let path = "/";
        let routePattern;
        let abusePolicy;
        let response;
        let errorForLog;
        try {
            method = (0, request_1.getMethod)(event);
            if (method === "OPTIONS") {
                response = (0, response_1.optionsResponse)(responseHeaders);
                return response;
            }
            path = (0, request_1.getPath)(event);
            const query = (0, request_1.getQuery)(event);
            const { route, pathParams } = router.match({ method, path });
            routePattern = route.pattern;
            abusePolicy = route.options.abuseProtection;
            const rawBody = (0, request_1.getRawBody)(event, runtimeConfig.maxBodyBytes);
            const body = (0, request_1.parseJsonBody)(rawBody, headers, route.options.requireJsonBody ?? false, route.options.allowFormEncodedBody ?? false);
            const request = {
                method,
                path,
                headers,
                responseHeaders,
                query,
                pathParams,
                body,
                rawBody,
                correlationId,
                clientIp: (0, request_1.getClientIp)(event),
                userAgent: (0, request_1.getUserAgent)(event, headers),
                awsRequestId: event.requestContext?.requestId,
                observability: observability.createRouteObservability({
                    correlationId,
                    awsRequestId: event.requestContext?.requestId,
                    method,
                    path,
                    route: route.pattern,
                }),
            };
            (0, router_1.assertRouteHardening)(request, route.options);
            await abuseGuard.assertAllowed(request, route.options.abuseProtection);
            await ensurePersistenceRepositories(runtimeConfig, route.pattern, body);
            response = await route.handler(request);
            return response;
        }
        catch (error) {
            errorForLog = error;
            response = (0, response_1.errorResponse)(error, responseHeaders, correlationId);
            return response;
        }
        finally {
            observability.recordHttpRequest({
                correlationId,
                method,
                path,
                routePattern,
                abusePolicy,
                statusCode: response?.statusCode ?? 500,
                durationMs: Date.now() - startedAtMs,
                clientIp: (0, request_1.getClientIp)(event),
                userAgent: (0, request_1.getUserAgent)(event, headers),
                awsRequestId: event.requestContext?.requestId,
                error: errorForLog,
            });
        }
    };
}
function persistenceRepositoriesRequired(routePattern, body) {
    if (routePattern === "/api/webhooks/smoobu") {
        return !isSmoobuRatesOnlyWebhook(body);
    }
    return (routePattern === "/api/search" ||
        routePattern === "/api/holds" ||
        routePattern === "/api/deposit-holds" ||
        isStaffDepositReviewRoute(routePattern) ||
        isPayPalOrderRoute(routePattern) ||
        isPayPalCaptureRoute(routePattern) ||
        routePattern === "/api/deposit-handoff" ||
        routePattern === "/api/deposit-handoff/events" ||
        routePattern === "/api/deposit-receipt/upload-url" ||
        routePattern === "/api/deposit-receipt/confirm" ||
        routePattern === "/api/webhooks/paypal" ||
        routePattern === "/api/portal/login" ||
        routePattern === "/api/portal/reservation/:reservationPublicId" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/help-request" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/cancellation-request" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/cancel" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/guests");
}
async function ensurePersistenceRepositories(config, routePattern, body) {
    if (!persistenceRepositoriesRequired(routePattern, body)) {
        return;
    }
    const holdsRequired = holdRepositoryRequired(routePattern, body);
    const paymentsRequired = paymentRepositoryRequired(routePattern);
    const webhookEventsRequired = webhookEventRepositoryRequired(routePattern, body);
    if (config.bookingSessions &&
        (!holdsRequired || config.holds) &&
        (!paymentsRequired || config.payments) &&
        (!webhookEventsRequired || config.webhookEvents)) {
        return;
    }
    // Reuse an existing in-flight initialisation promise so concurrent requests
    // that arrive before the pool is ready all await the same work rather than
    // each calling getPool() independently.
    let initPromise = repositoryInitializationByConfig.get(config);
    if (!initPromise) {
        initPromise = (0, db_1.getPool)({ secretProvider: config.secrets }).then((pool) => {
            if (!config.bookingSessions) {
                config.bookingSessions = new bookingSessions_1.RdsBookingSessionRepository(pool);
            }
            if (!config.holds) {
                config.holds = new holds_1.RdsHoldRepository(pool);
            }
            if (!config.payments) {
                config.payments = new payments_1.RdsPaymentRepository(pool);
            }
            if (!config.webhookEvents) {
                config.webhookEvents = new paypalWebhooks_1.RdsWebhookEventRepository(pool);
            }
            if (!config.portalSessions) {
                config.portalSessions = new portalSessions_1.RdsPortalSessionRepository(pool);
            }
        }).catch((err) => {
            // Remove the failed promise so the next request retries pool initialization.
            repositoryInitializationByConfig.delete(config);
            throw err;
        });
        repositoryInitializationByConfig.set(config, initPromise);
    }
    await initPromise;
}
function isStaffDepositReviewRoute(routePattern) {
    return (routePattern === "/api/staff/deposit-review/:token" || routePattern === "/api/staff/deposit-review");
}
function holdRepositoryRequired(routePattern, body) {
    if (routePattern === "/api/webhooks/smoobu") {
        return !isSmoobuRatesOnlyWebhook(body);
    }
    return (routePattern === "/api/holds" ||
        routePattern === "/api/deposit-holds" ||
        isStaffDepositReviewRoute(routePattern) ||
        isPayPalOrderRoute(routePattern) ||
        isPayPalCaptureRoute(routePattern) ||
        routePattern === "/api/deposit-receipt/confirm" ||
        routePattern === "/api/webhooks/paypal" ||
        routePattern === "/api/portal/reservation/:reservationPublicId" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/help-request" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/cancellation-request" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/cancel" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/guests");
}
function paymentRepositoryRequired(routePattern) {
    return (isPayPalOrderRoute(routePattern) ||
        isPayPalCaptureRoute(routePattern) ||
        routePattern === "/api/webhooks/paypal" ||
        routePattern === "/api/portal/reservation/:reservationPublicId" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/help-request" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/cancellation-request" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/cancel" ||
        routePattern === "/api/portal/reservation/:reservationPublicId/guests");
}
function webhookEventRepositoryRequired(routePattern, body) {
    if (routePattern === "/api/webhooks/smoobu") {
        return !isSmoobuRatesOnlyWebhook(body);
    }
    return routePattern === "/api/webhooks/paypal";
}
function isPayPalOrderRoute(routePattern) {
    return (routePattern === "/api/paypal/order" ||
        routePattern === "/api/bookings/:bookingSessionId/paypal/create-order");
}
function isPayPalCaptureRoute(routePattern) {
    return (routePattern === "/api/paypal/capture" ||
        routePattern === "/api/bookings/:bookingSessionId/paypal/capture");
}
function isSmoobuRatesOnlyWebhook(body) {
    return Boolean(body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body.action === "updateRates");
}
