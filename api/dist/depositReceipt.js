"use strict";
/**
 * Deposit receipt upload — generates presigned S3 PUT URLs for guests to upload
 * deposit receipt images, and confirms the upload by storing the S3 key on the
 * booking session and appending the S3 link to the Smoobu reservation notice.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.presignReceiptDownload = presignReceiptDownload;
exports.handleDepositReceiptUploadUrl = handleDepositReceiptUploadUrl;
exports.handleDepositReceiptConfirm = handleDepositReceiptConfirm;
const errors_1 = require("./http/errors");
const response_1 = require("./http/response");
const signedTokens_1 = require("./signedTokens");
const smoobuClient_1 = require("./smoobuClient");
/**
 * Both receipt endpoints act on a booking the guest has no portal session for —
 * the booking is not confirmed yet, so portal login is refused. Instead the
 * deposit-hold response issues a short-lived `deposit_access` token scoped to
 * that one booking session.
 *
 * Without this the only gate is a bookingSessionId in the request body, which
 * would let anyone holding (or guessing) an id attach files to someone else's
 * booking and have the link mailed to staff.
 */
async function requireDepositAccess(bookingSessionId, authorizationHeader, config) {
    const token = (0, signedTokens_1.extractBearerToken)(authorizationHeader);
    if (!token) {
        throw new errors_1.ApiError(401, "unauthorized", "A deposit access token is required.");
    }
    const { portalSessionSecret } = await config.secrets.getSecrets();
    const payload = (0, signedTokens_1.verifySignedToken)(token, portalSessionSecret, ["deposit_access"]);
    if (payload.sub !== bookingSessionId) {
        throw new errors_1.ApiError(403, "forbidden", "This token is not valid for that booking.");
    }
}
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_FILENAME_LENGTH = 128;
function requireS3Config(config) {
    if (!config.s3Upload) {
        throw new errors_1.ApiError(503, "upload_not_configured", "Deposit receipt uploads are not configured.", {
            retryable: false,
        });
    }
    return config.s3Upload;
}
/**
 * Presigned GET for a stored receipt.
 *
 * Exported because the staff notification emails need the same link, and the
 * bucket is private — a plain object URL would 403.
 */
async function presignReceiptDownload(s3Config, s3Key) {
    const { S3Client, GetObjectCommand } = await Promise.resolve().then(() => __importStar(require("@aws-sdk/client-s3")));
    const { getSignedUrl } = await Promise.resolve().then(() => __importStar(require("@aws-sdk/s3-request-presigner")));
    const s3Client = new S3Client(buildS3ClientConfig(s3Config));
    return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: s3Config.bucketName, Key: s3Key }), {
        expiresIn: s3Config.presignedGetExpirySeconds,
    });
}
/**
 * In AWS this is just the region — the SDK resolves the regional endpoint and
 * picks up credentials from the Lambda execution role. `endpointUrl` is set only
 * for local development against MinIO, which also needs path-style addressing
 * because `bucket.localhost` doesn't resolve.
 */
function buildS3ClientConfig(s3Config) {
    if (!s3Config.endpointUrl) {
        return { region: s3Config.region };
    }
    return { region: s3Config.region, endpoint: s3Config.endpointUrl, forcePathStyle: true };
}
function getBookingSessionRepository(config) {
    if (!config.bookingSessions) {
        throw new errors_1.ApiError(503, "database_unavailable", "Booking session storage is not configured.", {
            retryable: true,
        });
    }
    return config.bookingSessions;
}
function getHoldRepository(config) {
    if (!config.holds) {
        throw new errors_1.ApiError(503, "database_unavailable", "Hold storage is not configured.", {
            retryable: true,
        });
    }
    return config.holds;
}
/**
 * Generates a presigned S3 PUT URL for the guest to upload a deposit receipt.
 *
 * The S3 key is namespaced under the booking session ID to prevent collisions
 * and make it easy to locate receipts per booking.
 */
