"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
exports.assertRouteHardening = assertRouteHardening;
const errors_1 = require("./errors");
const request_1 = require("./request");
class Router {
    constructor() {
        this.routes = [];
    }
    get(pattern, handler, options = {}) {
        this.routes.push({ method: "GET", pattern, handler, options });
    }
    post(pattern, handler, options = {}) {
        this.routes.push({ method: "POST", pattern, handler, options });
    }
    put(pattern, handler, options = {}) {
        this.routes.push({ method: "PUT", pattern, handler, options });
    }
    match(request) {
        for (const route of this.routes) {
            if (route.method !== request.method) {
                continue;
            }
            const pathParams = matchPattern(route.pattern, request.path);
            if (pathParams) {
                return { route, pathParams };
            }
        }
        throw new errors_1.ApiError(404, "not_found", "Endpoint not found.");
    }
}
exports.Router = Router;
function assertRouteHardening(request, options) {
    if (options.requireIdempotencyKey) {
        const key = (0, request_1.getHeader)(request.headers, "idempotency-key");
        if (!key || key.length < 16 || key.length > 128) {
            throw new errors_1.ApiError(400, "missing_idempotency_key", "A valid Idempotency-Key header is required.");
        }
    }
    if (options.rejectQuerySecrets) {
        const forbiddenKeys = ["secret", "token", "api_key", "apikey", "key", "password", "auth"];
        const found = forbiddenKeys.find((key) => Object.prototype.hasOwnProperty.call(request.query, key));
        if (found) {
            throw new errors_1.ApiError(400, "query_secret_not_allowed", `Query-string secret '${found}' is not allowed.`);
        }
    }
}
function matchPattern(pattern, path) {
    const patternParts = splitPath(pattern);
    const pathParts = splitPath(path);
    if (patternParts.length !== pathParts.length) {
        return null;
    }
    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const expected = patternParts[index];
        const actual = pathParts[index];
        if (expected.startsWith(":")) {
            params[expected.slice(1)] = decodeURIComponent(actual);
            continue;
        }
        if (expected !== actual) {
            return null;
        }
    }
    return params;
}
function splitPath(path) {
    return path.split("/").filter(Boolean);
}
