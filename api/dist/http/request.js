"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeHeaders = normalizeHeaders;
exports.getHeader = getHeader;
exports.getMethod = getMethod;
exports.getPath = getPath;
exports.getQuery = getQuery;
exports.getCorrelationId = getCorrelationId;
exports.getRawBody = getRawBody;
exports.parseJsonBody = parseJsonBody;
exports.getClientIp = getClientIp;
exports.getUserAgent = getUserAgent;
const crypto_1 = require("crypto");
const errors_1 = require("./errors");
function normalizeHeaders(headers) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (typeof value === "string") {
            normalized[key.toLowerCase()] = value;
        }
    }
    return normalized;
}
function getHeader(headers, name) {
    return headers[name.toLowerCase()];
}
function getMethod(event) {
    const method = event.httpMethod ?? event.requestContext?.http?.method ?? event.routeKey?.split(" ")[0] ?? "GET";
    const upper = method.toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(upper)) {
        return upper;
    }
    throw new errors_1.ApiError(405, "method_not_allowed", "HTTP method is not allowed.");
}
function getPath(event) {
    const rawPath = event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
    const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return normalized.replace(/\/+$/, "") || "/";
}
function getQuery(event) {
    const result = {};
    for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
        if (typeof value === "string") {
            result[key] = value;
        }
    }
    return result;
}
function getCorrelationId(headers) {
    const provided = getHeader(headers, "x-correlation-id");
    if (provided && provided.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(provided)) {
        return provided;
    }
    return (0, crypto_1.randomUUID)();
}
function getRawBody(event, maxBodyBytes) {
    if (!event.body) {
        return "";
    }
    const bytes = event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body, "utf8");
    if (bytes.length > maxBodyBytes) {
        throw new errors_1.ApiError(413, "payload_too_large", "Request body is too large.");
    }
    return bytes.toString("utf8");
}
function parseJsonBody(rawBody, headers, required, allowFormEncodedBody = false) {
    if (!rawBody) {
        if (required) {
            throw new errors_1.ApiError(400, "invalid_json", "Request body must be valid JSON.");
        }
        return undefined;
    }
    const contentType = getHeader(headers, "content-type");
    // Form-encoded bodies are left unparsed for the handler to read from rawBody.
    if (allowFormEncodedBody && contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
        return undefined;
    }
    if (!contentType?.toLowerCase().includes("application/json")) {
        throw new errors_1.ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
    }
    try {
        return JSON.parse(rawBody);
    }
    catch {
        throw new errors_1.ApiError(400, "invalid_json", "Request body must be valid JSON.");
    }
}
function getClientIp(event) {
    return event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp;
}
function getUserAgent(event, headers) {
    return (event.requestContext?.http?.userAgent ??
        event.requestContext?.identity?.userAgent ??
        getHeader(headers, "user-agent"));
}
