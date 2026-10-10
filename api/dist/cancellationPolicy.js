"use strict";
/**
 * cancellationPolicy.ts
 *
 * Single source of truth for whether a guest may cancel their own booking.
 * Imported by both the cancel handler and the portal reservation response, so
 * the button the guest sees and the rule the server enforces can never drift.
 *
 * The policy:
 *   - Non-refundable bookings cannot be self-cancelled at all.
 *   - Flexible bookings can be cancelled up to 24 hours before check-in.
 *   - Inside 24 hours the guest is routed to staff instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANCELLATION_CUTOFF_HOURS = exports.COSTA_RICA_UTC_OFFSET_HOURS = exports.CHECK_IN_HOUR_COSTA_RICA = void 0;
exports.checkInInstantMs = checkInInstantMs;
exports.cancellationDeadlineIso = cancellationDeadlineIso;
exports.evaluateCancellationEligibility = evaluateCancellationEligibility;
exports.availablePortalActions = availablePortalActions;
/**
 * Check-in time, needed because arrival_date is a bare `date` with no time
 * component — without a convention the 24-hour boundary is ambiguous by up to a
 * full day. Costa Rica is UTC-6 year round (no DST since 1992), so 15:00 local
 * is 21:00 UTC with no seasonal adjustment.
 */
exports.CHECK_IN_HOUR_COSTA_RICA = 15;
exports.COSTA_RICA_UTC_OFFSET_HOURS = 6;
exports.CANCELLATION_CUTOFF_HOURS = 24;
/** UTC instant of check-in for a `YYYY-MM-DD` arrival date. */
function checkInInstantMs(arrivalDate) {
    const utcHour = exports.CHECK_IN_HOUR_COSTA_RICA + exports.COSTA_RICA_UTC_OFFSET_HOURS;
    return Date.parse(`${arrivalDate}T${String(utcHour).padStart(2, "0")}:00:00Z`);
}
/** Last instant at which self-service cancellation is still permitted. */
function cancellationDeadlineIso(arrivalDate) {
    const checkInMs = checkInInstantMs(arrivalDate);
    if (!Number.isFinite(checkInMs)) {
        return null;
    }
    return new Date(checkInMs - exports.CANCELLATION_CUTOFF_HOURS * 60 * 60 * 1000).toISOString();
}
function evaluateCancellationEligibility(input) {
    const { session } = input;
    const nowMs = input.nowMs ?? Date.now();
    const deadline = cancellationDeadlineIso(session.arrivalDate);
    // Ordered deliberately: a booking that is already cancelled reports that
    // rather than a window or rate-plan complaint, so a repeat submit reads as
    // "already done" instead of an error.
    if (session.status === "cancelled") {
        return { allowed: false, reason: "already_cancelled", deadline };
    }
    if (session.status !== "booking_confirmed") {
        return { allowed: false, reason: "invalid_booking_state", deadline };
    }
    if (session.ratePlan === "non_refundable") {
        return { allowed: false, reason: "non_refundable_rate", deadline };
    }
    // Rows created before migration 0013 have no rate plan, and there is no signal
    // to infer it from retroactively. Failing closed routes those guests to staff
    // rather than risking a refund on a non-refundable booking.
    if (session.ratePlan !== "flexible") {
        return { allowed: false, reason: "rate_plan_unknown", deadline };
    }
    if (deadline === null) {
        return { allowed: false, reason: "invalid_booking_state", deadline: null };
    }
    if (nowMs >= Date.parse(deadline)) {
        return { allowed: false, reason: "cancellation_window_closed", deadline };
    }
    return { allowed: true, deadline };
}
/**
 * Actions the portal should offer for a reservation. Returned to the frontend so
 * the UI never has to re-derive the policy.
 */
function availablePortalActions(session, nowMs) {
    const actions = ["request_help"];
    if (session.status === "booking_confirmed") {
        actions.push("update_guests");
    }
    if (evaluateCancellationEligibility({ session, ...(nowMs !== undefined ? { nowMs } : {}) }).allowed) {
        actions.push("cancel_booking");
    }
    return actions;
}
