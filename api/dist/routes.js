"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRouter = createRouter;
const request_1 = require("./http/request");
const response_1 = require("./http/response");
const errors_1 = require("./http/errors");
const router_1 = require("./http/router");
const calendar_1 = require("./calendar");
const exchangeRate_1 = require("./exchangeRate");
const portalAuth_1 = require("./portalAuth");
const portalPages_1 = require("./portalPages");
const depositHandoff_1 = require("./depositHandoff");
const depositReceipt_1 = require("./depositReceipt");
const holds_1 = require("./holds");
const depositHolds_1 = require("./depositHolds");
const depositConfirm_1 = require("./depositConfirm");
const paypalOrders_1 = require("./paypalOrders");
const paypalWebhooks_1 = require("./paypalWebhooks");
const search_1 = require("./search");
const smoobuWebhooks_1 = require("./smoobuWebhooks");
const validation_1 = require("./validation");
function createRouter(config) {
    const router = new router_1.Router();
    router.get("/api/health", healthHandler);
    router.post("/api/search", async (request) => {
        const searchRequest = (0, validation_1.validateSearchRequest)(request.body);
        return (0, search_1.handleAvailabilitySearch)(searchRequest, config, request.responseHeaders, request.observability);
    }, { requireJsonBody: true, abuseProtection: "availabilitySearch" });
    // Display-only USD → CRC rate for the Spanish booking flow. No parameters:
    // one currency pair, one cached answer for every caller.
    router.get("/api/exchange-rate", async (request) => {
        return (0, exchangeRate_1.handleExchangeRateRequest)(config, request.responseHeaders, request.observability);
    }, { abuseProtection: "publicRead" });
    router.get("/api/calendar/:apartmentSlug", async (request) => {
        const calendarRequest = (0, validation_1.validateCalendarRequest)(request.pathParams, request.query);
        return (0, calendar_1.handleCalendarRequest)(calendarRequest, config, request.responseHeaders, request.observability);
    }, { abuseProtection: "publicRead" });
    router.post("/api/holds", async (request) => {
        const holdRequest = (0, validation_1.validateHoldRequest)(request.body);
        return (0, holds_1.handleCreatePayPalHold)(holdRequest, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "holdCreate" });
    router.post("/api/paypal/order", async (request) => {
        const body = (0, validation_1.validateBookingSessionRequest)(request.body);
        return (0, paypalOrders_1.handleCreatePayPalOrder)(body, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "paymentCreate" });
    router.post("/api/bookings/:bookingSessionId/paypal/create-order", async (request) => {
        const body = (0, validation_1.validateBookingSessionPathParams)(request.pathParams);
        return (0, paypalOrders_1.handleCreatePayPalOrder)(body, request, config);
    }, { requireIdempotencyKey: true, abuseProtection: "paymentCreate" });
    router.post("/api/paypal/capture", async (request) => {
        const body = (0, validation_1.validatePayPalCaptureRequest)(request.body);
        return (0, paypalOrders_1.handleCapturePayPalOrder)(body, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "paymentCapture" });
    router.post("/api/bookings/:bookingSessionId/paypal/capture", async (request) => {
        const body = (0, validation_1.validatePayPalCapturePathRequest)(request.pathParams, request.body);
        return (0, paypalOrders_1.handleCapturePayPalOrder)(body, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "paymentCapture" });
    router.post("/api/deposit-holds", async (request) => {
        const holdRequest = (0, validation_1.validateDepositHoldRequest)(request.body);
        return (0, depositHolds_1.handleCreateDepositHold)(holdRequest, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "holdCreate" });
    // Staff deposit review. GET renders a one-screen summary with a single button;
    // the POST performs the action. Splitting them keeps email scanners and
    // link-preview bots from confirming bookings by merely fetching the URL.
    router.get("/api/staff/deposit-review/:token", async (request) => {
        const token = (0, validation_1.validateStaffReviewToken)(request.pathParams);
        return (0, depositConfirm_1.handleStaffDepositReviewPage)(token, request, config);
    }, { abuseProtection: "portalRead" });
    router.post("/api/staff/deposit-review", async (request) => {
        const token = (0, validation_1.validateStaffReviewSubmit)(request.rawBody, request.body);
        return (0, depositConfirm_1.handleStaffDepositReviewSubmit)(token, request, config);
    }, { allowFormEncodedBody: true, preserveRawBody: true, abuseProtection: "portalWrite" });
    router.get("/api/deposit-handoff", async (request) => {
        const query = (0, validation_1.validateDepositHandoffQuery)(request.query);
        return (0, depositHandoff_1.handleManualDepositHandoff)(query, config, request.responseHeaders, request.observability);
    }, { abuseProtection: "publicRead" });
    router.post("/api/deposit-handoff/events", async (request) => {
        const event = (0, validation_1.validateDepositHandoffEvent)(request.body);
        return (0, depositHandoff_1.handleManualDepositHandoffEvent)(event, config, request.responseHeaders, request.observability);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "depositEvent" });
    router.post("/api/deposit-receipt/upload-url", async (request) => {
        const body = (0, validation_1.validateDepositReceiptUploadUrlRequest)(request.body);
        return (0, depositReceipt_1.handleDepositReceiptUploadUrl)(body, config, request.responseHeaders, request.observability, (0, request_1.getHeader)(request.headers, "authorization"));
    }, { requireJsonBody: true, abuseProtection: "depositEvent" });
    router.post("/api/deposit-receipt/confirm", async (request) => {
        const body = (0, validation_1.validateDepositReceiptConfirmRequest)(request.body);
        return (0, depositReceipt_1.handleDepositReceiptConfirm)(body, config, request.responseHeaders, request.observability, (0, request_1.getHeader)(request.headers, "authorization"));
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "depositEvent" });
    router.post("/api/webhooks/paypal", async (request) => {
        (0, validation_1.assertJsonObject)(request.body);
        assertPayPalWebhookHeaders(request);
        return (0, paypalWebhooks_1.handlePayPalWebhook)(request, config);
    }, { requireJsonBody: true, preserveRawBody: true, abuseProtection: "webhook" });
    router.post("/api/webhooks/smoobu", async (request) => {
        const body = (0, validation_1.assertJsonObject)(request.body);
        return (0, smoobuWebhooks_1.handleSmoobuWebhook)(request, config, body);
    }, { requireJsonBody: true, preserveRawBody: true, rejectQuerySecrets: true, abuseProtection: "webhook" });
    router.post("/api/portal/login", async (request) => {
        const body = (0, validation_1.validatePortalLogin)(request.body);
        return (0, portalAuth_1.handlePortalLogin)(body, request, config);
    }, { requireJsonBody: true, abuseProtection: "portalLogin" });
    router.get("/api/portal/reservation/:reservationPublicId", async (request) => {
        const reservationPublicId = (0, validation_1.validateReservationPublicId)(request.pathParams);
        return (0, portalPages_1.handlePortalReservation)(reservationPublicId, request, config);
    }, { abuseProtection: "portalRead" });
    router.post("/api/portal/reservation/:reservationPublicId/help-request", async (request) => {
        const reservationPublicId = (0, validation_1.validateReservationPublicId)(request.pathParams);
        const body = (0, validation_1.validatePortalMessage)(request.body);
        return (0, portalPages_1.handlePortalHelpRequest)(reservationPublicId, body, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "portalWrite" });
    router.post("/api/portal/reservation/:reservationPublicId/cancellation-request", async (request) => {
        const reservationPublicId = (0, validation_1.validateReservationPublicId)(request.pathParams);
        const body = (0, validation_1.validateCancellationRequest)(request.body);
        return (0, portalPages_1.handlePortalCancellationRequest)(reservationPublicId, body, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "portalWrite" });
    router.post("/api/portal/reservation/:reservationPublicId/cancel", async (request) => {
        const reservationPublicId = (0, validation_1.validateReservationPublicId)(request.pathParams);
        const body = (0, validation_1.validateCancellationRequest)(request.body);
        return (0, portalPages_1.handlePortalCancelBooking)(reservationPublicId, body, request, config);
    }, { requireJsonBody: true, requireIdempotencyKey: true, abuseProtection: "portalWrite" });
    router.put("/api/portal/reservation/:reservationPublicId/guests", async (request) => {
        const reservationPublicId = (0, validation_1.validateReservationPublicId)(request.pathParams);
        const body = (0, validation_1.validateGuestUpdateRequest)(request.body);
        return (0, portalPages_1.handlePortalGuestUpdate)(reservationPublicId, body, request, config);
    }, { requireJsonBody: true, abuseProtection: "portalWrite" });
    return router;
}
function healthHandler(request) {
    return (0, response_1.jsonResponse)(200, {
        status: "ok",
        service: "booking-api",
        correlationId: request.correlationId,
    }, request.responseHeaders);
}
function assertPayPalWebhookHeaders(request) {
    const certUrl = (0, request_1.getHeader)(request.headers, "paypal-cert-url");
    const requiredHeaders = [
        "paypal-auth-algo",
        "paypal-cert-url",
        "paypal-transmission-id",
        "paypal-transmission-sig",
        "paypal-transmission-time",
    ];
    const missing = requiredHeaders.filter((header) => !(0, request_1.getHeader)(request.headers, header));
    if (missing.length > 0) {
        throw new errors_1.ApiError(400, "invalid_webhook_headers", "PayPal webhook verification headers are required.", {
            fieldErrors: {
                headers: missing.map((header) => `${header}_required`),
            },
        });
    }
    if (!certUrl) {
        return;
    }
    let parsed;
    try {
        parsed = new URL(certUrl);
    }
    catch {
        throw new errors_1.ApiError(400, "invalid_webhook_headers", "PayPal cert URL is invalid.");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || (hostname !== "paypal.com" && !hostname.endsWith(".paypal.com"))) {
        throw new errors_1.ApiError(400, "invalid_webhook_headers", "PayPal cert URL host is not allowed.");
    }
}
