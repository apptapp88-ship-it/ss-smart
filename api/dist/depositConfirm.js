"use strict";
/**
 * depositConfirm.ts — staff review of a manual deposit booking.
 *
 *   GET  /api/staff/deposit-review/:token   renders a review page
 *   POST /api/staff/deposit-review          performs the action
 *
 * The GET deliberately does not mutate. Email clients and security appliances
 * (Gmail's image proxy, Outlook Safe Links, corporate scanners) fetch links in
 * messages without a human involved, so putting the confirmation on the GET
 * would let a scanner confirm bookings and take payment out of staff's hands.
 * The page is a single screen with one button, so it is still one click.
 *
 * Access is by signed token alone — there is no staff login anywhere in this
 * system. The token is scoped to one booking session and one action, expires,
 * and its jti is recorded when spent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleStaffDepositReviewPage = handleStaffDepositReviewPage;
exports.handleStaffDepositReviewSubmit = handleStaffDepositReviewSubmit;
const branding_1 = require("./branding");
const email_1 = require("./email");
const serverConversions_1 = require("./serverConversions");
const errors_1 = require("./http/errors");
const response_1 = require("./http/response");
const depositReceipt_1 = require("./depositReceipt");
const propertyCatalog_1 = require("./propertyCatalog");
const smoobuClient_1 = require("./smoobuClient");
const smoobuPromotion_1 = require("./smoobuPromotion");
const signedTokens_1 = require("./signedTokens");
async function handleStaffDepositReviewPage(token, request, config) {
    const { payload, session } = await resolveToken(token, request, config);
    const property = propertyCatalog_1.BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
    let receiptUrl;
    if (session.depositReceiptS3Key && config.s3Upload) {
        receiptUrl = await (0, depositReceipt_1.presignReceiptDownload)(config.s3Upload, session.depositReceiptS3Key).catch(() => undefined);
    }
    if (session.status === "booking_confirmed") {
        return (0, response_1.htmlResponse)(200, renderPage({
            heading: "Already confirmed",
            body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> was confirmed on ${escapeHtml(session.confirmedAt ?? "an earlier date")}. Nothing further to do.</p>`,
        }), request.responseHeaders);
    }
    if (session.status === "cancelled" || session.status === "hold_expired" || session.status === "failed") {
        return (0, response_1.htmlResponse)(200, renderPage({
            heading: "No longer actionable",
            body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is <strong>${escapeHtml(session.status)}</strong>. The dates have already been released.</p>`,
        }), request.responseHeaders);
    }
    const isReject = payload.act === "deposit_reject";
    // The form action is relative ("../deposit-review"), not root-relative. This page is served
    // at .../api/staff/deposit-review/{token} behind an API Gateway stage prefix (e.g. /prod)
    // that this Lambda never sees but the browser does. A root-relative "/api/staff/deposit-review"
    // drops that prefix and 403s at the gateway ("Missing Authentication Token"); the relative form
    // resolves against the page's own URL and lands on the sibling POST route either way.
    return (0, response_1.htmlResponse)(200, renderPage({
        heading: isReject ? "Reject deposit booking" : "Confirm deposit booking",
        body: `
${renderSummary(session, property?.name, receiptUrl)}
<form method="POST" action="../deposit-review">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <button type="submit" class="${isReject ? "danger" : "primary"}">
    ${isReject ? "Reject and release the dates" : "Confirm — the money has arrived"}
  </button>
</form>
<p class="note">${isReject
            ? "This cancels the Smoobu reservation and puts the dates back on sale."
            : "This confirms the booking and emails the guest their portal access."}</p>`,
    }), request.responseHeaders);
}
async function handleStaffDepositReviewSubmit(token, request, config) {
    const { payload, session } = await resolveToken(token, request, config);
    const property = propertyCatalog_1.BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
    const propertyName = property?.name ?? session.propertyId ?? "";
    const sessions = requireRepository(config.bookingSessions, "Booking session storage");
    const holds = requireRepository(config.holds, "Hold storage");
    // Idempotent by status guard: a second click lands here and reports the
    // existing state rather than acting twice.
    if (session.status === "booking_confirmed") {
        return (0, response_1.htmlResponse)(200, renderPage({
            heading: "Already confirmed",
            body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is already confirmed.</p>`,
        }), request.responseHeaders);
    }
    if (session.status !== "hold_active") {
        return (0, response_1.htmlResponse)(409, renderPage({
            heading: "No longer actionable",
            body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is <strong>${escapeHtml(session.status)}</strong> and can no longer be actioned.</p>`,
        }), request.responseHeaders);
    }
    const hold = await holds.getByBookingSessionId(session.id);
    if (payload.act === "deposit_reject") {
        // Guard the destructive Smoobu cancel behind a local compare-and-swap FIRST.
        // markStaffRejected only fires from hold_active, so if a guest's deposit was
        // confirmed concurrently (between resolveToken's read and now) this returns
        // undefined and we abort WITHOUT releasing the reservation — otherwise a late
        // reject would cancel a paid booking and put its dates back on sale (R6).
        const rejectedSession = await sessions.markStaffRejected({
            bookingSessionId: session.id,
            reason: "deposit_not_received",
            cancelledAt: new Date().toISOString(),
        });
        if (!rejectedSession) {
            const current = (await sessions.getById(session.id)) ?? session;
            return (0, response_1.htmlResponse)(current.status === "booking_confirmed" ? 200 : 409, renderPage({
                heading: current.status === "booking_confirmed" ? "Already confirmed" : "No longer actionable",
                body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is <strong>${escapeHtml(current.status)}</strong> and can no longer be rejected.</p>`,
            }), request.responseHeaders);
        }
        if (hold?.smoobuReservationId) {
            try {
                const smoobuClient = await (0, smoobuClient_1.createSmoobuClient)(config);
                await smoobuClient.cancelReservation(hold.smoobuReservationId, request.observability);
            }
            catch (error) {
                if (!(error instanceof smoobuClient_1.SmoobuProviderError && error.providerStatusCode === 404)) {
                    throw new errors_1.ApiError(502, "provider_error", "Could not release the reservation in Smoobu. Please try again.");
                }
            }
        }
        if (hold) {
            await holds.cancelHold(hold.id);
        }
        request.observability.recordStateTransition({
            entityType: "booking_session",
            fromState: "hold_active",
            toState: "cancelled",
            action: "staff.deposit_reject",
            success: true,
            bookingSessionId: session.id,
            reservationPublicId: session.reservationPublicId,
        });
        request.observability.recordSecurityEvent({
            name: "staff_deposit_rejected",
            severity: "info",
            route: "/api/staff/deposit-review",
            bookingSessionId: session.id,
        });
        return (0, response_1.htmlResponse)(200, renderPage({
            heading: "Rejected",
            body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> was rejected and the dates are back on sale.</p>`,
        }), request.responseHeaders);
    }
    const confirmedAt = new Date().toISOString();
    const confirmedSession = await sessions.markDepositConfirmed({
        bookingSessionId: session.id,
        confirmedAt,
        confirmedBy: "staff_link",
        tokenJti: payload.jti,
    });
    // Move the hold to `converted` immediately, taking it out of the expiry
    // worker's reach: listExpiredHolds sweeps creating|active holds past
    // expires_at, so a confirmed booking left `active` would have its Smoobu
    // reservation cancelled at the TTL. This runs synchronously and reliably,
    // *before* the best-effort Smoobu promotion below (R1).
    if (hold) {
        const confirmedHold = await holds.markHoldConfirmed(hold.id).catch(() => hold);
        if (confirmedHold.status !== "converted") {
            request.observability.logger.error("booking_confirmed_hold_already_expired", {
                bookingSessionId: session.id,
                holdId: hold.id,
                holdStatus: confirmedHold.status,
            });
        }
        // Promote the Smoobu reservation from Blocked channel to Homepage (website) —
        // the same mechanism PayPal captures use, see smoobuPromotion.ts.
        await (0, smoobuPromotion_1.promoteSmoobuReservation)({
            session: confirmedSession,
            hold: confirmedHold,
            notice: `${branding_1.SITE_NAME} manual deposit CONFIRMED by staff on ${confirmedAt}. Reservation ${session.reservationPublicId}.`,
            amountCents: confirmedSession.totalAmountCents ?? 0,
        }, holds, config, request.observability).catch((err) => {
            request.observability.logger.warn("deposit_confirm_smoobu_promotion_unexpected_error", {
                bookingSessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }
    request.observability.recordStateTransition({
        entityType: "booking_session",
        fromState: "hold_active",
        toState: "booking_confirmed",
        action: "staff.deposit_confirm",
        success: true,
        bookingSessionId: session.id,
        reservationPublicId: session.reservationPublicId,
    });
    request.observability.recordSecurityEvent({
        name: "staff_deposit_confirmed",
        severity: "info",
        route: "/api/staff/deposit-review",
        bookingSessionId: session.id,
    });
    // The only place a manual-deposit sale can ever be reported: the guest's
    // browser is long gone by the time staff confirm the transfer.
    await (0, serverConversions_1.reportServerConversion)("purchase", confirmedSession, config.serverConversions, request.observability.logger);
    try {
        const emailClient = (0, email_1.createEmailClient)(config.email, request.observability.logger);
        await emailClient.sendDepositConfirmed(confirmedSession, propertyName);
    }
    catch (error) {
        request.observability.logger.error("deposit_confirmed_email_failed", {
            bookingSessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return (0, response_1.htmlResponse)(200, renderPage({
        heading: "Confirmed",
        body: `<p>Reservation <strong>${escapeHtml(session.reservationPublicId)}</strong> is confirmed. The guest has been emailed their portal access.</p>`,
    }), request.responseHeaders);
}
async function resolveToken(token, request, config) {
    const { portalSessionSecret } = await config.secrets.getSecrets();
    const payload = (0, signedTokens_1.verifySignedToken)(token, portalSessionSecret, ["deposit_confirm", "deposit_reject"]);
    const sessions = requireRepository(config.bookingSessions, "Booking session storage");
    const session = await sessions.getById(payload.sub);
    if (!session || session.reservationPublicId !== payload.rid) {
        throw new errors_1.ApiError(404, "not_found", "That booking could not be found.");
    }
    request.observability.recordSecurityEvent({
        name: "staff_deposit_link_used",
        severity: "info",
        route: "/api/staff/deposit-review",
        bookingSessionId: session.id,
    });
    return { payload, session };
}
function requireRepository(repository, label) {
    if (!repository) {
        throw new errors_1.ApiError(503, "database_unavailable", `${label} is not configured.`, { retryable: true });
    }
    return repository;
}
function renderSummary(session, propertyName, receiptUrl) {
    const rows = [
        ["Reservation", session.reservationPublicId],
        ["Property", propertyName ?? "—"],
        ["Arrival", session.arrivalDate],
        ["Departure", session.departureDate],
        ["Guests", String(session.guests)],
        ["Total", session.totalAmountCents !== undefined && session.currency ? `${session.currency} ${(session.totalAmountCents / 100).toFixed(2)}` : "—"],
        ["Guest", session.guest ? `${session.guest.firstName} ${session.guest.lastName} · ${session.guest.email}` : "—"],
        ["Hold expires", session.expiresAt ?? "—"],
    ];
    const rowsHtml = rows
        .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
        .join("\n");
    const receiptHtml = receiptUrl
        ? `<p><a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noopener noreferrer">View uploaded receipt</a></p>`
        : `<p class="note">No receipt uploaded yet.</p>`;
    return `<table>${rowsHtml}</table>${receiptHtml}`;
}
function renderPage(input) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(input.heading)} · ${branding_1.SITE_NAME}</title>
<style>
  body { margin:0; padding:32px 16px; background:#f5f5f5; font-family:system-ui,-apple-system,'Segoe UI',sans-serif; color:#171717; }
  main { max-width:640px; margin:0 auto; background:#fff; border-radius:12px; overflow:hidden; }
  header { background:#0B3028; color:#fff; padding:20px 28px; font-size:20px; font-weight:700; letter-spacing:1px; }
  section { padding:28px; }
  h1 { font-size:22px; margin:0 0 16px; color:#0B3028; }
  table { border-collapse:collapse; width:100%; margin:0 0 20px; }
  th { text-align:left; padding:6px 16px 6px 0; color:#555; font-weight:500; white-space:nowrap; vertical-align:top; }
  td { padding:6px 0; font-weight:600; }
  button { border:0; border-radius:8px; padding:14px 22px; font-size:16px; font-weight:700; color:#fff; cursor:pointer; }
  button.primary { background:#294F44; }
  button.danger { background:#b03a2e; }
  a { color:#294F44; }
  .note { color:#888; font-size:13px; }
</style>
</head>
<body>
<main>
  <header>${branding_1.SITE_NAME}</header>
  <section>
    <h1>${escapeHtml(input.heading)}</h1>
    ${input.body}
  </section>
</main>
</body>
</html>`;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
