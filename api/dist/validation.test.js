"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const errors_1 = require("./http/errors");
const validation_1 = require("./validation");
// ─── helpers ────────────────────────────────────────────────────────────────
const FUTURE_DATE = "2099-01-15";
const FUTURE_DATE2 = "2099-01-20";
const VALID_UUID = "11111111-0000-4000-8000-000000000001";
const VALID_UUID2 = "a1b2c3d4-1234-4abc-89ab-000000000001";
function assertValidationError(fn, field, code) {
    let caught;
    try {
        fn();
    }
    catch (err) {
        caught = err;
    }
    if (!(caught instanceof errors_1.ApiError)) {
        throw new Error(`Expected ApiError but got: ${caught}`);
    }
    // "code" as field name means check the top-level error code (for bare ApiErrors with no fieldErrors)
    if (field === "code") {
        if (caught.code !== code) {
            throw new Error(`Expected error code "${code}", got: "${caught.code}"`);
        }
        return;
    }
    const fieldErrors = caught.fieldErrors ?? {};
    const codes = fieldErrors[field] ?? [];
    if (!codes.includes(code)) {
        throw new Error(`Expected field "${field}" to have code "${code}", got: ${JSON.stringify(fieldErrors)}`);
    }
}
// ─── assertJsonObject ────────────────────────────────────────────────────────
test("assertJsonObject: accepts plain object", () => {
    expect((0, validation_1.assertJsonObject)({ a: 1 })).toEqual({ a: 1 });
});
test("assertJsonObject: rejects null", () => {
    assertValidationError(() => (0, validation_1.assertJsonObject)(null), "code", "invalid_json");
});
test("assertJsonObject: rejects array", () => {
    assertValidationError(() => (0, validation_1.assertJsonObject)([1, 2]), "code", "invalid_json");
});
test("assertJsonObject: rejects string", () => {
    assertValidationError(() => (0, validation_1.assertJsonObject)("hello"), "code", "invalid_json");
});
// ─── validateSearchRequest ───────────────────────────────────────────────────
const validSearch = {
    arrivalDate: FUTURE_DATE,
    departureDate: FUTURE_DATE2,
    guests: 2,
    language: "en",
};
test("validateSearchRequest: accepts valid payload", () => {
    expect((0, validation_1.validateSearchRequest)(validSearch)).toMatchObject({
        arrivalDate: FUTURE_DATE,
        departureDate: FUTURE_DATE2,
        guests: 2,
        language: "en",
    });
});
test("validateSearchRequest: accepts language=es", () => {
    expect((0, validation_1.validateSearchRequest)({ ...validSearch, language: "es" })).toMatchObject({
        language: "es",
    });
});
test("validateSearchRequest: rejects departure not after arrival", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, departureDate: FUTURE_DATE }), "departureDate", "departure_date_must_be_after_arrival_date");
});
test("validateSearchRequest: rejects departure before arrival", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, departureDate: "2099-01-10" }), "departureDate", "departure_date_must_be_after_arrival_date");
});
test("validateSearchRequest: rejects non-integer guests", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, guests: 1.5 }), "guests", "must_be_positive_integer");
});
test("validateSearchRequest: rejects zero guests", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, guests: 0 }), "guests", "must_be_positive_integer");
});
test("validateSearchRequest: rejects invalid language", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, language: "fr" }), "language", "language_must_be_en_or_es");
});
test("validateSearchRequest: rejects malformed date", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, arrivalDate: "2099/01/15" }), "arrivalDate", "date_must_use_yyyy_mm_dd");
});
test("validateSearchRequest: rejects impossible date", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, arrivalDate: "2099-02-30" }), "arrivalDate", "date_must_use_yyyy_mm_dd");
});
test("validateSearchRequest: rejects past arrival date", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, arrivalDate: "2000-01-01", departureDate: "2000-01-10" }), "arrivalDate", "arrival_date_must_be_today_or_future");
});
test("validateSearchRequest: optional discountCode trimmed and bounded", () => {
    const result = (0, validation_1.validateSearchRequest)({ ...validSearch, discountCode: "  DISC10  " });
    expect(result.discountCode).toBe("DISC10");
});
test("validateSearchRequest: rejects discountCode over 64 chars", () => {
    assertValidationError(() => (0, validation_1.validateSearchRequest)({ ...validSearch, discountCode: "A".repeat(65) }), "discountCode", "too_long");
});
// ─── validateCalendarRequest ─────────────────────────────────────────────────
test("validateCalendarRequest: accepts valid params", () => {
    const result = (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVilla" }, { month: "2099-06" });
    expect(result).toEqual({ apartmentSlug: "SunsetVilla", month: "2099-06", language: "en" });
});
test("validateCalendarRequest: strips ES suffix from slug", () => {
    const result = (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVillaES" }, { month: "2099-06" });
    expect(result.apartmentSlug).toBe("SunsetVilla");
});
test("validateCalendarRequest: accepts language query param", () => {
    const result = (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVilla" }, { month: "2099-06", language: "es" });
    expect(result.language).toBe("es");
});
test("validateCalendarRequest: defaults language to en when absent", () => {
    const result = (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVilla" }, { month: "2099-06" });
    expect(result.language).toBe("en");
});
test("validateCalendarRequest: rejects month in wrong format", () => {
    assertValidationError(() => (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVilla" }, { month: "06-2099" }), "month", "month_must_use_yyyy_mm");
});
test("validateCalendarRequest: rejects impossible month", () => {
    assertValidationError(() => (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVilla" }, { month: "2099-13" }), "month", "month_must_be_valid");
});
test("validateCalendarRequest: rejects slug with special chars", () => {
    assertValidationError(() => (0, validation_1.validateCalendarRequest)({ apartmentSlug: "SunsetVilla/../../etc" }, { month: "2099-06" }), "apartmentSlug", "slug_invalid");
});
test("validateCalendarRequest: rejects missing slug", () => {
    assertValidationError(() => (0, validation_1.validateCalendarRequest)({}, { month: "2099-06" }), "apartmentSlug", "slug_required");
});
// ─── validateHoldRequest ─────────────────────────────────────────────────────
const validHold = {
    quoteId: "qt_valid",
    bookingSessionId: VALID_UUID,
    propertyId: VALID_UUID2,
    paymentMethod: "paypal",
    guest: {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
    },
    portalPassword: "correct-horse-battery",
    termsAccepted: true,
};
test("validateHoldRequest: accepts valid hold", () => {
    const result = (0, validation_1.validateHoldRequest)(validHold);
    expect(result.paymentMethod).toBe("paypal");
    expect(result.termsAccepted).toBe(true);
});
test("validateHoldRequest: rejects missing termsAccepted", () => {
    assertValidationError(() => (0, validation_1.validateHoldRequest)({ ...validHold, termsAccepted: false }), "termsAccepted", "terms_must_be_accepted");
});
test("validateHoldRequest: rejects short portalPassword", () => {
    assertValidationError(() => (0, validation_1.validateHoldRequest)({ ...validHold, portalPassword: "short" }), "portalPassword", "portal_password_too_short");
});
test("validateHoldRequest: rejects invalid paymentMethod", () => {
    assertValidationError(() => (0, validation_1.validateHoldRequest)({ ...validHold, paymentMethod: "stripe" }), "paymentMethod", "payment_method_must_be_paypal");
});
test("validateHoldRequest: rejects invalid email", () => {
    assertValidationError(() => (0, validation_1.validateHoldRequest)({ ...validHold, guest: { ...validHold.guest, email: "not-an-email" } }), "guest.email", "email_invalid");
});
test("validateHoldRequest: rejects invalid UUID for bookingSessionId", () => {
    assertValidationError(() => (0, validation_1.validateHoldRequest)({ ...validHold, bookingSessionId: "not-a-uuid" }), "bookingSessionId", "uuid_invalid");
});
test("validateHoldRequest: marketingConsent defaults to false", () => {
    const result = (0, validation_1.validateHoldRequest)(validHold);
    expect(result.marketingConsent).toBe(false);
});
test("validateHoldRequest: marketingConsent true when provided", () => {
    const result = (0, validation_1.validateHoldRequest)({ ...validHold, marketingConsent: true });
    expect(result.marketingConsent).toBe(true);
});
// ─── validateBookingSessionRequest ───────────────────────────────────────────
test("validateBookingSessionRequest: accepts valid UUID", () => {
    const result = (0, validation_1.validateBookingSessionRequest)({ bookingSessionId: VALID_UUID });
    expect(result.bookingSessionId).toBe(VALID_UUID);
});
test("validateBookingSessionRequest: rejects missing field", () => {
    assertValidationError(() => (0, validation_1.validateBookingSessionRequest)({}), "bookingSessionId", "required");
});
// ─── validatePayPalCaptureRequest ─────────────────────────────────────────────
test("validatePayPalCaptureRequest: accepts valid payload", () => {
    const result = (0, validation_1.validatePayPalCaptureRequest)({
        bookingSessionId: VALID_UUID,
        paypalOrderId: "ORDER-123",
    });
    expect(result.paypalOrderId).toBe("ORDER-123");
});
test("validatePayPalCaptureRequest: rejects missing paypalOrderId", () => {
    assertValidationError(() => (0, validation_1.validatePayPalCaptureRequest)({ bookingSessionId: VALID_UUID }), "paypalOrderId", "required");
});
// ─── validateDepositHandoffQuery ─────────────────────────────────────────────
test("validateDepositHandoffQuery: accepts valid query", () => {
    const result = (0, validation_1.validateDepositHandoffQuery)({ language: "en" });
    expect(result.language).toBe("en");
    expect(result.quoteId).toBeUndefined();
});
test("validateDepositHandoffQuery: accepts optional quoteId and propertyId", () => {
    const result = (0, validation_1.validateDepositHandoffQuery)({
        language: "es",
        quoteId: "qt_abc",
        propertyId: VALID_UUID,
    });
    expect(result.language).toBe("es");
    expect(result.quoteId).toBe("qt_abc");
    expect(result.propertyId).toBe(VALID_UUID);
});
test("validateDepositHandoffQuery: rejects missing language", () => {
    assertValidationError(() => (0, validation_1.validateDepositHandoffQuery)({}), "language", "language_must_be_en_or_es");
});
test("validateDepositHandoffQuery: rejects invalid propertyId UUID", () => {
    assertValidationError(() => (0, validation_1.validateDepositHandoffQuery)({ language: "en", propertyId: "bad-uuid" }), "propertyId", "uuid_invalid");
});
// ─── validateDepositHandoffEvent ─────────────────────────────────────────────
const validHandoffEvent = {
    quoteId: "qt_abc",
    propertyId: VALID_UUID,
    language: "en",
    contactMethod: "whatsapp",
};
test("validateDepositHandoffEvent: accepts valid payload", () => {
    const result = (0, validation_1.validateDepositHandoffEvent)(validHandoffEvent);
    expect(result.contactMethod).toBe("whatsapp");
    expect(result.analyticsConsent).toBe(false);
});
test("validateDepositHandoffEvent: analyticsConsent true when set", () => {
    const result = (0, validation_1.validateDepositHandoffEvent)({ ...validHandoffEvent, analyticsConsent: true });
    expect(result.analyticsConsent).toBe(true);
});
test("validateDepositHandoffEvent: rejects missing contactMethod", () => {
    assertValidationError(() => (0, validation_1.validateDepositHandoffEvent)({ ...validHandoffEvent, contactMethod: "" }), "contactMethod", "required");
});
// ─── validatePortalLogin ─────────────────────────────────────────────────────
test("validatePortalLogin: accepts valid login", () => {
    const result = (0, validation_1.validatePortalLogin)({ reservationPublicId: "RES-001", password: "secret", language: "en" });
    expect(result.reservationPublicId).toBe("RES-001");
});
test("validatePortalLogin: rejects missing password", () => {
    assertValidationError(() => (0, validation_1.validatePortalLogin)({ reservationPublicId: "RES-001", language: "en" }), "password", "required");
});
// ─── validatePortalMessage ───────────────────────────────────────────────────
test("validatePortalMessage: accepts message", () => {
    const result = (0, validation_1.validatePortalMessage)({ message: "Help please" });
    expect(result.message).toBe("Help please");
    expect(result.type).toBeUndefined();
});
test("validatePortalMessage: rejects empty message", () => {
    assertValidationError(() => (0, validation_1.validatePortalMessage)({ message: "   " }), "message", "required");
});
test("validatePortalMessage: rejects message over 2000 chars", () => {
    assertValidationError(() => (0, validation_1.validatePortalMessage)({ message: "A".repeat(2001) }), "message", "too_long");
});
// ─── validateCancellationRequest ─────────────────────────────────────────────
test("validateCancellationRequest: accepts valid payload", () => {
    const result = (0, validation_1.validateCancellationRequest)({ reason: "Change of plans" });
    expect(result.reason).toBe("Change of plans");
    expect(result.message).toBeUndefined();
});
test("validateCancellationRequest: rejects missing reason", () => {
    assertValidationError(() => (0, validation_1.validateCancellationRequest)({ reason: "" }), "reason", "required");
});
// ─── validateReservationPublicId ─────────────────────────────────────────────
test("validateReservationPublicId: accepts valid alphanumeric-dash id", () => {
    expect((0, validation_1.validateReservationPublicId)({ reservationPublicId: "ABC-123" })).toBe("ABC-123");
});
test("validateReservationPublicId: accepts 6-char minimum", () => {
    expect((0, validation_1.validateReservationPublicId)({ reservationPublicId: "ABCDEF" })).toBe("ABCDEF");
});
test("validateReservationPublicId: rejects too short", () => {
    assertValidationError(() => (0, validation_1.validateReservationPublicId)({ reservationPublicId: "ABC" }), "reservationPublicId", "reservation_public_id_invalid");
});
test("validateReservationPublicId: rejects special chars", () => {
    assertValidationError(() => (0, validation_1.validateReservationPublicId)({ reservationPublicId: "ABC/../../etc" }), "reservationPublicId", "reservation_public_id_invalid");
});
test("validateReservationPublicId: rejects empty", () => {
    assertValidationError(() => (0, validation_1.validateReservationPublicId)({ reservationPublicId: "" }), "reservationPublicId", "reservation_public_id_invalid");
});
// ─── tracking identifiers ────────────────────────────────────────────────────
//
// These come from cookies a guest or a browser extension can freely mangle, so
// the contract is: never reject a booking over an attribution value. A dropped
// identifier costs one attributed conversion; a 400 costs the sale.
test("validateSearchRequest: captures tracking identifiers and marketing consent", () => {
    const result = (0, validation_1.validateSearchRequest)({
        ...validSearch,
        marketingConsent: true,
        tracking: {
            gaClientId: "686566830.1785166389",
            gaSessionId: "1785166389",
            fbp: "fb.1.1785166661469.365729390",
            fbc: "fb.1.1700000000000.abc123",
            gclid: "Cj0KCQ_test",
        },
    });
    expect(result.marketingConsent).toBe(true);
    expect(result.tracking).toEqual({
        gaClientId: "686566830.1785166389",
        gaSessionId: "1785166389",
        fbp: "fb.1.1785166661469.365729390",
        fbc: "fb.1.1700000000000.abc123",
        gclid: "Cj0KCQ_test",
    });
});
test("validateSearchRequest: defaults marketing consent to false when absent", () => {
    const result = (0, validation_1.validateSearchRequest)(validSearch);
    // Fails closed — the API must not report a guest who never consented.
    expect(result.marketingConsent).toBe(false);
    expect(result.tracking).toBeUndefined();
});
test("validateSearchRequest: drops malformed tracking values without failing", () => {
    const result = (0, validation_1.validateSearchRequest)({
        ...validSearch,
        tracking: {
            gaClientId: "keep-me",
            gaSessionId: 12345,
            fbp: { nested: "object" },
            fbc: "   ",
            gclid: "x".repeat(300),
        },
    });
    expect(result.tracking).toEqual({ gaClientId: "keep-me" });
});
test("validateSearchRequest: ignores a non-object tracking field", () => {
    expect((0, validation_1.validateSearchRequest)({ ...validSearch, tracking: "nope" }).tracking).toBeUndefined();
    expect((0, validation_1.validateSearchRequest)({ ...validSearch, tracking: [1, 2] }).tracking).toBeUndefined();
    expect((0, validation_1.validateSearchRequest)({ ...validSearch, tracking: null }).tracking).toBeUndefined();
});
test("validateHoldRequest: carries tracking through the checkout refresh", () => {
    const result = (0, validation_1.validateHoldRequest)({
        ...validHold,
        marketingConsent: true,
        tracking: { gaClientId: "abc.def", fbp: "fb.1.2.3" },
    });
    expect(result.marketingConsent).toBe(true);
    expect(result.tracking).toEqual({ gaClientId: "abc.def", fbp: "fb.1.2.3" });
});
test("validateDepositHoldRequest: carries tracking through the deposit checkout", () => {
    const { paymentMethod: _paymentMethod, ...depositBody } = validHold;
    const result = (0, validation_1.validateDepositHoldRequest)({
        ...depositBody,
        tracking: { gaClientId: "abc.def" },
    });
    expect(result.tracking).toEqual({ gaClientId: "abc.def" });
});
test("validateDepositHoldRequest: honours the non-refundable rate on the deposit path (#307)", () => {
    const { paymentMethod: _paymentMethod, ...depositBody } = validHold;
    // A guest who picked the non-refundable rate keeps it when paying by SINPE;
    // previously the deposit path forced flexible and silently dropped the choice.
    expect((0, validation_1.validateDepositHoldRequest)({ ...depositBody, nonRefundable: true }).nonRefundable).toBe(true);
    // Default and unset stay flexible.
    expect((0, validation_1.validateDepositHoldRequest)(depositBody).nonRefundable).toBe(false);
    expect((0, validation_1.validateDepositHoldRequest)({ ...depositBody, nonRefundable: false }).nonRefundable).toBe(false);
});
