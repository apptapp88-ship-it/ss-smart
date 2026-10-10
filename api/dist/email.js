"use strict";
/**
 * email.ts
 *
 * Thin SES email client and high-level send helpers for each booking state.
 * Uses the AWS SDK v3 SES client available in the Lambda runtime (no extra
 * npm dependency needed — @aws-sdk/* packages are bundled in the Lambda
 * Node.js 18+ managed runtime).
 *
 * The client is intentionally lazy-loaded so unit tests can run without
 * real AWS credentials.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailClient = void 0;
exports.createEmailClient = createEmailClient;
const emailTemplates_1 = require("./emailTemplates");
/**
 * Sends an email via SES using the AWS SDK v3.
 * The SDK is require()'d at call time so the module can be imported in tests
 * without triggering AWS credential resolution.
 */
async function sesSend(input) {
    // Dynamic import keeps the module testable without AWS credentials.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
    const client = new SESClient({ region: input.region });
    const command = new SendEmailCommand({
        Source: input.from,
        Destination: { ToAddresses: [input.to] },
        Message: {
            Subject: { Data: input.subject, Charset: "UTF-8" },
            Body: {
                Html: { Data: input.html, Charset: "UTF-8" },
                Text: { Data: input.text, Charset: "UTF-8" },
            },
        },
        ...(input.configurationSetName ? { ConfigurationSetName: input.configurationSetName } : {}),
    });
    await client.send(command);
}
// ─── EmailClient ─────────────────────────────────────────────────────────────
class EmailClient {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async send(to, subject, html, text, context) {
        if (this.config.disabled) {
            this.logger.info("email_send_skipped_disabled", { to, subject, ...context });
            return;
        }
        try {
            await sesSend({
                from: this.config.fromAddress,
                to,
                subject,
                html,
                text,
                region: this.config.region,
                configurationSetName: this.config.configurationSetName,
            });
            this.logger.info("email_sent", { to, subject, ...context });
        }
        catch (error) {
            // Email failures are non-fatal — log and continue.
            // The booking state machine has already transitioned; a failed email
            // should not roll back a confirmed booking.
            this.logger.error("email_send_failed", {
                to,
                subject,
                error: error instanceof Error ? error.message : String(error),
                ...context,
            });
        }
    }
    async sendHoldCreated(session, propertyName) {
        if (!session.guest?.email)
            return;
        const input = buildTemplateInput(session, propertyName);
        const { subject, html, text } = (0, emailTemplates_1.renderHoldCreatedEmail)(input);
        await this.send(session.guest.email, subject, html, text, {
            template: "hold_created",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    async sendPaymentPending(session, propertyName, paypalOrderId) {
        if (!session.guest?.email)
            return;
        const input = {
            ...buildTemplateInput(session, propertyName),
            paypalOrderId,
        };
        const { subject, html, text } = (0, emailTemplates_1.renderPaymentPendingEmail)(input);
        await this.send(session.guest.email, subject, html, text, {
            template: "payment_pending",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    async sendBookingConfirmed(session, propertyName, paypalCaptureId) {
        if (!session.guest?.email)
            return;
        const input = {
            ...buildTemplateInput(session, propertyName),
            paypalCaptureId,
            confirmedAt: session.confirmedAt,
        };
        const { subject, html, text } = (0, emailTemplates_1.renderBookingConfirmedEmail)(input);
        await this.send(session.guest.email, subject, html, text, {
            template: "booking_confirmed",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /**
     * Guest-facing confirmation of a self-service cancellation.
     *
     * `refundExpected` is false for cancellations inside the no-refund window, so
     * the guest is not told to expect money back that isn't coming.
     */
    async sendGuestCancellation(session, propertyName, options) {
        if (!session.guest?.email)
            return;
        const input = {
            ...buildTemplateInput(session, propertyName),
            ...(options.paypalCaptureId ? { paypalCaptureId: options.paypalCaptureId } : {}),
            refundExpected: options.refundExpected,
            ...(session.cancellationReason ? { cancellationReason: session.cancellationReason } : {}),
        };
        const { subject, html, text } = (0, emailTemplates_1.renderGuestCancellationEmail)(input);
        await this.send(session.guest.email, subject, html, text, {
            template: "guest_cancellation",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /**
     * Operational alert so staff know to issue the refund by hand. Skipped with a
     * warning when no staff address is configured — a missing internal address
     * must never fail the guest's cancellation.
     */
    async sendStaffCancellationAlert(session, propertyName, options) {
        const recipient = this.config.staffNotificationEmail;
        if (!recipient) {
            this.logger.warn("staff_notification_email_not_configured", {
                template: "staff_cancellation",
                reservationPublicId: session.reservationPublicId,
            });
            return;
        }
        const input = {
            ...buildTemplateInput(session, propertyName),
            ...(options.paypalCaptureId ? { paypalCaptureId: options.paypalCaptureId } : {}),
            refundExpected: options.refundExpected,
            ...(session.cancellationReason ? { cancellationReason: session.cancellationReason } : {}),
        };
        const { subject, html, text } = (0, emailTemplates_1.renderStaffCancellationEmail)(input);
        await this.send(recipient, subject, html, text, {
            template: "staff_cancellation",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /**
     * Forwards a guest's portal help-request message to staff. Skipped with a
     * warning when no staff address is configured — same non-fatal shape as the
     * other staff-facing sends, since this is called from a route that must
     * still return 200 to the guest either way.
     */
    async sendStaffHelpRequest(session, propertyName, options) {
        const recipient = this.config.staffNotificationEmail;
        if (!recipient) {
            this.logger.warn("staff_notification_email_not_configured", {
                template: "staff_help_request",
                reservationPublicId: session.reservationPublicId,
            });
            return;
        }
        const input = {
            ...buildTemplateInput(session, propertyName),
            ...(options.type ? { helpRequestType: options.type } : {}),
            guestMessage: options.message,
        };
        const { subject, html, text } = (0, emailTemplates_1.renderStaffHelpRequestEmail)(input);
        await this.send(recipient, subject, html, text, {
            template: "staff_help_request",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /**
     * Forwards a guest's portal cancellation *request* to staff — the booking
     * is still `booking_confirmed` at this point, nothing has been cancelled.
     * Distinct from sendStaffCancellationAlert, which fires after the guest's
     * self-service cancel endpoint has already cancelled the booking.
     */
    async sendStaffCancellationRequest(session, propertyName, options) {
        const recipient = this.config.staffNotificationEmail;
        if (!recipient) {
            this.logger.warn("staff_notification_email_not_configured", {
                template: "staff_cancellation_request",
                reservationPublicId: session.reservationPublicId,
            });
            return;
        }
        const input = {
            ...buildTemplateInput(session, propertyName),
            cancellationReason: options.reason,
            ...(options.message ? { guestMessage: options.message } : {}),
        };
        const { subject, html, text } = (0, emailTemplates_1.renderStaffCancellationRequestEmail)(input);
        await this.send(recipient, subject, html, text, {
            template: "staff_cancellation_request",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /** Guest-facing bank details and hold deadline for a manual deposit booking. */
    async sendDepositInstructions(session, propertyName, bankInfo, depositUploadUrl) {
        if (!session.guest?.email)
            return;
        const input = {
            ...buildTemplateInput(session, propertyName),
            ...(bankInfo ? { bankInfo } : {}),
            ...(depositUploadUrl ? { depositUploadUrl } : {}),
        };
        const { subject, html, text } = (0, emailTemplates_1.renderDepositInstructionsEmail)(input);
        await this.send(session.guest.email, subject, html, text, {
            template: "deposit_instructions",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /** Guest-facing confirmation once staff verify the transfer. */
    async sendDepositConfirmed(session, propertyName) {
        if (!session.guest?.email)
            return;
        const { subject, html, text } = (0, emailTemplates_1.renderDepositConfirmedEmail)(buildTemplateInput(session, propertyName));
        await this.send(session.guest.email, subject, html, text, {
            template: "deposit_confirmed",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    /**
     * Staff-facing review request carrying the signed confirm/reject links.
     * Skipped with a warning when no staff address is configured — the guest's
     * booking must not fail because an internal address is missing.
     */
    async sendStaffDepositReview(session, propertyName, options) {
        const recipient = this.config.staffNotificationEmail;
        if (!recipient) {
            this.logger.warn("staff_notification_email_not_configured", {
                template: "staff_deposit_review",
                reservationPublicId: session.reservationPublicId,
            });
            return;
        }
        const input = {
            ...buildTemplateInput(session, propertyName),
            depositConfirmUrl: options.confirmUrl,
            depositRejectUrl: options.rejectUrl,
            ...(options.bankInfo ? { bankInfo: options.bankInfo } : {}),
            ...(options.receiptUrl ? { depositReceiptUrl: options.receiptUrl } : {}),
        };
        const { subject, html, text } = (0, emailTemplates_1.renderStaffDepositReviewEmail)(input);
        await this.send(recipient, subject, html, text, {
            template: "staff_deposit_review",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    async sendCancelled(session, propertyName) {
        if (!session.guest?.email)
            return;
        const input = buildTemplateInput(session, propertyName);
        const { subject, html, text } = (0, emailTemplates_1.renderCancelledEmail)(input);
        await this.send(session.guest.email, subject, html, text, {
            template: "cancelled",
            reservationPublicId: session.reservationPublicId,
            bookingSessionId: session.id,
        });
    }
    async sendDepositHandoff(guestEmail, guestFirstName, language, propertyName, arrivalDate, departureDate, guests) {
        const DEFAULT_WHATSAPP = "https://wa.me/contact";
        const DEFAULT_CONTACT_EMAIL = "reservations@example.com";
        const input = {
            language,
            guestFirstName,
            guestEmail,
            reservationPublicId: "",
            propertyName,
            arrivalDate,
            departureDate,
            guests,
            contactWhatsApp: this.config.contactWhatsAppUrl ?? DEFAULT_WHATSAPP,
            contactEmail: this.config.contactEmail ?? DEFAULT_CONTACT_EMAIL,
        };
        const { subject, html, text } = (0, emailTemplates_1.renderDepositHandoffEmail)(input);
        await this.send(guestEmail, subject, html, text, {
            template: "deposit_handoff",
            language,
        });
    }
}
exports.EmailClient = EmailClient;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildTemplateInput(session, propertyName) {
    return {
        language: session.language,
        guestFirstName: session.guest?.firstName ?? "",
        guestEmail: session.guest?.email ?? "",
        reservationPublicId: session.reservationPublicId,
        propertyName,
        arrivalDate: session.arrivalDate,
        departureDate: session.departureDate,
        guests: session.guests,
        currency: session.currency,
        totalAmountCents: session.totalAmountCents,
        holdExpiresAt: session.expiresAt,
    };
}
// ─── Factory ──────────────────────────────────────────────────────────────────
function createEmailClient(config, logger) {
    return new EmailClient(config, logger);
}
