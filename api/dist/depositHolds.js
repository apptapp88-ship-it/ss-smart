"use strict";
/**
 * depositHolds.ts — POST /api/deposit-holds
 *
 * Manual-deposit guests (bank transfer / SINPE) now get a real booking, not a
 * contact handoff: guest details, a portal password, and a Smoobu blocked-channel
 * reservation that takes the dates off sale while the transfer clears.
 *
 * The booking stays `hold_active` until staff confirm the money arrived via the
 * signed link in their notification email. If nobody confirms, the existing
 * hold-expiry worker releases it — deposit holds deliberately reuse the PayPal
 * lifecycle so that worker needs no changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCreateDepositHold = handleCreateDepositHold;
exports.depositHoldTtlMs = depositHoldTtlMs;
exports.buildStaffActionUrl = buildStaffActionUrl;
const branding_1 = require("./branding");
const depositHandoff_1 = require("./depositHandoff");
const email_1 = require("./email");
const errors_1 = require("./http/errors");
const cancellationPolicy_1 = require("./cancellationPolicy");
const holds_1 = require("./holds");
const signedTokens_1 = require("./signedTokens");
const DEPOSIT_HOLD_IDEMPOTENCY_SCOPE = "booking.deposit_hold.create";
/** A deposit access token only needs to outlive the upload step. */
const DEPOSIT_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
async function handleCreateDepositHold(holdRequest, request, config) {
    const deposit = requireDepositConfig(config);
    return (0, holds_1.createSmoobuBackedHold)({
        paymentMethod: "manual_deposit",
        // Deposit bookings honour whichever rate the guest picked — flexible by
        // default, or the non-refundable rate (10% off via the #norefundallowed
        // re-quote) when selected. Previously the deposit path forced flexible, so
        // a guest who chose non-refundable and paid by SINPE silently lost the
        // discount they were shown (#307).
        ratePlan: holdRequest.nonRefundable ? "non_refundable" : "flexible",
        idempotencyScope: DEPOSIT_HOLD_IDEMPOTENCY_SCOPE,
        ttlMsFor: (session) => depositHoldTtlMs(deposit.holdTtlHours, session.arrivalDate),
        noticePrefix: `${branding_1.SITE_NAME} manual deposit hold.`,
        noticeCaveat: "Awaiting bank transfer / SINPE. Not confirmed until staff verify the deposit.",
        allowNonRefundable: true,
        async finalize({ session, property, config: cfg, request: req }) {
            const { portalSessionSecret } = await cfg.secrets.getSecrets();
            // Scoped to this booking session, so the guest can attach a receipt
            // before the booking is confirmed and portal login becomes available.
            const depositAccessToken = (0, signedTokens_1.issueSignedToken)({
                bookingSessionId: session.id,
                reservationPublicId: session.reservationPublicId,
                purpose: "deposit_access",
                ttlSeconds: DEPOSIT_ACCESS_TOKEN_TTL_SECONDS,
            }, portalSessionSecret);
            const bankInfo = (0, depositHandoff_1.buildBankInfo)(cfg, property);
            await sendDepositNotifications({
                session,
                property,
                bankInfo,
                config: cfg,
                request: req,
                portalSessionSecret,
            });
            return {
                payment: { method: "manual_deposit", status: "pending" },
                bankInfo,
                depositAccessToken,
                depositAccessTokenExpiresInSeconds: DEPOSIT_ACCESS_TOKEN_TTL_SECONDS,
                nextAction: "upload_deposit_receipt",
            };
        },
    }, holdRequest, request, config);
}
/**
 * A deposit hold blocks the property on every channel, so a long TTL on a stay
 * that is imminent is a real cost. Never hold past half the time remaining until
 * check-in, and never longer than the configured maximum.
 */
function depositHoldTtlMs(configuredHours, arrivalDate, nowMs = Date.now()) {
    const configuredMs = configuredHours * 60 * 60 * 1000;
    if (!arrivalDate) {
        return configuredMs;
    }
    const msUntilCheckIn = (0, cancellationPolicy_1.checkInInstantMs)(arrivalDate) - nowMs;
    if (!Number.isFinite(msUntilCheckIn) || msUntilCheckIn <= 0) {
        return configuredMs;
    }
    // Floor of one hour so a last-minute booking still has a usable window.
    return Math.max(60 * 60 * 1000, Math.min(configuredMs, Math.floor(msUntilCheckIn / 2)));
}
async function sendDepositNotifications(input) {
    const { session, property, bankInfo, config, request, portalSessionSecret } = input;
    const deposit = requireDepositConfig(config);
    const emailClient = (0, email_1.createEmailClient)(config.email, request.observability.logger);
    // Non-fatal: the hold exists and the dates are blocked. A mail failure must
    // not roll that back, but staff need to know it happened.
    try {
        await emailClient.sendDepositInstructions(session, property.name, bankInfo);
    }
    catch (error) {
        request.observability.logger.error("deposit_instructions_email_failed", {
            bookingSessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    try {
        const confirmUrl = buildStaffActionUrl(deposit.staffConfirmBaseUrl, "confirm", session, portalSessionSecret, deposit.confirmTokenTtlHours);
        const rejectUrl = buildStaffActionUrl(deposit.staffConfirmBaseUrl, "reject", session, portalSessionSecret, deposit.confirmTokenTtlHours);
        await emailClient.sendStaffDepositReview(session, property.name, {
            confirmUrl,
            rejectUrl,
            bankInfo,
        });
    }
    catch (error) {
        request.observability.logger.error("staff_deposit_review_email_failed", {
            bookingSessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
function buildStaffActionUrl(baseUrl, action, session, portalSessionSecret, ttlHours) {
    const token = (0, signedTokens_1.issueSignedToken)({
        bookingSessionId: session.id,
        reservationPublicId: session.reservationPublicId,
        purpose: action === "confirm" ? "deposit_confirm" : "deposit_reject",
        ttlSeconds: ttlHours * 60 * 60,
    }, portalSessionSecret);
    // The token goes in a path segment, not a query string: base64url contains no
    // "/", the router decodes each segment, and it keeps the secret out of query
    // strings that other middleware deliberately rejects.
    return `${baseUrl.replace(/\/+$/, "")}/api/staff/deposit-review/${encodeURIComponent(token)}`;
}
function requireDepositConfig(config) {
    if (!config.deposit) {
        throw new errors_1.ApiError(503, "deposit_not_configured", "Manual deposit bookings are not configured.", {
            retryable: false,
        });
    }
    return config.deposit;
}
