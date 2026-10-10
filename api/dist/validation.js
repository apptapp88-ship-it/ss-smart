"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertJsonObject = assertJsonObject;
exports.parseTrackingIdentifiers = parseTrackingIdentifiers;
exports.validateSearchRequest = validateSearchRequest;
exports.validateCalendarRequest = validateCalendarRequest;
exports.validateHoldRequest = validateHoldRequest;
exports.validateDepositHoldRequest = validateDepositHoldRequest;
exports.validateStaffReviewToken = validateStaffReviewToken;
exports.validateStaffReviewSubmit = validateStaffReviewSubmit;
exports.validateBookingSessionRequest = validateBookingSessionRequest;
exports.validateBookingSessionPathParams = validateBookingSessionPathParams;
exports.validatePayPalCaptureRequest = validatePayPalCaptureRequest;
exports.validatePayPalCapturePathRequest = validatePayPalCapturePathRequest;
exports.validateDepositHandoffQuery = validateDepositHandoffQuery;
exports.validateDepositHandoffEvent = validateDepositHandoffEvent;
exports.validateDepositReceiptUploadUrlRequest = validateDepositReceiptUploadUrlRequest;
exports.validateDepositReceiptConfirmRequest = validateDepositReceiptConfirmRequest;
exports.validatePortalLogin = validatePortalLogin;
exports.validatePortalMessage = validatePortalMessage;
exports.validateCancellationRequest = validateCancellationRequest;
exports.validateReservationPublicId = validateReservationPublicId;
exports.validateGuestUpdateRequest = validateGuestUpdateRequest;
const errors_1 = require("./http/errors");
function assertJsonObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new errors_1.ApiError(400, "invalid_json", "Request body must be a JSON object.");
    }
    return value;
}
/**
 * Best-effort extraction of the tracking identifiers.
 *
 * Deliberately never raises. These values come from cookies a guest (or an
 * extension) can freely mangle, and no attribution signal is worth rejecting a
 * booking over — a dropped identifier costs an attributed conversion, a 400
 * costs the sale itself. Values are length-capped so a hostile client cannot
 * push arbitrary payloads into the database.
 */
