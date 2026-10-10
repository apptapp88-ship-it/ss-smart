"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYPAL_WEBHOOK_MAX_AGE_MS = exports.InMemoryWebhookEventRepository = exports.RdsWebhookEventRepository = void 0;
exports.isPayPalTransmissionTimeValid = isPayPalTransmissionTimeValid;
exports.verifyPayPalWebhookSignature = verifyPayPalWebhookSignature;
exports.handlePayPalWebhook = handlePayPalWebhook;
exports.getWebhookEventRepository = getWebhookEventRepository;
const crypto_1 = require("crypto");
const email_1 = require("./email");
const errors_1 = require("./http/errors");
const serverConversions_1 = require("./serverConversions");
const request_1 = require("./http/request");
const response_1 = require("./http/response");
const propertyCatalog_1 = require("./propertyCatalog");
const paypalClient_1 = require("./paypalClient");
const paypalOrders_1 = require("./paypalOrders");
const smoobuPromotion_1 = require("./smoobuPromotion");
const WEBHOOK_EVENT_COLUMNS = `
  id,
  provider,
  external_event_id,
  dedupe_key,
  event_type,
  received_at,
  processed_at,
  processing_status,
  payload_hash
`;
class RdsWebhookEventRepository {
    constructor(pool) {
        this.pool = pool;
    }
    async insertIfNew(input) {
        const payload = input.payload === undefined ? {} : input.payload;
        const result = await this.pool.query(`
        insert into webhook_events (
          provider,
          external_event_id,
          dedupe_key,
          event_type,
          payload_hash,
          payload,
          processing_status,
          received_at,
          updated_at
        )
        values ($1, $2, $2, $3, $4, $5::jsonb, 'pending', now(), now())
        on conflict do nothing
        returning ${WEBHOOK_EVENT_COLUMNS}
      `, [
            input.provider,
            input.externalEventId,
            input.eventType,
            input.payloadHash,
            JSON.stringify(payload),
        ]);
        if (result.rows[0]) {
            return { inserted: true, record: mapWebhookEventRow(result.rows[0]) };
        }
        const existing = await this.pool.query(`
        select ${WEBHOOK_EVENT_COLUMNS}
        from webhook_events
        where provider = $1
          and (external_event_id = $2 or dedupe_key = $2)
        limit 1
      `, [input.provider, input.externalEventId]);
        if (!existing.rows[0]) {
            throw new Error(`Webhook event ${input.provider}:${input.externalEventId} conflicted but was not found.`);
        }
        return { inserted: false, record: mapWebhookEventRow(existing.rows[0]) };
    }
    async markProcessed(provider, externalEventId, status) {
        await this.pool.query(`
        update webhook_events
        set
          processing_status = $3,
          processed_at = now(),
          updated_at = now()
        where provider = $1
          and (external_event_id = $2 or dedupe_key = $2)
      `, [provider, externalEventId, status]);
    }
}
exports.RdsWebhookEventRepository = RdsWebhookEventRepository;
class InMemoryWebhookEventRepository {
    constructor() {
        this.records = new Map();
    }
    async insertIfNew(input) {
        const dedupeKey = `${input.provider}:${input.externalEventId}`;
        const existing = this.records.get(dedupeKey);
        if (existing) {
            return { inserted: false, record: existing };
        }
        const record = {
            id: (0, crypto_1.randomUUID)(),
            provider: input.provider,
            externalEventId: input.externalEventId,
            eventType: input.eventType,
            receivedAt: new Date().toISOString(),
            status: "pending",
            payloadHash: input.payloadHash,
        };
        this.records.set(dedupeKey, record);
        return { inserted: true, record };
    }
    async markProcessed(provider, externalEventId, status) {
        const key = `${provider}:${externalEventId}`;
        const existing = this.records.get(key);
        if (existing) {
            this.records.set(key, {
                ...existing,
                status,
                processedAt: new Date().toISOString(),
            });
        }
    }
}
exports.InMemoryWebhookEventRepository = InMemoryWebhookEventRepository;
// ─── Replay protection ────────────────────────────────────────────────────────
/**
 * Maximum age (in milliseconds) of a PayPal webhook transmission timestamp
 * used to detect clock-skew anomalies.
 *
 * PayPal retries failed webhook deliveries for up to 3 days, and each retry
 * carries the *original* transmission-time. A 4-day window therefore accepts
 * all legitimate retries while still flagging timestamps that are clearly
 * anomalous (e.g. replayed events from months ago).
 *
 * Note: primary replay protection is the deduplication store (insertIfNew).
 * This check is a secondary defence against grossly out-of-range timestamps.
 */
