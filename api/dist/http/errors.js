"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = void 0;
exports.validationError = validationError;
exports.notImplemented = notImplemented;
class ApiError extends Error {
    constructor(statusCode, code, message, options = {}) {
        super(message);
        this.name = "ApiError";
        this.statusCode = statusCode;
        this.code = code;
        this.fieldErrors = options.fieldErrors;
        this.retryable = options.retryable ?? false;
    }
}
exports.ApiError = ApiError;
function validationError(fieldErrors) {
    return new ApiError(422, "validation_failed", "Please check the highlighted fields.", {
        fieldErrors,
    });
}
function notImplemented(message) {
    return new ApiError(501, "not_implemented", message, { retryable: false });
}