function parseTrackingIdentifiers(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const body = value;
    const keys = ["gaClientId", "gaSessionId", "fbp", "fbc", "gclid"];
    const tracking = {};
    for (const key of keys) {
        const raw = body[key];
        if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (trimmed && trimmed.length <= 256) {
                tracking[key] = trimmed;
            }
        }
    }
    return Object.keys(tracking).length > 0 ? tracking : undefined;
}
function validateSearchRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const arrivalDate = requireYmd(body, "arrivalDate", errors);
    const departureDate = requireYmd(body, "departureDate", errors);
    const guests = requirePositiveInteger(body, "guests", errors);
    const language = requireLanguage(body, "language", errors);
    const discountCode = optionalTrimmedString(body, "discountCode", errors, 64);
    const source = optionalTrimmedString(body, "source", errors, 64);
    const tracking = parseTrackingIdentifiers(body.tracking);
    if (arrivalDate && isBeforeTodayCostaRica(arrivalDate)) {
        addError(errors, "arrivalDate", "arrival_date_must_be_today_or_future");
    }
    if (arrivalDate && departureDate && departureDate <= arrivalDate) {
        addError(errors, "departureDate", "departure_date_must_be_after_arrival_date");
    }
    assertNoErrors(errors);
    return {
        arrivalDate,
        departureDate,
        guests,
        language,
        discountCode,
        source,
        ...(tracking ? { tracking } : {}),
        marketingConsent: body.marketingConsent === true,
    };
}
function validateCalendarRequest(params, query) {
    const errors = {};
    const apartmentSlug = normalizeSlug(params.apartmentSlug, errors);
    const month = query.month;
    const language = optionalLanguage(query.language, errors);
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        addError(errors, "month", "month_must_use_yyyy_mm");
    }
    else {
        const date = new Date(`${month}-01T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 7) !== month) {
            addError(errors, "month", "month_must_be_valid");
        }
    }
    assertNoErrors(errors);
    return { apartmentSlug, month: month, language };
}
function validateHoldRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const guest = validateGuestDetails(body.guest, errors);
    const quoteId = requireTrimmedString(body, "quoteId", errors, 128);
    const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
    const propertyId = requireUuid(body, "propertyId", errors);
    const paymentMethod = body.paymentMethod;
    const portalPassword = requireTrimmedString(body, "portalPassword", errors, 256);
    if (paymentMethod !== "paypal") {
        addError(errors, "paymentMethod", "payment_method_must_be_paypal");
    }
    if (portalPassword && portalPassword.length < 12) {
        addError(errors, "portalPassword", "portal_password_too_short");
    }
    if (body.termsAccepted !== true) {
        addError(errors, "termsAccepted", "terms_must_be_accepted");
    }
    assertNoErrors(errors);
    return {
        quoteId,
        bookingSessionId,
        propertyId,
        paymentMethod: "paypal",
        guest,
        portalPassword,
        termsAccepted: true,
        marketingConsent: body.marketingConsent === true,
        nonRefundable: body.nonRefundable === true,
        withPet: body.withPet === true,
        ...(parseTrackingIdentifiers(body.tracking) ? { tracking: parseTrackingIdentifiers(body.tracking) } : {}),
    };
}
/**
 * Deposit holds take the same shape as PayPal holds minus the payment method.
 * The rate options travel with the guest whichever way they pay: `withPet`, and
 * `nonRefundable` — a guest who picks the non-refundable rate keeps its 10%
 * discount when paying by SINPE/transfer, not only via PayPal (#307).
 */
function validateDepositHoldRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const guest = validateGuestDetails(body.guest, errors);
    const quoteId = requireTrimmedString(body, "quoteId", errors, 128);
    const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
    const propertyId = requireUuid(body, "propertyId", errors);
    const portalPassword = requireTrimmedString(body, "portalPassword", errors, 256);
    if (portalPassword && portalPassword.length < 12) {
        addError(errors, "portalPassword", "portal_password_too_short");
    }
    if (body.termsAccepted !== true) {
        addError(errors, "termsAccepted", "terms_must_be_accepted");
    }
    assertNoErrors(errors);
    return {
        quoteId,
        bookingSessionId,
        propertyId,
        paymentMethod: "paypal",
        guest,
        portalPassword,
        termsAccepted: true,
        marketingConsent: body.marketingConsent === true,
        nonRefundable: body.nonRefundable === true,
        withPet: body.withPet === true,
        ...(parseTrackingIdentifiers(body.tracking) ? { tracking: parseTrackingIdentifiers(body.tracking) } : {}),
    };
}
/** Extracts the signed staff token from a path parameter. */
function validateStaffReviewToken(pathParams) {
    const token = pathParams.token?.trim();
    if (!token || token.length < 32 || token.length > 4096) {
        throw new errors_1.ApiError(400, "invalid_token", "This link is not valid.");
    }
    return token;
}
/**
 * Extracts the signed staff token from the review page's submission.
 *
 * The page is plain HTML with no JavaScript — its CSP allows inline styles and
 * nothing else — so the browser sends `application/x-www-form-urlencoded` rather
 * than JSON. JSON is still accepted for scripted callers and tests.
 */
function validateStaffReviewSubmit(rawBody, parsedBody) {
    let token = "";
    if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
        const candidate = parsedBody.token;
        if (typeof candidate === "string") {
            token = candidate.trim();
        }
    }
    if (!token && rawBody) {
        token = new URLSearchParams(rawBody).get("token")?.trim() ?? "";
    }
    if (!token || token.length < 32 || token.length > 4096) {
        throw new errors_1.ApiError(400, "invalid_token", "This link is not valid.");
    }
    return token;
}
function validateBookingSessionRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
    assertNoErrors(errors);
    return { bookingSessionId };
}
function validateBookingSessionPathParams(params) {
    const errors = {};
    const bookingSessionId = requireUuid(params, "bookingSessionId", errors);
    assertNoErrors(errors);
    return { bookingSessionId };
}
function validatePayPalCaptureRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
    const paypalOrderId = requireTrimmedString(body, "paypalOrderId", errors, 128);
    assertNoErrors(errors);
    return { bookingSessionId, paypalOrderId };
}
function validatePayPalCapturePathRequest(params, value) {
    const body = assertJsonObject(value);
    const errors = {};
    const bookingSessionId = requireUuid(params, "bookingSessionId", errors);
    const paypalOrderId = requireTrimmedString(body, "paypalOrderId", errors, 128);
    assertNoErrors(errors);
    return { bookingSessionId, paypalOrderId };
}
function validateDepositHandoffQuery(query) {
    const errors = {};
    const language = requireQueryLanguage(query.language, errors);
    const quoteId = optionalQueryString(query.quoteId, "quoteId", errors, 128);
    const propertyId = optionalUuid(query.propertyId, "propertyId", errors);
    assertNoErrors(errors);
    return { language, quoteId, propertyId };
}
function validateDepositHandoffEvent(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const quoteId = requireTrimmedString(body, "quoteId", errors, 128);
    const propertyId = requireUuid(body, "propertyId", errors);
    const language = requireLanguage(body, "language", errors);
    const contactMethod = requireTrimmedString(body, "contactMethod", errors, 32);
    assertNoErrors(errors);
    return {
        quoteId,
        propertyId,
        language,
        contactMethod,
        analyticsConsent: body.analyticsConsent === true,
    };
}
function validateDepositReceiptUploadUrlRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
    const fileName = requireTrimmedString(body, "fileName", errors, 128);
    const contentType = requireTrimmedString(body, "contentType", errors, 64);
    assertNoErrors(errors);
    return { bookingSessionId, fileName, contentType };
}
function validateDepositReceiptConfirmRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const bookingSessionId = requireUuid(body, "bookingSessionId", errors);
    const s3Key = requireTrimmedString(body, "s3Key", errors, 512);
    assertNoErrors(errors);
    return { bookingSessionId, s3Key };
}
function validatePortalLogin(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const reservationPublicId = requireTrimmedString(body, "reservationPublicId", errors, 64);
    const password = requireTrimmedString(body, "password", errors, 256);
    const language = requireLanguage(body, "language", errors);
    assertNoErrors(errors);
    return { reservationPublicId, password, language };
}
function validatePortalMessage(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const type = optionalTrimmedString(body, "type", errors, 32);
    const message = requireTrimmedString(body, "message", errors, 2000);
    assertNoErrors(errors);
    return { type, message };
}
function validateCancellationRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const reason = requireTrimmedString(body, "reason", errors, 512);
    const message = optionalTrimmedString(body, "message", errors, 2000);
    assertNoErrors(errors);
    return { reason, message };
}
function validateReservationPublicId(params) {
    const value = params.reservationPublicId;
    if (!value || !/^[A-Za-z0-9-]{6,64}$/.test(value)) {
        throw (0, errors_1.validationError)({ reservationPublicId: ["reservation_public_id_invalid"] });
    }
    return value;
}
function validateGuestUpdateRequest(value) {
    const body = assertJsonObject(value);
    const errors = {};
    const guests = requirePositiveInteger(body, "guests", errors);
    assertNoErrors(errors);
    return { guests };
}
function validateGuestDetails(value, errors) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        addError(errors, "guest", "guest_must_be_object");
        return { firstName: "", lastName: "", email: "" };
    }
    const body = value;
    const firstName = requireTrimmedString(body, "firstName", errors, 80, "guest.firstName");
    const lastName = requireTrimmedString(body, "lastName", errors, 80, "guest.lastName");
    const email = requireTrimmedString(body, "email", errors, 254, "guest.email");
    const phone = optionalTrimmedString(body, "phone", errors, 40, "guest.phone");
    const country = optionalTrimmedString(body, "country", errors, 100, "guest.country");
    const message = optionalTrimmedString(body, "message", errors, 2000, "guest.message");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        addError(errors, "guest.email", "email_invalid");
    }
    return { firstName, lastName, email, phone, country, message };
}
function requireTrimmedString(body, key, errors, maxLength, errorKey = key) {
    const value = body[key];
    if (typeof value !== "string" || !value.trim()) {
        addError(errors, errorKey, "required");
        return "";
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        addError(errors, errorKey, "too_long");
    }
    return trimmed;
}
function optionalTrimmedString(body, key, errors, maxLength, errorKey = key) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value !== "string") {
        addError(errors, errorKey, "must_be_string");
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        addError(errors, errorKey, "too_long");
    }
    return trimmed;
}
function optionalQueryString(value, key, errors, maxLength) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.length > maxLength) {
        addError(errors, key, "too_long");
    }
    return trimmed;
}
function requireYmd(body, key, errors) {
    const value = requireTrimmedString(body, key, errors, 10);
    if (value && !isYmd(value)) {
        addError(errors, key, "date_must_use_yyyy_mm_dd");
    }
    return value;
}
function requirePositiveInteger(body, key, errors) {
    const value = body[key];
    if (!Number.isInteger(value) || Number(value) <= 0) {
        addError(errors, key, "must_be_positive_integer");
        return 0;
    }
    return Number(value);
}
function requireLanguage(body, key, errors) {
    const value = body[key];
    if (value !== "en" && value !== "es") {
        addError(errors, key, "language_must_be_en_or_es");
        return "en";
    }
    return value;
}
function requireQueryLanguage(value, errors) {
    if (value !== "en" && value !== "es") {
        addError(errors, "language", "language_must_be_en_or_es");
        return "en";
    }
    return value;
}
function optionalLanguage(value, errors) {
    if (!value) {
        return "en";
    }
    if (value !== "en" && value !== "es") {
        addError(errors, "language", "language_must_be_en_or_es");
        return "en";
    }
    return value;
}
function requireUuid(body, key, errors) {
    const value = requireTrimmedString(body, key, errors, 36);
    if (value && !isUuid(value)) {
        addError(errors, key, "uuid_invalid");
    }
    return value;
}
function optionalUuid(value, key, errors) {
    if (!value) {
        return undefined;
    }
    if (!isUuid(value)) {
        addError(errors, key, "uuid_invalid");
    }
    return value;
}
function normalizeSlug(value, errors) {
    if (!value) {
        addError(errors, "apartmentSlug", "slug_required");
        return "";
    }
    const canonical = value.endsWith("ES") ? value.slice(0, -2) : value;
    if (!/^[A-Za-z0-9]+$/.test(canonical)) {
        addError(errors, "apartmentSlug", "slug_invalid");
    }
    return canonical;
}
function isYmd(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isBeforeTodayCostaRica(value) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Costa_Rica",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const today = `${byType.year}-${byType.month}-${byType.day}`;
    return value < today;
}
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function addError(errors, field, code) {
    errors[field] = [...(errors[field] ?? []), code];
}
function assertNoErrors(errors) {
    if (Object.keys(errors).length > 0) {
        throw (0, errors_1.validationError)(errors);
    }
}
