"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryBookingSessionRepository = exports.RdsBookingSessionRepository = void 0;
exports.getBookingSessionRepository = getBookingSessionRepository;
exports.createNoAvailabilitySession = createNoAvailabilitySession;
const crypto_1 = require("crypto");
const DEFAULT_QUOTE_TTL_MS = 10 * 60 * 1000;
const BOOKING_SESSION_COLUMNS = `
  id,
  reservation_public_id,
  quote_id,
  status,
  language,
  arrival_date,
  departure_date,
  guests,
  source,
  quote_expires_at,
  quoted_properties,
  property_id,
  payment_method,
  rate_plan,
  has_pet,
  currency,
  total_amount_cents,
  guest_first_name,
  guest_last_name,
  guest_email,
  guest_phone,
  guest_country,
  guest_message,
  portal_password_hash,
  portal_password_set_at,
  expires_at,
  paypal_order_id,
  confirmed_at,
  failure_reason,
  cancelled_at,
  cancellation_reason,
  cancelled_by,
  deposit_receipt_s3_key,
  ga_client_id,
  ga_session_id,
  fbp,
  fbc,
  gclid,
  marketing_consent,
  created_at,
  updated_at
`;
const BOOKING_SESSION_SELECT = `select ${BOOKING_SESSION_COLUMNS} from booking_sessions`;
// Must stay in sync with the BookingSessionStatus union above and the
// booking_status enum in 0001_extensions_and_types.sql.
const BOOKING_SESSION_STATUSES = new Set([
    "search_started",
    "quoted",
    "no_availability",
    "hold_creating",
    "hold_active",
    "hold_expired",
    "paypal_pending",
    "paypal_order_created",
    "paypal_captured",
    "paid",
    "confirmed",
    "booking_confirmed",
    "expired",
    "cancelled",
    "failed",
]);
class RdsBookingSessionRepository {
    constructor(pool) {
        this.pool = pool;
    }
    async createQuotedSession(input) {
        return this.createSearchSession(input, "quoted");
    }
    async createNoAvailabilitySession(input) {
        return this.createSearchSession(input, "no_availability");
    }
    async createSearchSession(input, status) {
        const record = createBookingSessionRecord(input, status);
        const result = await this.pool.query(`
        insert into booking_sessions (
          id,
          reservation_public_id,
          quote_id,
          status,
          language,
          arrival_date,
          departure_date,
          guests,
          source,
          quote_expires_at,
          quoted_properties,
          ga_client_id,
          ga_session_id,
          fbp,
          fbc,
          gclid,
          marketing_consent,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19)
        returning ${BOOKING_SESSION_COLUMNS}
      `, [
            record.id,
            record.reservationPublicId,
            record.quoteId,
            record.status,
            record.language,
            record.arrivalDate,
            record.departureDate,
            record.guests,
            record.source ?? null,
            record.quoteExpiresAt,
            JSON.stringify(record.quotedProperties),
            record.tracking?.gaClientId ?? null,
            record.tracking?.gaSessionId ?? null,
            record.tracking?.fbp ?? null,
            record.tracking?.fbc ?? null,
            record.tracking?.gclid ?? null,
            record.marketingConsent,
            record.createdAt,
            record.updatedAt,
        ]);
        return mapRequiredBookingSessionRow(result.rows[0], record.id);
    }
    async getById(id) {
        const result = await this.pool.query(`${BOOKING_SESSION_SELECT} where id = $1 limit 1`, [id]);
        return mapOptionalBookingSessionRow(result.rows[0]);
    }
    async getByQuoteId(quoteId) {
        const result = await this.pool.query(`${BOOKING_SESSION_SELECT} where quote_id = $1 limit 1`, [quoteId]);
        return mapOptionalBookingSessionRow(result.rows[0]);
    }
    async getByReservationPublicId(reservationPublicId) {
        const result = await this.pool.query(`${BOOKING_SESSION_SELECT} where reservation_public_id = $1 limit 1`, [reservationPublicId]);
        return mapOptionalBookingSessionRow(result.rows[0]);
    }
    async markHoldCreating(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'hold_creating',
          property_id = $2,
          payment_method = $3,
          rate_plan = $4,
          has_pet = $5,
          currency = $6,
          total_amount_cents = $7,
          guest_first_name = $8,
          guest_last_name = $9,
          guest_email = $10,
          guest_phone = $11,
          guest_country = $12,
          guest_message = $13,
          portal_password_hash = $14,
          portal_password_set_at = now(),
          expires_at = $15,
          ga_client_id = coalesce($16, ga_client_id),
          ga_session_id = coalesce($17, ga_session_id),
          fbp = coalesce($18, fbp),
          fbc = coalesce($19, fbc),
          gclid = coalesce($20, gclid),
          marketing_consent = coalesce($21, marketing_consent),
          updated_at = now()
        where id = $1 and status = 'quoted'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [
            input.bookingSessionId,
            input.propertyId,
            input.paymentMethod,
            input.ratePlan,
            // Coerced: the column is not-null, so an omitted flag must land as false.
            input.hasPet === true,
            input.price.currency,
            input.price.totalAmountCents,
            input.guest.firstName,
            input.guest.lastName,
            input.guest.email,
            input.guest.phone ?? null,
            input.guest.country ?? null,
            input.guest.message ?? null,
            input.portalPasswordHash,
            input.expiresAt,
            input.tracking?.gaClientId ?? null,
            input.tracking?.gaSessionId ?? null,
            input.tracking?.fbp ?? null,
            input.tracking?.fbc ?? null,
            input.tracking?.gclid ?? null,
            input.marketingConsent === true ? true : null,
        ]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "quoted", "hold_creating");
    }
    async markHoldActive(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'hold_active',
          expires_at = $2,
          updated_at = now()
        where id = $1 and status = 'hold_creating'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.expiresAt]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "hold_creating", "hold_active");
    }
    async markPaypalOrderCreated(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'paypal_order_created',
          paypal_order_id = $2,
          updated_at = now()
        where id = $1 and status = 'hold_active'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.paypalOrderId]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "hold_active", "paypal_order_created");
    }
    async markBookingConfirmed(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'booking_confirmed',
          confirmed_at = $2,
          updated_at = now()
        where id = $1 and status = 'paypal_order_created'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.confirmedAt]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "paypal_order_created", "booking_confirmed");
    }
    async markFailed(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'failed',
          failure_reason = $2,
          updated_at = now()
        where id = $1
          and status not in ('booking_confirmed', 'hold_expired', 'expired', 'cancelled')
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.reason]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        // Row exists but is already in a terminal state — return it as-is rather
        // than throwing, so the error-path cleanup in holds.ts doesn't mask the
        // original failure with a secondary "cannot fail" error.
        const existing = await this.getById(input.bookingSessionId);
        if (existing) {
            return existing;
        }
        throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
    }
    async markHoldExpired(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'hold_expired',
          updated_at = now()
        where id = $1
          and status in ('hold_creating', 'hold_active', 'paypal_pending', 'paypal_order_created')
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        // If the session is already in a terminal state (confirmed, failed, expired),
        // return it as-is rather than throwing — the hold expiry worker should not
        // fail on sessions that have already been resolved.
        const existing = await this.getById(input.bookingSessionId);
        if (existing) {
            return existing;
        }
        throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
    }
    async markDepositConfirmed(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'booking_confirmed',
          confirmed_at = coalesce(confirmed_at, $2),
          deposit_confirmed_at = coalesce(deposit_confirmed_at, $2),
          deposit_confirmed_by = coalesce(deposit_confirmed_by, $3),
          deposit_confirm_token_jti = coalesce(deposit_confirm_token_jti, $4),
          updated_at = now()
        where id = $1
          and status = 'hold_active'
          and payment_method = 'manual_deposit'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.confirmedAt, input.confirmedBy, input.tokenJti]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "hold_active", "booking_confirmed");
    }
    async markCancelled(input) {
        // Two callers: a guest cancelling a confirmed booking, and staff rejecting a
        // deposit booking that is still hold_active because the transfer never
        // arrived. 'cancelled' is in the guard too, so a repeat cancellation
        // (double-submit, or the cancelReservation webhook Smoobu reflects back at
        // us) is a no-op that returns the existing record instead of throwing.
        // coalesce keeps the first cancellation's reason and actor.
        //
        // Who may cancel what is decided by cancellationPolicy.ts in the handler,
        // not here — this guard is only about which states can reach 'cancelled'.
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'cancelled',
          cancelled_at = coalesce(cancelled_at, $4),
          cancellation_reason = coalesce(cancellation_reason, $2),
          cancelled_by = coalesce(cancelled_by, $3),
          updated_at = now()
        where id = $1 and status in ('booking_confirmed', 'hold_active', 'cancelled')
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.reason, input.cancelledBy, input.cancelledAt]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "booking_confirmed", "cancelled");
    }
    async markStaffRejected(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          status = 'cancelled',
          cancelled_at = coalesce(cancelled_at, $3),
          cancellation_reason = coalesce(cancellation_reason, $2),
          cancelled_by = coalesce(cancelled_by, 'staff'),
          updated_at = now()
        where id = $1
          and status = 'hold_active'
          and payment_method = 'manual_deposit'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.reason, input.cancelledAt]);
        return result.rows[0] ? mapBookingSessionRow(result.rows[0]) : undefined;
    }
    async setDepositReceiptS3Key(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          deposit_receipt_s3_key = $2,
          updated_at = now()
        where id = $1
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.s3Key]);
        return mapRequiredBookingSessionRow(result.rows[0], input.bookingSessionId);
    }
    async updateGuests(input) {
        const result = await this.pool.query(`
        update booking_sessions
        set
          guests = $2,
          updated_at = now()
        where id = $1 and status = 'booking_confirmed'
        returning ${BOOKING_SESSION_COLUMNS}
      `, [input.bookingSessionId, input.guests]);
        if (result.rows[0]) {
            return mapBookingSessionRow(result.rows[0]);
        }
        return this.throwMissingOrInvalidTransition(input.bookingSessionId, "booking_confirmed", "booking_confirmed");
    }
    async listByStatus(status) {
        const result = await this.pool.query(`${BOOKING_SESSION_SELECT} where status = $1 order by created_at desc`, [status]);
        return result.rows.map(mapBookingSessionRow);
    }
    async throwMissingOrInvalidTransition(bookingSessionId, expectedStatus, nextStatus) {
        const existing = await this.getById(bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${bookingSessionId} was not found.`);
        }
        throw new Error(`Cannot transition booking session ${bookingSessionId} to ${nextStatus}: expected ${expectedStatus}, got ${existing.status}.`);
    }
}
exports.RdsBookingSessionRepository = RdsBookingSessionRepository;
class InMemoryBookingSessionRepository {
    constructor() {
        this.sessionsById = new Map();
        this.sessionsByQuoteId = new Map();
        this.sessionsByPublicId = new Map();
    }
    async createQuotedSession(input) {
        const record = createBookingSessionRecord(input, "quoted");
        this.sessionsById.set(record.id, record);
        this.sessionsByQuoteId.set(record.quoteId, record);
        this.sessionsByPublicId.set(record.reservationPublicId, record);
        return record;
    }
    async createNoAvailabilitySession(input) {
        const record = createBookingSessionRecord(input, "no_availability");
        this.sessionsById.set(record.id, record);
        this.sessionsByQuoteId.set(record.quoteId, record);
        this.sessionsByPublicId.set(record.reservationPublicId, record);
        return record;
    }
    async getById(id) {
        return this.sessionsById.get(id);
    }
    async getByQuoteId(quoteId) {
        return this.sessionsByQuoteId.get(quoteId);
    }
    async getByReservationPublicId(reservationPublicId) {
        return this.sessionsByPublicId.get(reservationPublicId);
    }
    async markHoldCreating(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        return this.save({
            ...existing,
            status: "hold_creating",
            propertyId: input.propertyId,
            paymentMethod: input.paymentMethod,
            ratePlan: input.ratePlan,
            hasPet: input.hasPet === true,
            currency: input.price.currency,
            totalAmountCents: input.price.totalAmountCents,
            guest: input.guest,
            portalPasswordHash: input.portalPasswordHash,
            portalPasswordSetAt: new Date().toISOString(),
            expiresAt: input.expiresAt,
            // Mirrors the coalesce() in the RDS repository: merge on top of what was
            // captured at search rather than replacing it.
            ...(input.tracking && Object.keys(input.tracking).length > 0
                ? { tracking: { ...existing.tracking, ...input.tracking } }
                : {}),
            ...(input.marketingConsent === true ? { marketingConsent: true } : {}),
            updatedAt: new Date().toISOString(),
        });
    }
    async markHoldActive(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        return this.save({
            ...existing,
            status: "hold_active",
            expiresAt: input.expiresAt,
            updatedAt: new Date().toISOString(),
        });
    }
    async markPaypalOrderCreated(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        if (existing.status !== "hold_active") {
            throw new Error(`Cannot transition booking session ${input.bookingSessionId} to paypal_order_created: expected hold_active, got ${existing.status}.`);
        }
        return this.save({
            ...existing,
            status: "paypal_order_created",
            paypalOrderId: input.paypalOrderId,
            updatedAt: new Date().toISOString(),
        });
    }
    async markBookingConfirmed(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        if (existing.status !== "paypal_order_created") {
            throw new Error(`Cannot transition booking session ${input.bookingSessionId} to booking_confirmed: expected paypal_order_created, got ${existing.status}.`);
        }
        return this.save({
            ...existing,
            status: "booking_confirmed",
            confirmedAt: input.confirmedAt,
            updatedAt: new Date().toISOString(),
        });
    }
    async markFailed(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        return this.save({
            ...existing,
            status: "failed",
            failureReason: input.reason,
            updatedAt: new Date().toISOString(),
        });
    }
    async markHoldExpired(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        return this.save({
            ...existing,
            status: "hold_expired",
            updatedAt: new Date().toISOString(),
        });
    }
    async markDepositConfirmed(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        if (existing.status !== "hold_active" || existing.paymentMethod !== "manual_deposit") {
            throw new Error(`Cannot transition booking session ${input.bookingSessionId} to booking_confirmed: expected hold_active, got ${existing.status}.`);
        }
        return this.save({
            ...existing,
            status: "booking_confirmed",
            confirmedAt: existing.confirmedAt ?? input.confirmedAt,
            updatedAt: new Date().toISOString(),
        });
    }
    async markCancelled(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        if (existing.status !== "booking_confirmed" &&
            existing.status !== "hold_active" &&
            existing.status !== "cancelled") {
            throw new Error(`Cannot transition booking session ${input.bookingSessionId} to cancelled: expected booking_confirmed, got ${existing.status}.`);
        }
        // Idempotent: keep the first cancellation's reason and actor.
        return this.save({
            ...existing,
            status: "cancelled",
            cancelledAt: existing.cancelledAt ?? input.cancelledAt,
            cancellationReason: existing.cancellationReason ?? input.reason,
            cancelledBy: existing.cancelledBy ?? input.cancelledBy,
            updatedAt: new Date().toISOString(),
        });
    }
    async markStaffRejected(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing || existing.status !== "hold_active" || existing.paymentMethod !== "manual_deposit") {
            return undefined;
        }
        return this.save({
            ...existing,
            status: "cancelled",
            cancelledAt: existing.cancelledAt ?? input.cancelledAt,
            cancellationReason: existing.cancellationReason ?? input.reason,
            cancelledBy: existing.cancelledBy ?? "staff",
            updatedAt: new Date().toISOString(),
        });
    }
    async setDepositReceiptS3Key(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        return this.save({
            ...existing,
            depositReceiptS3Key: input.s3Key,
            updatedAt: new Date().toISOString(),
        });
    }
    async updateGuests(input) {
        const existing = this.sessionsById.get(input.bookingSessionId);
        if (!existing) {
            throw new Error(`Booking session ${input.bookingSessionId} was not found.`);
        }
        if (existing.status !== "booking_confirmed") {
            throw new Error(`Cannot update guests for booking session ${input.bookingSessionId}: expected booking_confirmed, got ${existing.status}.`);
        }
        return this.save({
            ...existing,
            guests: input.guests,
            updatedAt: new Date().toISOString(),
        });
    }
    async listByStatus(status) {
        const results = [];
        for (const session of this.sessionsById.values()) {
            if (session.status === status) {
                results.push(session);
            }
        }
        return results;
    }
    save(record) {
        this.sessionsById.set(record.id, record);
        this.sessionsByQuoteId.set(record.quoteId, record);
        this.sessionsByPublicId.set(record.reservationPublicId, record);
        return record;
    }
}
exports.InMemoryBookingSessionRepository = InMemoryBookingSessionRepository;
function getBookingSessionRepository() {
    return new InMemoryBookingSessionRepository();
}
function createNoAvailabilitySession(input) {
    return createBookingSessionRecord(input, "no_availability");
}
function createBookingSessionRecord(input, status) {
    const now = new Date();
    return {
        id: (0, crypto_1.randomUUID)(),
        reservationPublicId: createReservationPublicId(),
        quoteId: createQuoteId(),
        status,
        language: input.language,
        arrivalDate: input.arrivalDate,
        departureDate: input.departureDate,
        guests: input.guests,
        ...(input.source ? { source: input.source } : {}),
        quoteExpiresAt: new Date(now.getTime() + (input.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS)).toISOString(),
        quotedProperties: input.quotedProperties ?? [],
        ...(input.tracking && Object.keys(input.tracking).length > 0 ? { tracking: input.tracking } : {}),
        marketingConsent: input.marketingConsent === true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
    };
}
/**
 * Collapses the five identifier columns into one object, returning undefined
 * when the guest declined marketing cookies and none were ever stored.
 */
function mapTracking(row) {
    const tracking = {
        ...(row.ga_client_id ? { gaClientId: row.ga_client_id } : {}),
        ...(row.ga_session_id ? { gaSessionId: row.ga_session_id } : {}),
        ...(row.fbp ? { fbp: row.fbp } : {}),
        ...(row.fbc ? { fbc: row.fbc } : {}),
        ...(row.gclid ? { gclid: row.gclid } : {}),
    };
    return Object.keys(tracking).length > 0 ? tracking : undefined;
}
function createQuoteId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const entropy = (0, crypto_1.randomBytes)(8).toString("hex").toUpperCase();
    return `qt_${timestamp}${entropy}`;
}
function createReservationPublicId() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = (0, crypto_1.randomBytes)(8);
    let suffix = "";
    for (const byte of bytes) {
        suffix += alphabet[byte % alphabet.length];
    }
    return `KWL-${suffix}`;
}
function mapRequiredBookingSessionRow(row, bookingSessionId) {
    if (!row) {
        throw new Error(`Booking session ${bookingSessionId} was not found.`);
    }
    return mapBookingSessionRow(row);
}
function mapOptionalBookingSessionRow(row) {
    return row ? mapBookingSessionRow(row) : undefined;
}
function mapBookingSessionRow(row) {
    const guest = mapGuest(row);
    const tracking = mapTracking(row);
    return {
        id: row.id,
        reservationPublicId: row.reservation_public_id,
        quoteId: row.quote_id,
        status: parseBookingSessionStatus(row.status),
        language: row.language,
        arrivalDate: toDateOnly(row.arrival_date),
        departureDate: toDateOnly(row.departure_date),
        guests: row.guests,
        ...(row.source ? { source: row.source } : {}),
        quoteExpiresAt: toIsoString(row.quote_expires_at),
        quotedProperties: parseQuotedProperties(row.quoted_properties),
        ...(row.property_id ? { propertyId: row.property_id } : {}),
        ...(row.payment_method ? { paymentMethod: parsePaymentMethod(row.payment_method) } : {}),
        ...(row.rate_plan ? { ratePlan: parseRatePlan(row.rate_plan) } : {}),
        hasPet: row.has_pet === true,
        ...(row.currency ? { currency: row.currency.trim().toUpperCase() } : {}),
        ...(row.total_amount_cents !== null ? { totalAmountCents: row.total_amount_cents } : {}),
        ...(guest ? { guest } : {}),
        ...(row.portal_password_hash ? { portalPasswordHash: row.portal_password_hash } : {}),
        ...(row.portal_password_set_at ? { portalPasswordSetAt: toIsoString(row.portal_password_set_at) } : {}),
        ...(row.expires_at ? { expiresAt: toIsoString(row.expires_at) } : {}),
        ...(row.paypal_order_id ? { paypalOrderId: row.paypal_order_id } : {}),
        ...(row.confirmed_at ? { confirmedAt: toIsoString(row.confirmed_at) } : {}),
        ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
        ...(row.cancelled_at ? { cancelledAt: toIsoString(row.cancelled_at) } : {}),
        ...(row.cancellation_reason ? { cancellationReason: row.cancellation_reason } : {}),
        ...(row.cancelled_by ? { cancelledBy: parseCancellationActor(row.cancelled_by) } : {}),
        ...(row.deposit_receipt_s3_key ? { depositReceiptS3Key: row.deposit_receipt_s3_key } : {}),
        ...(tracking ? { tracking } : {}),
        marketingConsent: row.marketing_consent === true,
        createdAt: toIsoString(row.created_at),
        updatedAt: toIsoString(row.updated_at),
    };
}
function parseBookingSessionStatus(status) {
    if (BOOKING_SESSION_STATUSES.has(status)) {
        return status;
    }
    throw new Error(`Unsupported booking session status from database: ${status}`);
}
function parsePaymentMethod(value) {
    if (value === "paypal" || value === "manual_deposit") {
        return value;
    }
    throw new Error(`Unsupported booking session payment method from database: ${value}`);
}
function parseRatePlan(value) {
    if (value === "flexible" || value === "non_refundable") {
        return value;
    }
    throw new Error(`Unsupported booking session rate plan from database: ${value}`);
}
function parseCancellationActor(value) {
    if (value === "guest" || value === "staff" || value === "system") {
        return value;
    }
    throw new Error(`Unsupported booking session cancellation actor from database: ${value}`);
}
function mapGuest(row) {
    if (!row.guest_first_name || !row.guest_last_name || !row.guest_email) {
        return undefined;
    }
    return {
        firstName: row.guest_first_name,
        lastName: row.guest_last_name,
        email: row.guest_email,
        ...(row.guest_phone ? { phone: row.guest_phone } : {}),
        ...(row.guest_country ? { country: row.guest_country } : {}),
        ...(row.guest_message ? { message: row.guest_message } : {}),
    };
}
function parseQuotedProperties(value) {
    const parsed = parseJsonbValue(value);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed
        .map(parseQuotedProperty)
        .filter((property) => property !== undefined);
}
function parseQuotedProperty(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const property = value;
    if (typeof property.propertyId !== "string" ||
        typeof property.currency !== "string" ||
        typeof property.totalAmountCents !== "number" ||
        typeof property.nightlyAverageCents !== "number" ||
        typeof property.nights !== "number" ||
        typeof property.includesTaxes !== "boolean" ||
        property.rateSource !== "smoobu") {
        return undefined;
    }
    return {
        propertyId: property.propertyId,
        currency: property.currency,
        totalAmountCents: property.totalAmountCents,
        nightlyAverageCents: property.nightlyAverageCents,
        nights: property.nights,
        includesTaxes: property.includesTaxes,
        rateSource: "smoobu",
    };
}
function parseJsonbValue(value) {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function toDateOnly(value) {
    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }
    return value.slice(0, 10);
}
function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    const timestampMs = Date.parse(value);
    return Number.isNaN(timestampMs) ? value : new Date(timestampMs).toISOString();
}