exports.PAYPAL_WEBHOOK_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000; // 4 days
/**
 * Returns true if the paypal-transmission-time header is within the allowed
 * window relative to `nowMs`.
 */
function isPayPalTransmissionTimeValid(transmissionTime, nowMs = Date.now()) {
    if (!transmissionTime) {
        return false;
    }
    const eventMs = new Date(transmissionTime).getTime();
    if (Number.isNaN(eventMs)) {
        return false;
    }
    return Math.abs(nowMs - eventMs) <= exports.PAYPAL_WEBHOOK_MAX_AGE_MS;
}
// ─── Signature verification ───────────────────────────────────────────────────
/**
 * Verifies a PayPal webhook signature using the postback (online) method.
 * Calls PayPal's POST /v1/notifications/verify-webhook-signature endpoint.
 *
 * Returns:
 *  - "valid"     — signature verified successfully
 *  - "invalid"   — PayPal returned FAILURE (forged or tampered webhook)
 *  - "error"     — transient provider error (network, 5xx); caller should 503
 */
async function verifyPayPalWebhookSignature(request, config, webhookId) {
    const authAlgo = (0, request_1.getHeader)(request.headers, "paypal-auth-algo");
    const certUrl = (0, request_1.getHeader)(request.headers, "paypal-cert-url");
    const transmissionId = (0, request_1.getHeader)(request.headers, "paypal-transmission-id");
    const transmissionSig = (0, request_1.getHeader)(request.headers, "paypal-transmission-sig");
    const transmissionTime = (0, request_1.getHeader)(request.headers, "paypal-transmission-time");
    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
        return "invalid";
    }
    let parsedEvent;
    try {
        parsedEvent = JSON.parse(request.rawBody);
    }
    catch {
        return "invalid";
    }
    const verifyPayload = {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: parsedEvent,
    };
    const paypalClient = await (0, paypalClient_1.createPayPalClient)(config);
    try {
        // PayPalClient.verifyWebhookSignature already records the provider call metric
        const result = await paypalClient.verifyWebhookSignature(verifyPayload, request.observability);
        return result.verification_status === "SUCCESS" ? "valid" : "invalid";
    }
    catch (error) {
        // Provider error (network timeout, 5xx) — distinguish from a forged webhook
        request.observability.recordSecurityEvent({
            name: "paypal_webhook_verify_provider_error",
            severity: "error",
            route: "/api/webhooks/paypal",
            provider: "paypal",
            errorCode: error instanceof errors_1.ApiError ? error.code : "unknown_error",
        });
        return "error";
    }
}
// ─── POST /api/webhooks/paypal ────────────────────────────────────────────────
async function handlePayPalWebhook(request, config) {
    const { paypalWebhookId } = await config.secrets.getSecrets();
    // 1. Verify signature
    //    - "valid"   → proceed
    //    - "invalid" → reject with 400 (security event)
    //    - "error"   → reject with 503 so PayPal retries (transient provider failure)
    const signatureResult = await verifyPayPalWebhookSignature(request, config, paypalWebhookId);
    if (signatureResult === "error") {
        // Transient failure talking to PayPal's verify API — return 503 so PayPal retries
        throw new errors_1.ApiError(503, "webhook_verify_unavailable", "PayPal signature verification service is temporarily unavailable.", {
            retryable: true,
        });
    }
    if (signatureResult === "invalid") {
        request.observability.recordSecurityEvent({
            name: "paypal_webhook_invalid_signature",
            severity: "warn",
            route: "/api/webhooks/paypal",
            provider: "paypal",
        });
        throw new errors_1.ApiError(400, "webhook_signature_invalid", "PayPal webhook signature verification failed.");
    }
    // 2. Replay protection — reject events with a transmission-time outside the
    //    allowed window. Legitimate PayPal retries carry the *original*
    //    transmission-time; a 4-day window covers all retry scenarios while
    //    flagging clearly anomalous timestamps (e.g. months-old replays).
    //    Primary replay protection is the deduplication store (step 4).
    //    Return 200 so PayPal does not keep retrying a stale-but-verified event.
    if (!isPayPalTransmissionTimeValid((0, request_1.getHeader)(request.headers, "paypal-transmission-time"))) {
        request.observability.recordSecurityEvent({
            name: "paypal_webhook_replay_rejected",
            severity: "warn",
            route: "/api/webhooks/paypal",
            provider: "paypal",
        });
        return (0, response_1.jsonResponse)(200, { received: true, stale: true }, request.responseHeaders);
    }
    // 3. Parse event
    let event;
    try {
        event = JSON.parse(request.rawBody);
    }
    catch {
        throw new errors_1.ApiError(400, "invalid_json", "Webhook body is not valid JSON.");
    }
    const externalEventId = event.id;
    const eventType = event.event_type;
    if (!externalEventId || !eventType) {
        throw new errors_1.ApiError(400, "invalid_webhook_payload", "Webhook event is missing id or event_type.");
    }
    // 4. Dedupe — idempotent insert
    const webhookEvents = getWebhookEventRepository(config);
    const payloadHash = sha256(request.rawBody);
    const { inserted, record } = await webhookEvents.insertIfNew({
        provider: "paypal",
        externalEventId,
        eventType,
        payloadHash,
        payload: event,
    });
    // Only treat a redelivery as a duplicate once it has actually been *processed*.
    // If a prior delivery inserted the row but crashed before markProcessed, the
    // status is still 'pending'/'failed' and we must reprocess — otherwise a missed
    // capture confirmation would be silently swallowed (R8). Downstream transitions
    // are all CAS-guarded, so reprocessing an already-applied event is a no-op.
    if (!inserted && record.status === "processed") {
        request.observability.recordStateTransition({
            entityType: "webhook_event",
            toState: "duplicate",
            action: `paypal.webhook.${eventType}`,
            success: true,
            provider: "paypal",
            providerObjectId: externalEventId,
        });
        return (0, response_1.jsonResponse)(200, { received: true, duplicate: true }, request.responseHeaders);
    }
    // 5. Apply state transitions
    try {
        await applyPayPalWebhookEvent(event, config, request);
        await webhookEvents.markProcessed("paypal", externalEventId, "processed");
    }
    catch (error) {
        await webhookEvents.markProcessed("paypal", externalEventId, "failed");
        throw error;
    }
    return (0, response_1.jsonResponse)(200, { received: true }, request.responseHeaders);
}
// ─── State machine transitions ────────────────────────────────────────────────
async function applyPayPalWebhookEvent(event, config, request) {
    const eventType = event.event_type ?? "";
    switch (eventType) {
        case "PAYMENT.CAPTURE.COMPLETED":
            await handleCaptureCompleted(event, config, request);
            break;
        case "PAYMENT.CAPTURE.DENIED":
        case "PAYMENT.CAPTURE.REVERSED":
            await handleCaptureFailed(event, config, request, eventType);
            break;
        case "CHECKOUT.ORDER.APPROVED":
            // Buyer approved the order — no state change needed; capture is triggered by the
            // frontend calling POST /api/paypal/capture. Log for observability only.
            request.observability.recordStateTransition({
                entityType: "webhook_event",
                toState: "ignored",
                action: `paypal.webhook.${eventType}`,
                success: true,
                provider: "paypal",
                providerObjectId: event.id,
            });
            break;
        default:
            // Unknown event type — acknowledge and ignore
            request.observability.recordStateTransition({
                entityType: "webhook_event",
                toState: "ignored",
                action: `paypal.webhook.${eventType}`,
                success: true,
                provider: "paypal",
                providerObjectId: event.id,
            });
            break;
    }
}
// PAYPAL webhook `resource` shapes differ by event type. ORDER-shaped
// resources (e.g. CHECKOUT.ORDER.APPROVED) carry purchase_units, where
// reference_id is the internal bookingSessionId and custom_id is nested one
// level down. CAPTURE-shaped resources (e.g. PAYMENT.CAPTURE.COMPLETED) have
// no purchase_units at all — custom_id sits directly on the resource, and it
// carries the reservationPublicId (KWL-XXXXXXXX), not the bookingSessionId.
// Real PayPal payloads confirmed this during the live-acceptance-test.md pass;
// the existing mocks only exercised the ORDER shape, so this was invisible to
// every unit test.
async function resolveSessionFromWebhookResource(event, sessions) {
    const bookingSessionId = event.resource?.purchase_units?.[0]?.reference_id;
    if (bookingSessionId) {
        const session = await sessions.getById(bookingSessionId);
        if (session) {
            return session;
        }
    }
    const reservationPublicId = event.resource?.purchase_units?.[0]?.custom_id ?? event.resource?.custom_id;
    if (reservationPublicId) {
        return sessions.getByReservationPublicId(reservationPublicId);
    }
    return undefined;
}
async function handleCaptureCompleted(event, config, request) {
    const capture = event.resource?.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = capture?.id ?? event.resource?.id;
    if (!captureId) {
        request.observability.recordStateTransition({
            entityType: "webhook_event",
            toState: "ignored",
            action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
            success: false,
            provider: "paypal",
            errorCode: "missing_capture_id_or_session_id",
        });
        return;
    }
    const sessions = config.bookingSessions;
    if (!sessions) {
        throw new errors_1.ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
    }
    const payments = getPaymentRepository(config);
    const session = await resolveSessionFromWebhookResource(event, sessions);
    if (!session) {
        request.observability.recordStateTransition({
            entityType: "webhook_event",
            toState: "ignored",
            action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
            success: false,
            provider: "paypal",
            errorCode: "session_not_found",
        });
        return;
    }
    // Already confirmed — idempotent
    if (session.status === "booking_confirmed") {
        request.observability.recordStateTransition({
            entityType: "booking_session",
            fromState: "booking_confirmed",
            toState: "booking_confirmed",
            action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
            success: true,
            bookingSessionId: session.id,
            reservationPublicId: session.reservationPublicId,
            provider: "paypal",
            providerObjectId: captureId,
        });
        return;
    }
    // Only transition from paypal_order_created
    if (session.status !== "paypal_order_created") {
        request.observability.recordStateTransition({
            entityType: "webhook_event",
            toState: "ignored",
            action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
            success: false,
            bookingSessionId: session.id,
            provider: "paypal",
            errorCode: `unexpected_session_status_${session.status}`,
        });
        return;
    }
    const confirmedAt = new Date().toISOString();
    await payments.markCaptured({
        bookingSessionId: session.id,
        paypalCaptureId: captureId,
        capturedAt: confirmedAt,
    });
    const confirmedSession = await sessions.markBookingConfirmed({
        bookingSessionId: session.id,
        confirmedAt,
    });
    await (0, serverConversions_1.reportServerConversion)("purchase", confirmedSession, config.serverConversions, request.observability.logger);
    request.observability.recordStateTransition({
        entityType: "booking_session",
        fromState: "paypal_order_created",
        toState: "booking_confirmed",
        action: "paypal.webhook.PAYMENT.CAPTURE.COMPLETED",
        success: true,
        bookingSessionId: session.id,
        reservationPublicId: session.reservationPublicId,
        provider: "paypal",
        providerObjectId: captureId,
    });
    // Promote the Smoobu reservation from Blocked channel to Direct booking.
    // Non-fatal: must not affect webhook 2xx response.
    try {
        const holds = getHoldRepository(config);
        if (holds) {
            const hold = await holds.getByBookingSessionId(session.id).catch(() => undefined);
            if (hold) {
                // Take the hold out of the expiry sweep's reach before promotion (R1).
                const confirmedHold = await holds.markHoldConfirmed(hold.id).catch(() => hold);
                if (confirmedHold.status !== "converted") {
                    request.observability.logger.error("booking_confirmed_hold_already_expired", {
                        bookingSessionId: session.id,
                        holdId: hold.id,
                        holdStatus: confirmedHold.status,
                    });
                }
                // Extract amount from webhook event; fall back to session totalAmountCents
                const captureAmount = capture?.amount?.value
                    ? Math.round(parseFloat(capture.amount.value) * 100)
                    : session.totalAmountCents ?? 0;
                await (0, smoobuPromotion_1.promoteSmoobuReservation)({
                    session,
                    hold: confirmedHold,
                    notice: (0, paypalOrders_1.buildPaypalConfirmedNotice)(session, captureId, confirmedAt),
                    amountCents: captureAmount,
                }, holds, config, request.observability);
            }
        }
    }
    catch (promoError) {
        request.observability.logger.warn("smoobu_promotion_webhook_error", {
            bookingSessionId: session.id,
            error: promoError instanceof Error ? promoError.message : String(promoError),
        });
    }
    // Send booking_confirmed email — non-fatal; must not affect webhook 2xx response
    try {
        const property = propertyCatalog_1.BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
        const emailClient = (0, email_1.createEmailClient)(config.email, request.observability.logger);
        await emailClient.sendBookingConfirmed({ ...session, confirmedAt, status: "booking_confirmed" }, property?.name ?? session.propertyId ?? "", captureId);
    }
    catch (emailError) {
        request.observability.logger.error("booking_confirmed_email_failed", {
            bookingSessionId: session.id,
            error: emailError instanceof Error ? emailError.message : String(emailError),
        });
    }
}
async function handleCaptureFailed(event, config, request, eventType) {
    const sessions = config.bookingSessions;
    if (!sessions) {
        throw new errors_1.ApiError(503, "database_unavailable", "Booking storage is not configured.", { retryable: true });
    }
    const payments = getPaymentRepository(config);
    const session = await resolveSessionFromWebhookResource(event, sessions);
    if (!session) {
        request.observability.recordStateTransition({
            entityType: "webhook_event",
            toState: "ignored",
            action: `paypal.webhook.${eventType}`,
            success: false,
            provider: "paypal",
            errorCode: "missing_session_id",
        });
        return;
    }
    // Already in a terminal state — skip
    if (session.status === "booking_confirmed" || session.status === "failed") {
        return;
    }
    await payments.markFailed(session.id);
    await sessions.markFailed({ bookingSessionId: session.id, reason: eventType.toLowerCase() });
    request.observability.recordStateTransition({
        entityType: "booking_session",
        fromState: session.status,
        toState: "failed",
        action: `paypal.webhook.${eventType}`,
        success: true,
        bookingSessionId: session.id,
        reservationPublicId: session.reservationPublicId,
        provider: "paypal",
        providerObjectId: event.resource?.id,
    });
}
// ─── Repository accessors ─────────────────────────────────────────────────────
function getWebhookEventRepository(config) {
    if (!config.webhookEvents) {
        throw new errors_1.ApiError(503, "database_unavailable", "Webhook event storage is not configured.", {
            retryable: true,
        });
    }
    return config.webhookEvents;
}
function getBookingSessionRepository(config) {
    if (!config.bookingSessions) {
        throw new errors_1.ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
            retryable: true,
        });
    }
    return config.bookingSessions;
}
function getPaymentRepository(config) {
    if (!config.payments) {
        throw new errors_1.ApiError(503, "database_unavailable", "Payment storage is not configured.", {
            retryable: true,
        });
    }
    return config.payments;
}
function getHoldRepository(config) {
    return config.holds ?? undefined;
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function sha256(input) {
    return (0, crypto_1.createHash)("sha256").update(input).digest("hex");
}
function mapWebhookEventRow(row) {
    return {
        id: row.id,
        provider: row.provider,
        externalEventId: row.external_event_id ?? row.dedupe_key,
        eventType: row.event_type,
        receivedAt: toIsoString(row.received_at),
        ...(row.processed_at ? { processedAt: toIsoString(row.processed_at) } : {}),
        status: parseWebhookEventStatus(row.processing_status),
        payloadHash: row.payload_hash,
    };
}
function parseWebhookEventStatus(status) {
    if (status === "pending" ||
        status === "processed" ||
        status === "duplicate" ||
        status === "ignored" ||
        status === "failed") {
        return status;
    }
    if (status === "received" || status === "verified" || status === "processing") {
        return "pending";
    }
    if (status === "rejected_signature") {
        return "failed";
    }
    throw new Error(`Unsupported webhook processing status from database: ${status}`);
}
function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    const timestampMs = Date.parse(value);
    return Number.isNaN(timestampMs) ? value : new Date(timestampMs).toISOString();
}
