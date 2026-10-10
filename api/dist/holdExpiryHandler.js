"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const config_1 = require("./config");
const bookingSessions_1 = require("./bookingSessions");
const db_1 = require("./db");
const holds_1 = require("./holds");
const observability_1 = require("./observability");
const smoobuClient_1 = require("./smoobuClient");
const holdExpiry_1 = require("./holdExpiry");
/**
 * Lambda entry point for the scheduled hold expiry worker.
 * Triggered by EventBridge rule (e.g. rate(1 minute)).
 *
 * IMPORTANT — Repository wiring:
 * Default Lambda config gets RDS repositories from the Secrets Manager/RDS
 * pool path before the sweep runs.
 *
 * The core logic in processExpiredHolds is fully tested with in-memory
 * repositories and is reused unchanged by the RDS-backed worker.
 */
async function handler() {
    const config = (0, config_1.loadConfig)();
    const observability = (0, observability_1.createObservability)(config.observability);
    const logger = observability.createLogger({ worker: "hold-expiry" });
    await ensureRepositories(config);
    if (!config.bookingSessions || !config.holds) {
        logger.warn("hold_expiry_no_repositories", {
            hasBookingSessions: !!config.bookingSessions,
            hasHolds: !!config.holds,
            note: "RDS-backed repositories could not be initialised. Worker is a no-op.",
        });
        return {
            processed: 0,
            expired: 0,
            smoobuCancelled: 0,
            smoobuCancelFailed: 0,
            sessionUpdateFailed: 0,
            errors: [],
        };
    }
    const smoobuClient = await (0, smoobuClient_1.createSmoobuClient)(config);
    return (0, holdExpiry_1.processExpiredHolds)({
        holds: config.holds,
        bookingSessions: config.bookingSessions,
        smoobuClient,
        logger,
        emailConfig: config.email,
    });
}
async function ensureRepositories(config) {
    if (config.bookingSessions && config.holds) {
        return;
    }
    const pool = await (0, db_1.getPool)({ secretProvider: config.secrets });
    if (!config.bookingSessions) {
        config.bookingSessions = new bookingSessions_1.RdsBookingSessionRepository(pool);
    }
    if (!config.holds) {
        config.holds = new holds_1.RdsHoldRepository(pool);
    }
}
