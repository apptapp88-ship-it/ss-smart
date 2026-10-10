"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const config_1 = require("./config");
const bookingSessions_1 = require("./bookingSessions");
const db_1 = require("./db");
const observability_1 = require("./observability");
const payments_1 = require("./payments");
const paypalClient_1 = require("./paypalClient");
const paymentReconciliation_1 = require("./paymentReconciliation");
/**
 * Lambda entry point for the scheduled payment reconciliation worker.
 * Triggered by EventBridge rule (e.g. rate(5 minutes)).
 *
 * Checks all "pending PayPal" sessions against the PayPal Orders API
 * and resolves missing webhooks or stale/abandoned payments.
 *
 * IMPORTANT — Repository wiring:
 * Default Lambda config gets RDS repositories from the Secrets Manager/RDS
 * pool path before reconciliation runs.
 *
 * The core logic in reconcilePendingPayments is fully tested with in-memory
 * repositories and is reused unchanged by the RDS-backed worker.
 */
async function handler() {
    const config = (0, config_1.loadConfig)();
    const observability = (0, observability_1.createObservability)(config.observability);
    const logger = observability.createLogger({ worker: "payment-reconciliation" });
    await ensureRepositories(config);
    if (!config.bookingSessions || !config.payments) {
        logger.warn("payment_reconciliation_no_repositories", {
            hasBookingSessions: !!config.bookingSessions,
            hasPayments: !!config.payments,
            note: "RDS-backed repositories could not be initialised. Worker is a no-op.",
        });
        return {
            processed: 0,
            confirmed: 0,
            markedFailed: 0,
            stillPending: 0,
            providerErrors: 0,
            errors: [],
        };
    }
    const paypalClient = await (0, paypalClient_1.createPayPalClient)(config);
    return (0, paymentReconciliation_1.reconcilePendingPayments)({
        payments: config.payments,
        bookingSessions: config.bookingSessions,
        paypalClient,
        logger,
        ...(config.serverConversions ? { serverConversions: config.serverConversions } : {}),
    });
}
async function ensureRepositories(config) {
    if (config.bookingSessions && config.payments) {
        return;
    }
    const pool = await (0, db_1.getPool)({ secretProvider: config.secrets });
    if (!config.bookingSessions) {
        config.bookingSessions = new bookingSessions_1.RdsBookingSessionRepository(pool);
    }
    if (!config.payments) {
        config.payments = new payments_1.RdsPaymentRepository(pool);
    }
}
