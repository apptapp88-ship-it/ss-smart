"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmoobuClient = exports.SmoobuProviderError = void 0;
exports.createSmoobuClient = createSmoobuClient;
exports.parseRateLimitHeaders = parseRateLimitHeaders;
const node_crypto_1 = require("node:crypto");
const errors_1 = require("./http/errors");
const DEFAULT_SMOOBU_CONFIG = {
    baseUrl: "https://login.smoobu.com",
    timeoutMs: 8000,
    maxRetries: 3,
    baseBackoffMs: 250,
    maxBackoffMs: 2000,
    maxRateLimitDelayMs: 60000,
    holdChannelId: 11,
};
// Keep local defaults so SmoobuClient remains usable in focused tests and
// worker code that constructs it outside loadConfig().
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
class SmoobuProviderError extends errors_1.ApiError {
    constructor(statusCode, code, message, options = {}) {
        super(statusCode, code, message, { retryable: options.retryable });
        this.providerStatusCode = options.providerStatusCode;
        this.rateLimit = options.rateLimit;
    }
}
exports.SmoobuProviderError = SmoobuProviderError;
class SmoobuClient {
    constructor(options) {
        this.rateLimitBlockedUntilMs = 0;
        const apiKey = options.apiKey.trim();
        if (!apiKey) {
            throw new SmoobuProviderError(503, "provider_auth_failed", "Smoobu API key is not configured.");
        }
        const apiSecret = options.apiSecret.trim();
        if (!apiSecret) {
            throw new SmoobuProviderError(503, "provider_auth_failed", "Smoobu API secret is not configured.");
        }
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.config = {
            ...DEFAULT_SMOOBU_CONFIG,
            ...options.config,
            baseUrl: normalizeBaseUrl(options.config?.baseUrl ?? DEFAULT_SMOOBU_CONFIG.baseUrl),
        };
        this.fetchFn = options.fetchFn ?? fetch;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? Date.now;
        this.nonceFn = options.nonceFn ?? (() => (0, node_crypto_1.randomUUID)());
    }
    async request(options, observability) {
        const method = options.method ?? "GET";
        const idempotent = options.idempotent ?? method === "GET";
        const maxAttempts = idempotent ? this.config.maxRetries + 1 : 1;
        const url = this.buildUrl(options.path, options.query);
        const startedAtMs = this.now();
        let finalStatusCode;
        let finalRateLimit = {};
        let finalRetryable = false;
        let finalErrorCode;
        try {
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                try {
                    await this.waitForKnownRateLimitWindow();
                    const response = await this.fetchWithTimeout(url, method, options.body);
                    finalStatusCode = response.status;
                    finalRateLimit = parseRateLimitHeaders(response.headers, this.now);
                    this.updateRateLimitWindow(finalRateLimit);
                    if (response.ok) {
                        const data = await parseJsonResponse(response, this.now);
                        finalRetryable = false;
                        return {
                            data,
                            statusCode: response.status,
                            rateLimit: finalRateLimit,
                        };
                    }
                    finalRetryable = RETRYABLE_STATUS_CODES.has(response.status);
                    finalErrorCode = mapProviderErrorCode(response.status);
                    if (attempt < maxAttempts - 1 && finalRetryable) {
                        await this.sleep(this.retryDelayMs(response, finalRateLimit, attempt));
                        continue;
                    }
                    throw providerHttpError(response.status, finalRateLimit, finalRetryable);
                }
                catch (error) {
                    if (error instanceof SmoobuProviderError) {
                        finalErrorCode = error.code;
                        finalRetryable = error.retryable;
                        finalStatusCode = error.providerStatusCode;
                        finalRateLimit = error.rateLimit ?? finalRateLimit;
                        throw error;
                    }
                    finalRetryable = true;
                    finalErrorCode = isAbortError(error) ? "provider_timeout" : "provider_unavailable";
                    if (attempt < maxAttempts - 1) {
                        await this.sleep(this.backoffDelayMs(attempt));
                        continue;
                    }
                    throw new SmoobuProviderError(503, finalErrorCode, "Smoobu is temporarily unavailable.", {
                        retryable: true,
                    });
                }
            }
            throw new SmoobuProviderError(503, "provider_unavailable", "Smoobu is temporarily unavailable.", {
                retryable: true,
            });
        }
        finally {
            observability?.recordProviderCall({
                provider: "smoobu",
                operation: options.operation,
                durationMs: this.now() - startedAtMs,
                statusCode: finalStatusCode,
                retryable: finalRetryable,
                rateLimitRemaining: finalRateLimit.remaining,
                rateLimitResetSeconds: finalRateLimit.retryAfterSeconds,
                errorCode: finalErrorCode,
            });
        }
    }
    async checkApartmentAvailability(body, observability) {
        return this.request({
            method: "POST",
            path: "/booking/checkApartmentAvailability",
            operation: "checkApartmentAvailability",
            body,
            idempotent: true,
        }, observability);
    }
    async getRates(params, observability) {
        return this.request({
            method: "GET",
            path: "/api/rates",
            operation: "getRates",
            query: {
                "apartments[]": params.apartmentIds,
                start_date: params.startDate,
                end_date: params.endDate,
            },
        }, observability);
    }
    async createReservation(body, observability) {
        return this.request({
            method: "POST",
            path: "/api/reservations",
            operation: "createReservation",
            body,
            idempotent: false,
        }, observability);
    }
    async updateReservation(reservationId, body, observability) {
        return this.request({
            method: "PUT",
            path: `/api/reservations/${encodeURIComponent(String(reservationId))}`,
            operation: "updateReservation",
            body,
            idempotent: true,
        }, observability);
    }
    async cancelReservation(reservationId, observability) {
        return this.request({
            method: "DELETE",
            path: `/api/reservations/${encodeURIComponent(String(reservationId))}`,
            operation: "cancelReservation",
            idempotent: true,
        }, observability);
    }
    async listApartments(observability) {
        return this.request({
            method: "GET",
            path: "/api/apartments",
            operation: "listApartments",
        }, observability);
    }
    async getApartment(apartmentId, observability) {
        return this.request({
            method: "GET",
            path: `/api/apartments/${encodeURIComponent(String(apartmentId))}`,
            operation: "getApartment",
        }, observability);
    }
    buildUrl(path, query = {}) {
        if (!path.startsWith("/") || path.startsWith("//")) {
            throw new SmoobuProviderError(500, "provider_request_invalid", "Smoobu request path is invalid.");
        }
        const url = new URL(path, `${this.config.baseUrl}/`);
        for (const [key, value] of Object.entries(query)) {
            appendQueryParam(url, key, value);
        }
        return url;
    }
    async fetchWithTimeout(url, method, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        const rawBody = body === undefined ? "" : JSON.stringify(body);
        try {
            return await this.fetchFn(url.toString(), {
                method,
                headers: this.buildHeaders(method, url, rawBody),
                body: body === undefined ? undefined : rawBody,
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timeout);
        }
    }
    // HMAC request signing — see docs.smoobu.com/#hmac-authentication. Legacy API
    // Key auth sunsets 2026-09-25; signing every request (not just for new keys)
    // keeps this working on both sides of that date.
    buildHeaders(method, url, rawBody) {
        const timestamp = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
        const nonce = this.nonceFn();
        const bodyHash = (0, node_crypto_1.createHash)("sha256").update(rawBody, "utf8").digest("hex");
        const canonical = [
            method,
            url.pathname,
            canonicalQueryString(url),
            timestamp,
            nonce,
            bodyHash,
            this.apiKey,
        ].join("\n");
        const signature = (0, node_crypto_1.createHmac)("sha256", this.apiSecret).update(canonical, "utf8").digest("base64");
        return {
            Accept: "application/json",
            "X-API-Key": this.apiKey,
            "X-Timestamp": timestamp,
            "X-Nonce": nonce,
            "X-Signature": signature,
            "Cache-Control": "no-cache",
            ...(rawBody ? { "Content-Type": "application/json" } : {}),
        };
    }
    updateRateLimitWindow(rateLimit) {
        if (rateLimit.remaining !== 0 || !rateLimit.retryAfterSeconds) {
            return;
        }
        this.rateLimitBlockedUntilMs = Math.max(this.rateLimitBlockedUntilMs, this.now() + rateLimit.retryAfterSeconds * 1000);
    }
    async waitForKnownRateLimitWindow() {
        const delayMs = this.rateLimitBlockedUntilMs - this.now();
        if (delayMs <= 0) {
            return;
        }
        if (delayMs > this.config.maxRateLimitDelayMs) {
            throw new SmoobuProviderError(503, "provider_rate_limited", "Smoobu rate limit window is still active.", {
                retryable: true,
                rateLimit: {
                    retryAfterSeconds: Math.ceil(delayMs / 1000),
                },
            });
        }
        await this.sleep(delayMs);
    }
    retryDelayMs(response, rateLimit, attempt) {
        const retryAfterMs = parseRetryAfterHeader(response.headers, this.now) ?? secondsToMs(rateLimit.retryAfterSeconds);
        if (retryAfterMs !== undefined) {
            return Math.min(retryAfterMs, this.config.maxRateLimitDelayMs);
        }
        return this.backoffDelayMs(attempt);
    }
    backoffDelayMs(attempt) {
        return Math.min(this.config.baseBackoffMs * 2 ** attempt, this.config.maxBackoffMs);
    }
}
exports.SmoobuClient = SmoobuClient;
async function createSmoobuClient(config) {
    const { smoobuApiKey, smoobuApiSecret } = await config.secrets.getSecrets();
    return new SmoobuClient({
        apiKey: smoobuApiKey,
        apiSecret: smoobuApiSecret,
        config: config.smoobu,
    });
}
// Query params sorted alphabetically by key per the HMAC canonical-string spec.
function canonicalQueryString(url) {
    const params = Array.from(url.searchParams.entries());
    params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
function parseRateLimitHeaders(headers, now = Date.now) {
    const retryAfterEpochSeconds = parseIntegerHeader(headers.get("x-ratelimit-retry-after"));
    const retryAfterSeconds = retryAfterEpochSeconds
        ? Math.max(0, retryAfterEpochSeconds - Math.floor(now() / 1000))
        : undefined;
    return {
        limit: parseIntegerHeader(headers.get("x-ratelimit-limit")),
        remaining: parseIntegerHeader(headers.get("x-ratelimit-remaining")),
        retryAfterEpochSeconds,
        retryAfterSeconds,
    };
}
function normalizeBaseUrl(value) {
    const parsed = new URL(value);
    // This is a hard validation layer for direct SmoobuClient construction.
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
        throw new SmoobuProviderError(500, "provider_request_invalid", "Smoobu base URL must use HTTPS.");
    }
    return parsed.toString().replace(/\/+$/, "");
}
function appendQueryParam(url, key, value) {
    if (value === null || value === undefined) {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            url.searchParams.append(key, String(item));
        }
        return;
    }
    url.searchParams.append(key, String(value));
}
async function parseJsonResponse(response, now) {
    const text = await response.text();
    if (!text.trim()) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new SmoobuProviderError(503, "provider_invalid_response", "Smoobu returned an invalid JSON response.", {
            retryable: true,
            providerStatusCode: response.status,
            rateLimit: parseRateLimitHeaders(response.headers, now),
        });
    }
}
function providerHttpError(statusCode, rateLimit, retryable) {
    if (statusCode === 429) {
        return new SmoobuProviderError(503, "provider_rate_limited", "Smoobu rate limit was reached.", {
            retryable: true,
            providerStatusCode: statusCode,
            rateLimit,
        });
    }
    if (statusCode === 401 || statusCode === 403) {
        return new SmoobuProviderError(503, "provider_auth_failed", "Smoobu authentication failed.", {
            retryable: false,
            providerStatusCode: statusCode,
            rateLimit,
        });
    }
    if (statusCode >= 500 || statusCode === 408) {
        return new SmoobuProviderError(503, "provider_unavailable", "Smoobu is temporarily unavailable.", {
            retryable,
            providerStatusCode: statusCode,
            rateLimit,
        });
    }
    return new SmoobuProviderError(502, "provider_rejected", "Smoobu rejected the request.", {
        retryable: false,
        providerStatusCode: statusCode,
        rateLimit,
    });
}
function mapProviderErrorCode(statusCode) {
    if (statusCode === 429) {
        return "provider_rate_limited";
    }
    if (statusCode === 401 || statusCode === 403) {
        return "provider_auth_failed";
    }
    if (statusCode >= 500 || statusCode === 408) {
        return "provider_unavailable";
    }
    return "provider_rejected";
}
function parseRetryAfterHeader(headers, now) {
    const raw = headers.get("retry-after");
    if (!raw) {
        return undefined;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    const parsedDate = Date.parse(raw);
    if (Number.isNaN(parsedDate)) {
        return undefined;
    }
    return Math.max(0, parsedDate - now());
}
function parseIntegerHeader(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function secondsToMs(seconds) {
    return seconds === undefined ? undefined : seconds * 1000;
}
function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