async function handleDepositReceiptUploadUrl(body, config, responseHeaders, observability, authorizationHeader) {
    await requireDepositAccess(body.bookingSessionId, authorizationHeader, config);
    const s3Config = requireS3Config(config);
    const sessions = getBookingSessionRepository(config);
    const session = await sessions.getById(body.bookingSessionId);
    if (!session) {
        throw new errors_1.ApiError(404, "not_found", "Booking session was not found.");
    }
    // Validate content type against allowlist
    if (!s3Config.allowedMimeTypes.includes(body.contentType)) {
        throw new errors_1.ApiError(400, "invalid_content_type", `Content type "${body.contentType}" is not allowed. Allowed: ${s3Config.allowedMimeTypes.join(", ")}.`, {
            fieldErrors: { contentType: ["invalid_content_type"] },
        });
    }
    // Sanitise filename
    const sanitisedName = sanitiseFileName(body.fileName);
    // Build S3 object key: deposit-receipts/<bookingSessionId>/<timestamp>-<filename>
    const timestamp = Date.now();
    const s3Key = `deposit-receipts/${session.id}/${timestamp}-${sanitisedName}`;
    // Generate presigned PUT URL using the AWS SDK
    const { S3Client, PutObjectCommand } = await Promise.resolve().then(() => __importStar(require("@aws-sdk/client-s3")));
    const { getSignedUrl } = await Promise.resolve().then(() => __importStar(require("@aws-sdk/s3-request-presigner")));
    const s3Client = new S3Client(buildS3ClientConfig(s3Config));
    const command = new PutObjectCommand({
        Bucket: s3Config.bucketName,
        Key: s3Key,
        ContentType: body.contentType,
        // Deliberately no ContentLength: SigV4 signs whatever headers are present,
        // so pinning it here would force the browser to upload exactly that many
        // bytes or get a 403 SignatureDoesNotMatch. The size cap is enforced on the
        // client before upload and again in /confirm against the stored object.
        Metadata: {
            "booking-session-id": session.id,
            "reservation-public-id": session.reservationPublicId,
        },
    });
    const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: s3Config.presignedPutExpirySeconds,
    });
    observability.logger.info("deposit_receipt_upload_url_generated", {
        bookingSessionId: session.id,
        s3Key,
        contentType: body.contentType,
        expiresInSeconds: s3Config.presignedPutExpirySeconds,
    });
    return (0, response_1.jsonResponse)(200, {
        uploadUrl: presignedUrl,
        s3Key,
        expiresInSeconds: s3Config.presignedPutExpirySeconds,
        maxFileSizeBytes: s3Config.maxFileSizeBytes,
    }, responseHeaders);
}
/**
 * Confirms a deposit receipt upload:
 * 1. Verifies the S3 object exists (HEAD request).
 * 2. Stores the S3 key on the booking session.
 * 3. Updates the Smoobu reservation notice to include the S3 link.
 */
