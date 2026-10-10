"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHeaders = buildHeaders;
exports.jsonResponse = jsonResponse;
exports.htmlResponse = htmlResponse;
exports.errorResponse = errorResponse;
exports.optionsResponse = optionsResponse;
const errors_1 = require("./errors");
const SECURITY_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
function buildHeaders(config, correlationId, requestOrigin) {
    const headers = {
        ...SECURITY_HEADERS,
        "X-Correlation-Id": correlationId,
    };
    if (requestOrigin && config.allowedOrigins.includes(requestOrigin)) {
        headers["Access-Control-Allow-Origin"] = requestOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Vary"] = "Origin";
    }
    return headers;
}
function jsonResponse(statusCode, body, headers) {
    return {
        statusCode,
        headers,
        body: JSON.stringify(body),
        isBase64Encoded: false,
    };
}
/**
 * HTML response, used only by the staff deposit-review page.
 *
 * The API is otherwise JSON-only and SECURITY_HEADERS pins
 * `Content-Type: application/json` with `default-src 'none'`, which would block
 * the page's own inline styles. This overrides both, keeps the page out of
 * frames and search indexes, and allows nothing but inline CSS.
 */
function htmlResponse(statusCode, html, headers) {
    return {
        statusCode,
        headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none'",
            "X-Robots-Tag": "noindex, nofollow",
        },
        body: html,
        isBase64Encoded: false,
    };
}
function errorResponse(error, headers, correlationId) {
    if (error instanceof errors_1.ApiError) {
        // Strip fieldErrors from 5xx responses to avoid leaking internal state
        const includeFieldErrors = error.statusCode < 500;
        return jsonResponse(error.statusCode, {
            error: {
                code: error.code,
                message: error.statusCode >= 500 ? "Unexpected server error." : error.message,
                ...(includeFieldErrors && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
                retryable: error.retryable,
                correlationId,
            },
        }, headers);
    }
    return jsonResponse(500, {
        error: {
            code: "internal_error",
            message: "Unexpected server error.",
            retryable: true,
            correlationId,
        },
    }, headers);
}
function optionsResponse(headers) {
    return {
        statusCode: 204,
        headers: {
            ...headers,
            "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
            "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept,Accept-Language,X-Correlation-Id,Idempotency-Key,X-Booking-Device-Id,X-Device-Id,X-Captcha-Token,X-Smoobu-Webhook-Secret,PAYPAL-AUTH-ALGO,PAYPAL-CERT-URL,PAYPAL-TRANSMISSION-ID,PAYPAL-TRANSMISSION-SIG,PAYPAL-TRANSMISSION-TIME",
            "Access-Control-Max-Age": "600",
        },
        body: "",
        isBase64Encoded: false,
    };
}
