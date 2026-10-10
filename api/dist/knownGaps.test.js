"use strict";
/**
 * Known-gaps regression net.
 *
 * These tests encode behavior the booking flow SHOULD have but currently
 * doesn't. Each is written with `test.failing()`: Jest treats a failing
 * assertion here as expected (the suite stays green), but the moment the
 * underlying bug is fixed and the test starts passing, Jest reports it as a
 * failure — a nudge to remove `.failing` and confirm the fix landed.
 *
 * Do not add `.failing` tests here speculatively — only for gaps with a
 * fix contract that's unambiguous from the existing code (see each test's
 * comment for why the expected behavior isn't a guess).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const bookingSessions_1 = require("./bookingSessions");
const config_1 = require("./config");
const email_1 = require("./email");
const holds_1 = require("./holds");
const payments_1 = require("./payments");
const paypalWebhooks_1 = require("./paypalWebhooks");
const portalSessions_1 = require("./portalSessions");
const secrets_1 = require("./secrets");
// ── shared happy-path harness (mirrors happyPath.test.ts) ─────────────────────
const PORTAL_SECRET = "portal-session-secret-known-gaps";
const SMOOBU_AVAILABILITY = {
    availableApartments: [100001],
    prices: { "100001": { price: 510, currency: "USD" } },
    errorMessages: {},
};
const SMOOBU_RESERVATION = { id: 9900002 };
const PAYPAL_TOKEN = { access_token: "pp-gaps-token", expires_in: 3600 };
const PAYPAL_ORDER = {
    id: "GAPS-ORDER-001",
    status: "CREATED",
    links: [
        { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=GAPS-ORDER-001", method: "GET" },
        { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/GAPS-ORDER-001", method: "GET" },
    ],
};
const PAYPAL_CAPTURE = {
    id: "GAPS-ORDER-001",
    status: "COMPLETED",
    purchase_units: [
        {
            payments: {
                captures: [
                    { id: "GAPS-CAP-001", status: "COMPLETED", amount: { currency_code: "USD", value: "510.00" } },
                ],
            },
        },
    ],
};
let bookingSessions;
let holds;
let payments;
let webhookEvents;
let portalSessions;
let config;
const originalFetch = global.fetch;
function createTestConfig() {
    bookingSessions = new bookingSessions_1.InMemoryBookingSessionRepository();
    holds = new holds_1.InMemoryHoldRepository();
    payments = new payments_1.InMemoryPaymentRepository();
    webhookEvents = new paypalWebhooks_1.InMemoryWebhookEventRepository();
    portalSessions = new portalSessions_1.InMemoryPortalSessionRepository();
    return {
        allowedOrigins: ["https://booking.test"],
        maxBodyBytes: 64 * 1024,
        secrets: new secrets_1.StaticSecretProvider({
            smoobuApiKey: "smoobu-secret-value",
            smoobuApiSecret: "smoobu-api-secret-value",
            smoobuWebhookSecret: "smoobu-webhook-secret-value",
            paypalClientId: "paypal-client-id-value",
            paypalClientSecret: "paypal-client-secret-value",
            paypalWebhookId: "paypal-webhook-id-value",
            bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
            portalSessionSecret: PORTAL_SECRET,
            rdsConnectionString: "postgres://booking_user:pw@db.test:5432/booking_engine",
        }),
        smoobu: {
            baseUrl: "https://login.smoobu.com",
            customerId: 9,
            timeoutMs: 8000,
            maxRetries: 0,
            baseBackoffMs: 250,
            maxBackoffMs: 2000,
            maxRateLimitDelayMs: 60000,
            holdChannelId: 11,
        },
        paypal: {
            baseUrl: "https://api-m.sandbox.paypal.com",
            timeoutMs: 10000,
            orderReturnUrl: "https://booking.test/book/return",
            orderCancelUrl: "https://booking.test/book/cancel",
        },
        bookingSessions,
        holds,
        payments,
        webhookEvents,
        portalSessions,
        hold: {
            defaultTtlMinutes: 60,
            idempotencyTtlMinutes: 1440,
            staleIdempotencyLockSeconds: 120,
        },
        abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
        email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true, staffNotificationEmail: "staff@example.com" },
        observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
    };
}
function happyPathFetch() {
    return jest.fn(async (url) => {
        const { hostname, pathname } = new URL(url.toString());
        if (hostname === "login.smoobu.com") {
            if (pathname === "/booking/checkApartmentAvailability")
                return jsonResp(SMOOBU_AVAILABILITY);
            if (pathname === "/api/reservations")
                return jsonResp(SMOOBU_RESERVATION);
        }
        if (hostname === "api-m.sandbox.paypal.com") {
            if (pathname === "/v1/oauth2/token")
                return jsonResp(PAYPAL_TOKEN);
            if (pathname === "/v2/checkout/orders")
                return jsonResp(PAYPAL_ORDER);
            if (pathname.endsWith("/capture"))
                return jsonResp(PAYPAL_CAPTURE);
        }
        return jsonResp({ detail: "unexpected call to " + pathname }, { status: 500 });
    });
}
function jsonResp(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: 200,
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
    });
}
function searchEvent() {
    return {
        version: "2.0",
        rawPath: "/api/search",
        headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "gaps-device" },
        body: JSON.stringify({ arrivalDate: "2099-09-01", departureDate: "2099-09-05", guests: 2, language: "en", source: "booking_page" }),
        requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.1" } },
    };
}
function holdEvent(body) {
    return {
        version: "2.0",
        rawPath: "/api/holds",
        headers: {
            "content-type": "application/json",
            "idempotency-key": "gaps-hold-idem-key-0001",
            origin: "https://booking.test",
            "x-booking-device-id": "gaps-device",
        },
        body: JSON.stringify(body),
        requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: "203.0.113.1" } },
    };
}
function orderEvent(bookingSessionId) {
    return {
        version: "2.0",
        rawPath: `/api/bookings/${bookingSessionId}/paypal/create-order`,
        headers: { "idempotency-key": "gaps-order-idem-key-0001", origin: "https://booking.test", "x-booking-device-id": "gaps-device" },
        requestContext: { http: { method: "POST", path: `/api/bookings/${bookingSessionId}/paypal/create-order`, sourceIp: "203.0.113.1" } },
    };
}
function captureEvent(bookingSessionId) {
    return {
        version: "2.0",
        rawPath: `/api/bookings/${bookingSessionId}/paypal/capture`,
        headers: {
            "content-type": "application/json",
            "idempotency-key": "gaps-capture-idem-key-0001",
            origin: "https://booking.test",
            "x-booking-device-id": "gaps-device",
        },
        body: JSON.stringify({ paypalOrderId: "GAPS-ORDER-001" }),
        requestContext: { http: { method: "POST", path: `/api/bookings/${bookingSessionId}/paypal/capture`, sourceIp: "203.0.113.1" } },
    };
}
function loginEvent(reservationPublicId) {
    return {
        version: "2.0",
        rawPath: "/api/portal/login",
        headers: { "content-type": "application/json", origin: "https://booking.test" },
        body: JSON.stringify({ reservationPublicId, password: "hunter2-horse-battery", language: "en" }),
        requestContext: { http: { method: "POST", path: "/api/portal/login", sourceIp: "203.0.113.2" } },
    };
}
function helpRequestEvent(reservationPublicId, token, message) {
    return {
        version: "2.0",
        rawPath: `/api/portal/reservation/${reservationPublicId}/help-request`,
        headers: {
            "content-type": "application/json",
            "idempotency-key": "gaps-help-idem-key-0001",
            origin: "https://booking.test",
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type: "general", message }),
        requestContext: { http: { method: "POST", path: `/api/portal/reservation/${reservationPublicId}/help-request`, sourceIp: "203.0.113.2" } },
    };
}
function cancellationRequestEvent(reservationPublicId, token, message) {
    return {
        version: "2.0",
        rawPath: `/api/portal/reservation/${reservationPublicId}/cancellation-request`,
        headers: {
            "content-type": "application/json",
            "idempotency-key": "gaps-cancel-idem-key-0001",
            origin: "https://booking.test",
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: "change_of_plans", message }),
        requestContext: {
            http: { method: "POST", path: `/api/portal/reservation/${reservationPublicId}/cancellation-request`, sourceIp: "203.0.113.2" },
        },
    };
}
/** Drives search → hold → paypal order → paypal capture, returns the confirmed reservation's public ID and booking session ID. */
async function driveToBookingConfirmed(handler) {
    const searchResp = await handler(searchEvent());
    const { bookingSessionId, quoteId, properties } = JSON.parse(searchResp.body);
    const propertyId = properties[0].propertyId;
    const holdResp = await handler(holdEvent({
        quoteId,
        bookingSessionId,
        propertyId,
        paymentMethod: "paypal",
        guest: { firstName: "Gap", lastName: "Test", email: "gap@booking.test", phone: "+50688000002", country: "CR" },
        portalPassword: "hunter2-horse-battery",
        termsAccepted: true,
    }));
    const { booking } = JSON.parse(holdResp.body);
    await handler(orderEvent(bookingSessionId));
    const captureResp = await handler(captureEvent(bookingSessionId));
    const captureBody = JSON.parse(captureResp.body);
    return { bookingSessionId, reservationPublicId: captureBody.booking.reservationPublicId ?? booking.reservationPublicId };
}
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    config = createTestConfig();
});
afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
});
// ── Gap 1 — no confirmation email on the normal (browser-capture) path ────────
//
// FIXED. handleCapturePayPalOrder (paypalOrders.ts) now sends the same
// booking-confirmed email the PayPal webhook handler sends, scoped to only
// the request that actually made the paypal_order_created -> booking_confirmed
// transition (tracked via `justConfirmed`) so a race with the webhook can't
// double-send.
test("known gap: browser-driven capture sends a booking-confirmed email to the guest", async () => {
    global.fetch = happyPathFetch();
    const sendBookingConfirmedSpy = jest.spyOn(email_1.EmailClient.prototype, "sendBookingConfirmed");
    const handler = (0, app_1.createBookingApiHandler)(config);
    await driveToBookingConfirmed(handler);
    expect(sendBookingConfirmedSpy).toHaveBeenCalled();
});
// ── Gap 2 — portal help/cancellation requests discard the guest's message ─────
//
// FIXED. handlePortalHelpRequest / handlePortalCancellationRequest
// (portalPages.ts) now call EmailClient.sendStaffHelpRequest /
// sendStaffCancellationRequest (both new, following the existing
// sendStaffCancellationAlert/sendStaffDepositReview staff-notification
// pattern in email.ts) inside the same non-fatal try/catch shape used
// elsewhere in this codebase for post-response notifications. The guest's
// free-text message is HTML-escaped in the new email templates
// (emailTemplates.ts) before interpolation — the one genuinely free-form
// user-text field these templates handle, unlike the bounded/structured
// fields (IDs, dates, amounts) the existing templates interpolate.
test("known gap: portal help request forwards the guest's message to a human via email", async () => {
    global.fetch = happyPathFetch();
    const handler = (0, app_1.createBookingApiHandler)(config);
    const { reservationPublicId } = await driveToBookingConfirmed(handler);
    const loginResp = await handler(loginEvent(reservationPublicId));
    const { token } = JSON.parse(loginResp.body);
    const sendSpy = jest.spyOn(email_1.EmailClient.prototype, "send");
    const message = "The air conditioning unit in the bedroom is leaking water onto the floor.";
    const helpResp = await handler(helpRequestEvent(reservationPublicId, token, message));
    expect(helpResp.statusCode).toBe(200);
    const forwarded = sendSpy.mock.calls.some((call) => call.some((arg) => typeof arg === "string" && arg.includes(message)));
    expect(forwarded).toBe(true);
});
test("known gap: portal cancellation request forwards the guest's message to a human via email", async () => {
    global.fetch = happyPathFetch();
    const handler = (0, app_1.createBookingApiHandler)(config);
    const { reservationPublicId } = await driveToBookingConfirmed(handler);
    const loginResp = await handler(loginEvent(reservationPublicId));
    const { token } = JSON.parse(loginResp.body);
    const sendSpy = jest.spyOn(email_1.EmailClient.prototype, "send");
    const message = "Our flights got cancelled, we need to cancel this reservation.";
    const cancelResp = await handler(cancellationRequestEvent(reservationPublicId, token, message));
    expect(cancelResp.statusCode).toBe(200);
    const forwarded = sendSpy.mock.calls.some((call) => call.some((arg) => typeof arg === "string" && arg.includes(message)));
    expect(forwarded).toBe(true);
});
// ── Gap 5 — CAPTCHA provider mismatch between frontend and backend default ────
//
// FIXED. The frontend (Booking.page.tsx) exclusively mints Google reCAPTCHA v3
// tokens via react-google-recaptcha-v3's GoogleReCaptchaProvider, but the
// backend used to default CAPTCHA_PROVIDER to "hcaptcha" whenever the env var
// was unset or unrecognized. A Google token verified against hCaptcha's
// siteverify endpoint never validates, so once abuse thresholds triggered a
// challenge, legitimate guests got permanently stuck. The default now tracks
// the client. Kept as a live regression test — if the frontend widget is ever
// swapped, this must be updated in the same change.
test("default CAPTCHA_PROVIDER matches the frontend's Google reCAPTCHA v3 widget", () => {
    const resolvedConfig = (0, config_1.loadConfig)({ CAPTCHA_SECRET_KEY: "test-secret-key" });
    expect(resolvedConfig.abuseProtection.captchaVerifier?.provider).toBe("recaptcha");
});
test("an unrecognized CAPTCHA_PROVIDER falls back to the frontend's provider rather than the other vendor", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolvedConfig = (0, config_1.loadConfig)({
        CAPTCHA_SECRET_KEY: "test-secret-key",
        CAPTCHA_PROVIDER: "turnstile",
    });
    expect(resolvedConfig.abuseProtection.captchaVerifier?.provider).toBe("recaptcha");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unrecognized CAPTCHA_PROVIDER"));
    warn.mockRestore();
});
test("the CAPTCHA verifier is configured even when the secret only arrives via Secrets Manager", () => {
    const resolvedConfig = (0, config_1.loadConfig)({ CAPTCHA_PROVIDER: "recaptcha" });
    // No CAPTCHA_SECRET_KEY in the environment: the verifier must still exist so
    // AbuseGuard can resolve the secret from the combined Secrets Manager entry.
    expect(resolvedConfig.abuseProtection.captchaVerifier).toEqual({ provider: "recaptcha" });
});
test("hcaptcha remains selectable for deployments that switch providers", () => {
    const resolvedConfig = (0, config_1.loadConfig)({
        CAPTCHA_SECRET_KEY: "test-secret-key",
        CAPTCHA_PROVIDER: "hcaptcha",
    });
    expect(resolvedConfig.abuseProtection.captchaVerifier).toMatchObject({
        provider: "hcaptcha",
        secretKey: "test-secret-key",
    });
});
