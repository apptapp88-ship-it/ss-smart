"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryPaymentRepository = exports.RdsPaymentRepository = void 0;
const crypto_1 = require("crypto");
const errors_1 = require("./http/errors");
const PAYMENT_COLUMNS = `
  id,
  booking_session_id,
  status,
  amount_cents,
  currency,
  paypal_order_id,
  paypal_capture_id,
  paypal_order_request_id,
  paypal_capture_request_id,
  paid_at,
  refund_flagged_at,
  created_at,
  updated_at
`;
const PAYMENT_SELECT = `select ${PAYMENT_COLUMNS} from payments`;
class RdsPaymentRepository {
    constructor(pool) {
        this.pool = pool;
    }
    async createOrderPayment(input) {
        try {
            const result = await this.pool.query(`
          insert into payments (
            booking_session_id,
            provider,
            method,
            status,
            amount_cents,
            currency,
            paypal_order_id,
            paypal_order_request_id,
            paypal_capture_request_id
          )
          values ($1, 'paypal', 'paypal', 'order_created', $2, $3, $4, $5, $6)
          returning ${PAYMENT_COLUMNS}
        `, [
                input.bookingSessionId,
                input.totalAmountCents,
                input.currency.trim().toUpperCase(),
                input.paypalOrderId,
                input.paypalRequestIdOrder,
                input.paypalRequestIdCapture,
            ]);
            return mapRequiredPaymentRow(result.rows[0], input.bookingSessionId);
        }
        catch (error) {
            throw mapPaymentInsertError(error);
        }
    }
    async getByBookingSessionId(bookingSessionId) {
        const result = await this.pool.query(`${PAYMENT_SELECT} where booking_session_id = $1 limit 1`, [bookingSessionId]);
        return mapOptionalPaymentRow(result.rows[0]);
    }
    async markCaptured(input) {
        const result = await this.pool.query(`
        update payments
        set
          status = 'captured',
          paypal_capture_id = $2,
          paypal_capture_status = 'COMPLETED',
          paid_at = $3,
          updated_at = now()
        where booking_session_id = $1
          and status = 'order_created'
        returning ${PAYMENT_COLUMNS}
      `, [input.bookingSessionId, input.paypalCaptureId, input.capturedAt]);
        if (result.rows[0]) {
            return mapPaymentRow(result.rows[0]);
        }
        const existing = await this.getByBookingSessionId(input.bookingSessionId);
        if (!existing) {
            throw paymentMissing();
        }
        if (existing.status === "captured" && existing.paypalCaptureId === input.paypalCaptureId) {
            return existing;
        }
        throw new Error(`Cannot transition payment for booking session ${input.bookingSessionId} to captured: expected order_created, got ${existing.status}.`);
    }
    async markFailed(bookingSessionId) {
        const result = await this.pool.query(`
        update payments
        set
          status = 'failed',
          failed_at = coalesce(failed_at, now()),
          updated_at = now()
        where booking_session_id = $1
          and status not in ('captured', 'failed')
        returning ${PAYMENT_COLUMNS}
      `, [bookingSessionId]);
        if (result.rows[0]) {
            return mapPaymentRow(result.rows[0]);
        }
        const existing = await this.getByBookingSessionId(bookingSessionId);
        if (existing) {
            return existing;
        }
        throw paymentMissing();
    }
    async markRefundFlagged(input) {
        const result = await this.pool.query(`
        update payments
        set
          status = 'refund_flagged',
          refund_flagged_at = coalesce(refund_flagged_at, $2),
          updated_at = now()
        where booking_session_id = $1
          and status in ('captured', 'paid', 'refund_flagged')
        returning ${PAYMENT_COLUMNS}
      `, [input.bookingSessionId, input.flaggedAt]);
        if (result.rows[0]) {
            return mapPaymentRow(result.rows[0]);
        }
        // Nothing to flag (never captured, already failed) — return the row as-is so a
        // cancellation is never blocked by the state of its payment.
        const existing = await this.getByBookingSessionId(input.bookingSessionId);
        if (existing) {
            return existing;
        }
        throw paymentMissing();
    }
    async listByStatus(status, limit = 500) {
        const result = await this.pool.query(`${PAYMENT_SELECT} where provider = 'paypal' and status = $1 order by created_at asc limit $2`, [status, limit]);
        return result.rows.map(mapPaymentRow);
    }
}
exports.RdsPaymentRepository = RdsPaymentRepository;
class InMemoryPaymentRepository {
    constructor() {
        this.records = new Map();
    }
    async createOrderPayment(input) {
        if (this.records.has(input.bookingSessionId)) {
            throw new errors_1.ApiError(409, "payment_already_exists", "A payment record already exists for this booking session.");
        }
        const now = new Date().toISOString();
        const record = {
            id: (0, crypto_1.randomUUID)(),
            bookingSessionId: input.bookingSessionId,
            paypalOrderId: input.paypalOrderId,
            paypalRequestIdOrder: input.paypalRequestIdOrder,
            paypalRequestIdCapture: input.paypalRequestIdCapture,
            status: "order_created",
            currency: input.currency,
            totalAmountCents: input.totalAmountCents,
            createdAt: now,
            updatedAt: now,
        };
        this.records.set(input.bookingSessionId, record);
        return record;
    }
    async getByBookingSessionId(bookingSessionId) {
        return this.records.get(bookingSessionId);
    }
    async markCaptured(input) {
        const existing = this.getRequired(input.bookingSessionId);
        const updated = {
            ...existing,
            status: "captured",
            paypalCaptureId: input.paypalCaptureId,
            capturedAt: input.capturedAt,
            updatedAt: new Date().toISOString(),
        };
        this.records.set(input.bookingSessionId, updated);
        return updated;
    }
    async markFailed(bookingSessionId) {
        const existing = this.getRequired(bookingSessionId);
        const updated = {
            ...existing,
            status: "failed",
            updatedAt: new Date().toISOString(),
        };
        this.records.set(bookingSessionId, updated);
        return updated;
    }
    async markRefundFlagged(input) {
        const existing = this.getRequired(input.bookingSessionId);
        if (existing.status !== "captured" && existing.status !== "paid" && existing.status !== "refund_flagged") {
            return existing;
        }
        const updated = {
            ...existing,
            status: "refund_flagged",
            refundFlaggedAt: existing.refundFlaggedAt ?? input.flaggedAt,
            updatedAt: new Date().toISOString(),
        };
        this.records.set(input.bookingSessionId, updated);
        return updated;
    }
    async listByStatus(status) {
        const results = [];
        for (const record of this.records.values()) {
            if (record.status === status) {
                results.push(record);
            }
        }
        return results;
    }
    getRequired(bookingSessionId) {
        const record = this.records.get(bookingSessionId);
        if (!record) {
            throw new errors_1.ApiError(500, "payment_state_invalid", "Payment record is missing.");
        }
        return record;
    }
}
exports.InMemoryPaymentRepository = InMemoryPaymentRepository;
function mapOptionalPaymentRow(row) {
    return row ? mapPaymentRow(row) : undefined;
}
function mapRequiredPaymentRow(row, bookingSessionId) {
    if (!row) {
        throw new Error(`Payment for booking session ${bookingSessionId} was not found.`);
    }
    return mapPaymentRow(row);
}
function mapPaymentRow(row) {
    const paypalOrderId = row.paypal_order_id;
    const paypalRequestIdOrder = row.paypal_order_request_id;
    const paypalRequestIdCapture = row.paypal_capture_request_id;
    if (!paypalOrderId || !paypalRequestIdOrder || !paypalRequestIdCapture) {
        throw new Error(`Payment ${row.id} is missing PayPal identifiers.`);
    }
    return {
        id: row.id,
        bookingSessionId: row.booking_session_id,
        paypalOrderId,
        ...(row.paypal_capture_id ? { paypalCaptureId: row.paypal_capture_id } : {}),
        paypalRequestIdOrder,
        paypalRequestIdCapture,
        status: parsePaymentStatus(row.status),
        currency: row.currency.trim().toUpperCase(),
        totalAmountCents: row.amount_cents,
        ...(row.paid_at ? { capturedAt: toIsoString(row.paid_at) } : {}),
        ...(row.refund_flagged_at ? { refundFlaggedAt: toIsoString(row.refund_flagged_at) } : {}),
        createdAt: toIsoString(row.created_at),
        updatedAt: toIsoString(row.updated_at),
    };
}
function parsePaymentStatus(status) {
    if (status === "pending" ||
        status === "order_created" ||
        status === "captured" ||
        status === "paid" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "refund_flagged") {
        return status;
    }
    throw new Error(`Unsupported payment status from database: ${status}`);
}
function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    const timestampMs = Date.parse(value);
    return Number.isNaN(timestampMs) ? value : new Date(timestampMs).toISOString();
}
function mapPaymentInsertError(error) {
    const pgError = error;
    if (pgError.code === "23505") {
        return new errors_1.ApiError(409, "payment_already_exists", "A payment record already exists for this booking session.");
    }
    return error;
}
function paymentMissing() {
    return new errors_1.ApiError(500, "payment_state_invalid", "Payment record is missing.");
}
