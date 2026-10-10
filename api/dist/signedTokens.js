"use strict";
/**
 * signedTokens.ts
 *
 * HMAC-signed, self-contained tokens for flows that have no session:
 *
 *   deposit_access  — lets a guest attach a receipt to the booking they just
 *                     created, before it is confirmed and before they can log
 *                     into the portal.
 *   deposit_confirm — the one-click link emailed to staff to confirm a deposit
 *                     booking once the transfer lands.
 *   deposit_reject  — the same, to release the hold instead.
 *
 * Same envelope as portalSessions.ts (`header.payload.signature`, base64url,
 * HMAC-SHA256, timing-safe compare) but a distinct `typ` in the header, which is
 * compared verbatim during verification. That means a portal session token can
 * never be replayed against a staff route, or vice versa, even before the
 * signature is considered.
 *
 * The signing key is DERIVED from portalSessionSecret rather than being a new
 * secret. Adding a field to BookingProviderSecrets would put it in
 * REQUIRED_FIELDS, and any environment whose Secrets Manager entry lagged the
 * deploy would 503 the entire API. Derivation gives key separation with no
 * rotation choreography.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveSigningKey = deriveSigningKey;
exports.issueSignedToken = issueSignedToken;
exports.verifySignedToken = verifySignedToken;
exports.extractBearerToken = extractBearerToken;
const crypto_1 = require("crypto");
const errors_1 = require("./http/errors");
const HEADER_B64 = b64url(JSON.stringify({ alg: "HS256", typ: "KWL-signed" }));
/** Domain separation string — changing it invalidates every outstanding token. */
const KEY_DERIVATION_LABEL = "kwl-signed-token-v1";
function deriveSigningKey(portalSessionSecret) {
    return (0, crypto_1.createHmac)("sha256", portalSessionSecret).update(KEY_DERIVATION_LABEL).digest("base64url");
}
function issueSignedToken(input, portalSessionSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const payload = {
        sub: input.bookingSessionId,
        rid: input.reservationPublicId,
        act: input.purpose,
        jti: (0, crypto_1.randomUUID)(),
        iat: nowSeconds,
        exp: nowSeconds + input.ttlSeconds,
    };
    const payloadB64 = b64url(JSON.stringify(payload));
    const signingInput = `${HEADER_B64}.${payloadB64}`;
    const signature = hmacSha256(signingInput, deriveSigningKey(portalSessionSecret));
    return `${signingInput}.${signature}`;
}
/**
 * Verifies a token and asserts it was issued for one of `allowedPurposes`.
 * Throws 401 on any tampering, expiry, or purpose mismatch.
 */
function verifySignedToken(token, portalSessionSecret, allowedPurposes, nowSeconds = Math.floor(Date.now() / 1000)) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw invalidToken();
    }
    const [headerB64, payloadB64, providedSignature] = parts;
    // Rejects tokens from the portal-session family before any signature work.
    if (headerB64 !== HEADER_B64) {
        throw invalidToken();
    }
    const expected = hmacSha256(`${headerB64}.${payloadB64}`, deriveSigningKey(portalSessionSecret));
    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(providedSignature ?? "", "utf8");
    if (expectedBuf.length !== providedBuf.length || !(0, crypto_1.timingSafeEqual)(expectedBuf, providedBuf)) {
        throw invalidToken();
    }
    let parsed;
    try {
        parsed = JSON.parse(b64urlDecode(payloadB64));
    }
    catch {
        throw invalidToken();
    }
    if (!isSignedTokenPayload(parsed)) {
        throw invalidToken();
    }
    if (!allowedPurposes.includes(parsed.act)) {
        throw invalidToken();
    }
    if (nowSeconds >= parsed.exp) {
        throw new errors_1.ApiError(401, "token_expired", "This link has expired.");
    }
    return parsed;
}
/** Extracts a bearer token from an Authorization header value. */
function extractBearerToken(headerValue) {
    if (!headerValue) {
        return undefined;
    }
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    return match?.[1]?.trim() || undefined;
}
function isSignedTokenPayload(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return (typeof candidate.sub === "string" &&
        typeof candidate.rid === "string" &&
        (candidate.act === "deposit_access" ||
            candidate.act === "deposit_confirm" ||
            candidate.act === "deposit_reject") &&
        typeof candidate.jti === "string" &&
        typeof candidate.iat === "number" &&
        typeof candidate.exp === "number");
}
function invalidToken() {
    return new errors_1.ApiError(401, "invalid_token", "This link is not valid.");
}
function hmacSha256(input, secret) {
    return (0, crypto_1.createHmac)("sha256", secret).update(input).digest("base64url");
}
function b64url(input) {
    return Buffer.from(input, "utf8").toString("base64url");
}
function b64urlDecode(input) {
    return Buffer.from(input, "base64url").toString("utf8");
}