async function handleDepositReceiptConfirm(body, config, responseHeaders, observability, authorizationHeader) {
    await requireDepositAccess(body.bookingSessionId, authorizationHeader, config);
    const s3Config = requireS3Config(config);
    const sessions = getBookingSessionRepository(config);
    const holds = getHoldRepository(config);
    const session = await sessions.getById(body.bookingSessionId);
    if (!session) {
        throw new errors_1.ApiError(404, "not_found", "Booking session was not found.");
    }
    // Verify the S3 key belongs to this booking session (prevent path traversal)
    if (!body.s3Key.startsWith(`deposit-receipts/${session.id}/`)) {
        throw new errors_1.ApiError(400, "invalid_s3_key", "The S3 key does not belong to this booking session.", {
            fieldErrors: { s3Key: ["invalid_s3_key"] },
        });
    }
    // Verify the object exists in S3
    const { S3Client, HeadObjectCommand } = await Promise.resolve().then(() => __importStar(require("@aws-sdk/client-s3")));
    const s3Client = new S3Client(buildS3ClientConfig(s3Config));
    let uploadedBytes;
    try {
        const head = await s3Client.send(new HeadObjectCommand({
            Bucket: s3Config.bucketName,
            Key: body.s3Key,
        }));
        uploadedBytes = head.ContentLength;
    }
    catch (err) {
        const errorName = err instanceof Error ? err.name : undefined;
        if (errorName === "NotFound" || errorName === "NoSuchKey") {
            throw new errors_1.ApiError(400, "upload_not_found", "The deposit receipt has not been uploaded yet. Please upload the file first.");
        }
        observability.logger.error("deposit_receipt_s3_head_failed", {
            bookingSessionId: session.id,
            s3Key: body.s3Key,
            error: err instanceof Error ? err.message : String(err),
        });
        throw new errors_1.ApiError(502, "storage_error", "Could not verify the deposit receipt upload.", { retryable: true });
    }
    // The presigned PUT cannot cap the upload size (see the note in the upload-url
    // handler), so enforce it here against what actually landed in the bucket.
    if (uploadedBytes !== undefined && uploadedBytes > s3Config.maxFileSizeBytes) {
        observability.logger.warn("deposit_receipt_too_large", {
            bookingSessionId: session.id,
            s3Key: body.s3Key,
            uploadedBytes,
            maxFileSizeBytes: s3Config.maxFileSizeBytes,
        });
        throw new errors_1.ApiError(400, "upload_too_large", `The deposit receipt exceeds the ${Math.floor(s3Config.maxFileSizeBytes / (1024 * 1024))} MB limit.`, { fieldErrors: { s3Key: ["upload_too_large"] } });
    }
    // Store the S3 key on the booking session
    const updatedSession = await sessions.setDepositReceiptS3Key({
        bookingSessionId: session.id,
        s3Key: body.s3Key,
    });
    // The bucket is private, so a plain object URL would 403 for staff. Presign a
    // GET instead — the link stays usable for presignedGetExpirySeconds.
    const s3Link = await presignReceiptDownload(s3Config, body.s3Key);
    // Update the Smoobu reservation notice with the deposit receipt link
    const hold = await holds.getByBookingSessionId(session.id).catch(() => undefined);
    let smoobuUpdated = false;
    if (hold?.smoobuReservationId) {
        try {
            const smoobuClient = await (0, smoobuClient_1.createSmoobuClient)(config);
            const noticeLines = [
                `Deposit receipt uploaded.`,
                `Reservation ID: ${session.reservationPublicId}`,
                `Receipt S3 link: ${s3Link}`,
                `Uploaded at: ${new Date().toISOString()}`,
            ];
            // If there's an existing guest message, include it
            if (session.guest?.message) {
                noticeLines.push(`Guest note: ${session.guest.message}`);
            }
            const notice = noticeLines.join("\n").slice(0, 2000);
            await smoobuClient.updateReservation(hold.smoobuReservationId, { notice }, observability);
            smoobuUpdated = true;
            observability.logger.info("deposit_receipt_smoobu_notice_updated", {
                bookingSessionId: session.id,
                smoobuReservationId: hold.smoobuReservationId,
                s3Key: body.s3Key,
            });
        }
        catch (err) {
            // Non-fatal: the receipt is stored in our DB even if Smoobu update fails.
            // The reconciliation worker or manual process can retry.
            observability.logger.error("deposit_receipt_smoobu_notice_update_failed", {
                bookingSessionId: session.id,
                smoobuReservationId: hold?.smoobuReservationId,
                s3Key: body.s3Key,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    else {
        observability.logger.warn("deposit_receipt_no_smoobu_reservation", {
            bookingSessionId: session.id,
            note: "No Smoobu reservation found for this booking session. Receipt stored locally only.",
        });
    }
    observability.logger.info("deposit_receipt_confirmed", {
        bookingSessionId: session.id,
        s3Key: body.s3Key,
        smoobuUpdated,
    });
    return (0, response_1.jsonResponse)(200, {
        confirmed: true,
        s3Key: body.s3Key,
        smoobuNoticeUpdated: smoobuUpdated,
        bookingSessionId: session.id,
        // Presigned so the guest can check what they uploaded, and so the staff
        // notification can carry a working link to a private object.
        receiptUrl: s3Link,
        receiptUrlExpiresInSeconds: s3Config.presignedGetExpirySeconds,
    }, responseHeaders);
}
function sanitiseFileName(name) {
    if (!name || name.length === 0) {
        return "receipt";
    }
    // Take only the basename (strip any path separators)
    const basename = name.replace(/^.*[\\/]/, "");
    // Truncate
    const truncated = basename.slice(0, MAX_FILENAME_LENGTH);
    // If it matches the safe pattern, use it as-is
    if (SAFE_FILENAME_RE.test(truncated)) {
        return truncated;
    }
    // Otherwise, replace unsafe characters with underscores
    return truncated.replace(/[^a-zA-Z0-9._-]/g, "_") || "receipt";
}
