"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processExpiredHolds = processExpiredHolds;
const email_1 = require("./email");
const propertyCatalog_1 = require("./propertyCatalog");
const smoobuClient_1 = require("./smoobuClient");
/**
 * Finds all holds past their `expiresAt` and transitions them to `expired`,
 * cancels the corresponding Smoobu reservation (if one exists), and marks
 * the booking session as `hold_expired`.
 *
 * Designed to run on a schedule (e.g. every 1 minute via EventBridge).
 * Each hold is processed independently so a single failure does not block others.
 */
async function processExpiredHolds(deps) {
    const { holds, bookingSessions, smoobuClient, logger } = deps;
    const now = deps.now?.() ?? new Date().toISOString();
    const result = {
        processed: 0,
        expired: 0,
        smoobuCancelled: 0,
        smoobuCancelFailed: 0,
        sessionUpdateFailed: 0,
        errors: [],
    };
    const expiredHolds = await holds.listExpiredHolds(now);
    result.processed = expiredHolds.length;
    if (expiredHolds.length === 0) {
        logger.debug("hold_expiry_sweep_empty", { now });
        return result;
    }
    logger.info("hold_expiry_sweep_started", { count: expiredHolds.length, now });
    for (const hold of expiredHolds) {
        await processOneHold(hold, deps, result);
    }
    logger.info("hold_expiry_sweep_completed", {
        processed: result.processed,
        expired: result.expired,
        smoobuCancelled: result.smoobuCancelled,
        smoobuCancelFailed: result.smoobuCancelFailed,
        sessionUpdateFailed: result.sessionUpdateFailed,
        errorCount: result.errors.length,
    });
    return result;
}
async function processOneHold(hold, deps, result) {
    const { holds, bookingSessions, smoobuClient, logger } = deps;
    // 0. Never expire — and never cancel the Smoobu reservation of — a booking that
    // has already been confirmed/paid. The RDS `listExpiredHolds` already excludes
    // these via a join, but the in-memory repo cannot, and a confirmation may have
    // landed between the sweep's claim and now. The session status is authoritative.
    const guardSession = await bookingSessions.getById(hold.bookingSessionId).catch(() => undefined);
    if (guardSession?.status === "booking_confirmed") {
        logger.info("hold_expiry_skipped_confirmed", {
            holdId: hold.id,
            bookingSessionId: hold.bookingSessionId,
        });
        return;
    }
    // 1. Mark hold as expired in DB
    try {
        await holds.expireHold(hold.id);
        result.expired += 1;
    }
    catch (error) {
        const errMsg = error instanceof Error ? error.message : "unknown";
        logger.error("hold_expiry_db_failed", {
            holdId: hold.id,
            bookingSessionId: hold.bookingSessionId,
            error: errMsg,
        });
        result.errors.push({
            holdId: hold.id,
            bookingSessionId: hold.bookingSessionId,
            phase: "expire_hold",
            errorCode: "db_update_failed",
            message: errMsg,
        });
        // Don't proceed if we can't even mark the hold expired
        return;
    }
    // 2. Cancel Smoobu reservation if one was created
    if (hold.smoobuReservationId) {
        try {
            await smoobuClient.cancelReservation(hold.smoobuReservationId);
            result.smoobuCancelled += 1;
            logger.info("hold_expiry_smoobu_cancelled", {
                holdId: hold.id,
                smoobuReservationId: hold.smoobuReservationId,
            });
        }
        catch (error) {
            result.smoobuCancelFailed += 1;
            const errCode = error instanceof smoobuClient_1.SmoobuProviderError ? error.code : "unknown";
            const errMsg = error instanceof Error ? error.message : "unknown";
            logger.error("hold_expiry_smoobu_cancel_failed", {
                holdId: hold.id,
                smoobuReservationId: hold.smoobuReservationId,
                errorCode: errCode,
                error: errMsg,
            });
            result.errors.push({
                holdId: hold.id,
                bookingSessionId: hold.bookingSessionId,
                phase: "cancel_smoobu",
                errorCode: errCode,
                message: errMsg,
            });
            // Continue to expire the session even if Smoobu cancel fails —
            // a reconciliation job (task 5.3) will catch orphaned reservations.
        }
    }
    // 3. Mark booking session as hold_expired
    try {
        await bookingSessions.markHoldExpired({ bookingSessionId: hold.bookingSessionId });
        logger.info("hold_expiry_session_expired", {
            holdId: hold.id,
            bookingSessionId: hold.bookingSessionId,
        });
        // Send cancellation email — non-fatal
        if (deps.emailConfig) {
            try {
                const session = await bookingSessions.getById(hold.bookingSessionId);
                if (session?.guest?.email) {
                    const property = propertyCatalog_1.BOOKING_PROPERTIES_BY_ID.get(session.propertyId ?? "");
                    const emailClient = (0, email_1.createEmailClient)(deps.emailConfig, logger);
                    await emailClient.sendCancelled(session, property?.name ?? session.propertyId ?? "");
                }
            }
            catch (emailError) {
                logger.error("hold_expiry_email_failed", {
                    holdId: hold.id,
                    bookingSessionId: hold.bookingSessionId,
                    error: emailError instanceof Error ? emailError.message : String(emailError),
                });
            }
        }
    }
    catch (error) {
        result.sessionUpdateFailed += 1;
        const errMsg = error instanceof Error ? error.message : "unknown";
        logger.error("hold_expiry_session_update_failed", {
            holdId: hold.id,
            bookingSessionId: hold.bookingSessionId,
            error: errMsg,
        });
        result.errors.push({
            holdId: hold.id,
            bookingSessionId: hold.bookingSessionId,
            phase: "expire_session",
            errorCode: "session_update_failed",
            message: errMsg,
        });
    }
}
