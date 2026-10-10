"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbuseGuard = void 0;
exports.verifyCaptchaToken = verifyCaptchaToken;
const crypto_1 = require("crypto");
const errors_1 = require("./http/errors");
const request_1 = require("./http/request");
// ---------------------------------------------------------------------------
// CAPTCHA verification
// ---------------------------------------------------------------------------
const HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";
const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const CAPTCHA_VERIFY_TIMEOUT_MS = 5000;
/**
 * Verifies a CAPTCHA token against the configured provider (hCaptcha or reCAPTCHA).
 * Returns true if the token is valid, false on any failure (network error, timeout,
 * non-200 response, malformed JSON, or success !== true).
 */
async function verifyCaptchaToken(token, cfg, clientIp, secretKeyOverride) {
    const secretKey = secretKeyOverride ?? cfg.secretKey;
    if (!secretKey) {
        return false;
    }
    const url = cfg.verifyUrl ??
        (cfg.provider === "hcaptcha" ? HCAPTCHA_VERIFY_URL : RECAPTCHA_VERIFY_URL);
    const params = new URLSearchParams({ secret: secretKey, response: token });
    if (clientIp) {
        params.set("remoteip", clientIp);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CAPTCHA_VERIFY_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
            signal: ac.signal,
        });
        if (!response.ok) {
            return false;
        }
        const json = (await response.json());
        return json.success === true;
    }
    catch {
        // Covers AbortError (timeout), network errors, and JSON parse failures.
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
const DEFAULT_POLICIES = {
    publicRead: {
        name: "publicRead",
        rules: [
            { scope: "ip", limit: 120, windowSeconds: 60 },
            { scope: "device", limit: 80, windowSeconds: 60 },
        ],
    },
    availabilitySearch: {
        name: "availabilitySearch",
        rules: [
            { scope: "ip", limit: 30, windowSeconds: 60, captchaAfter: 20 },
            { scope: "device", limit: 20, windowSeconds: 60, captchaAfter: 14 },
        ],
    },
    holdCreate: {
        name: "holdCreate",
        rules: [
            { scope: "ip", limit: 8, windowSeconds: 15 * 60, captchaAfter: 3 },
            { scope: "device", limit: 5, windowSeconds: 15 * 60, captchaAfter: 2 },
        ],
    },
    paymentCreate: {
        name: "paymentCreate",
        rules: [
            { scope: "ip", limit: 12, windowSeconds: 10 * 60, captchaAfter: 5 },
            { scope: "device", limit: 8, windowSeconds: 10 * 60, captchaAfter: 4 },
        ],
    },
    paymentCapture: {
        name: "paymentCapture",
        rules: [
            { scope: "ip", limit: 20, windowSeconds: 10 * 60 },
            { scope: "device", limit: 12, windowSeconds: 10 * 60 },
        ],
    },
    depositEvent: {
        name: "depositEvent",
        rules: [
            { scope: "ip", limit: 20, windowSeconds: 10 * 60 },
            { scope: "device", limit: 10, windowSeconds: 10 * 60 },
        ],
    },
    webhook: {
        name: "webhook",
        rules: [{ scope: "ip", limit: 300, windowSeconds: 60 }],
    },
    portalLogin: {
        name: "portalLogin",
        rules: [
            { scope: "ip", limit: 10, windowSeconds: 5 * 60 },
            { scope: "device", limit: 5, windowSeconds: 5 * 60 },
        ],
    },
    portalRead: {
        name: "portalRead",
        rules: [
            { scope: "ip", limit: 60, windowSeconds: 60 },
            { scope: "device", limit: 40, windowSeconds: 60 },
        ],
    },
    portalWrite: {
        name: "portalWrite",
        rules: [
            { scope: "ip", limit: 12, windowSeconds: 10 * 60 },
            { scope: "device", limit: 8, windowSeconds: 10 * 60 },
        ],
    },
};
class AbuseGuard {
    constructor(config, now = Date.now, secrets) {
        this.config = config;
        this.now = now;
        this.store = new InMemoryRateLimitStore(config.maxTrackedBuckets, now);
        this.secrets = secrets;
    }
    /**
     * Returns the CAPTCHA verification secret, preferring an explicitly configured
     * value and otherwise reading it from the combined Secrets Manager entry. The
     * secret provider caches its own fetches, so this only memoises the lookup.
     */
    async resolveCaptchaSecretKey() {
        if (this.config.captchaVerifier?.secretKey) {
            return this.config.captchaVerifier.secretKey;
        }
        if (this.resolvedSecretKey) {
            return this.resolvedSecretKey;
        }
        if (!this.secrets) {
            return undefined;
        }
        try {
            const { captchaSecretKey } = await this.secrets.getSecrets();
            this.resolvedSecretKey = captchaSecretKey;
            return captchaSecretKey;
        }
        catch {
            // A secrets outage must not turn a CAPTCHA challenge into a 500 — fail closed.
            return undefined;
        }
    }
    async assertAllowed(request, policyName) {
        if (!this.config.enabled || !policyName) {
            return;
        }
        const policy = DEFAULT_POLICIES[policyName];
        const nowMs = this.now();
        const results = policy.rules.map((rule) => this.consumeRule(policy, rule, request, nowMs));
        applyRateLimitHeaders(request.responseHeaders, policy, results, nowMs);
        const exceeded = results.find(({ rule, count }) => count > rule.limit);
        if (exceeded) {
            const retryAfterSeconds = secondsUntil(exceeded.resetAtMs, nowMs);
            request.responseHeaders["Retry-After"] = String(retryAfterSeconds);
            throw new errors_1.ApiError(429, "rate_limited", "Too many requests. Please try again later.", {
                retryable: true,
            });
        }
        const captchaRequired = results.find(({ rule, count }) => this.config.captchaChallengesEnabled &&
            typeof rule.captchaAfter === "number" &&
            count > rule.captchaAfter);
        if (!captchaRequired) {
            return;
        }
        // If the client supplied a token, attempt to verify it against the provider.
        // A verified token allows the request through (CAPTCHA bypass path).
        // Any verification error (network, timeout, parse) is treated as a failed check
        // so the safe default (403) is preserved and no exception leaks to the caller.
        const inboundToken = (0, request_1.getHeader)(request.headers, "x-captcha-token");
        if (inboundToken && this.config.captchaVerifier) {
            let valid = false;
            try {
                const secretKey = await this.resolveCaptchaSecretKey();
                if (!secretKey) {
                    request.observability?.logger.warn("captcha_verify_secret_unavailable", {
                        provider: this.config.captchaVerifier.provider,
                    });
                }
                valid = await verifyCaptchaToken(inboundToken, this.config.captchaVerifier, request.clientIp ?? undefined, secretKey);
            }
            catch (err) {
                // verifyCaptchaToken already swallows most errors internally; this is a
                // last-resort guard. Log and fall through to the 403 below.
                request.observability?.logger.warn("captcha_verify_unexpected_error", { error: err });
            }
            if (valid) {
                // Token verified — allow the request through without setting challenge headers.
                return;
            }
            // Invalid or unverifiable token: fall through to the 403 so the client retries.
        }
        request.responseHeaders["X-Captcha-Required"] = "true";
        request.responseHeaders["X-Captcha-Policy"] = policy.name;
        request.responseHeaders["X-Captcha-Window-Seconds"] = String(captchaRequired.rule.windowSeconds);
        throw new errors_1.ApiError(403, "captcha_required", "Please complete the CAPTCHA challenge before continuing.", {
            fieldErrors: {
                captchaToken: ["captcha_required"],
            },
        });
    }
    consumeRule(policy, rule, request, nowMs) {
        const identity = rule.scope === "ip" ? getIpIdentity(request) : getDeviceIdentity(request);
        const key = `${policy.name}:${rule.scope}:${hashIdentity(identity)}:${rule.windowSeconds}`;
        const bucket = this.store.increment(key, rule.windowSeconds, nowMs);
        return {
            rule,
            count: bucket.count,
            resetAtMs: bucket.resetAtMs,
        };
    }
}
exports.AbuseGuard = AbuseGuard;
class InMemoryRateLimitStore {
    constructor(maxBuckets, now) {
        this.maxBuckets = maxBuckets;
        this.now = now;
        this.buckets = new Map();
    }
    increment(key, windowSeconds, nowMs) {
        const existing = this.buckets.get(key);
        const windowMs = windowSeconds * 1000;
        if (!existing || existing.resetAtMs <= nowMs) {
            const bucket = { count: 1, resetAtMs: nowMs + windowMs };
            this.buckets.set(key, bucket);
            this.pruneIfNeeded();
            return bucket;
        }
        existing.count += 1;
        return existing;
    }
    pruneIfNeeded() {
        if (this.buckets.size <= this.maxBuckets) {
            return;
        }
        const nowMs = this.now();
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAtMs <= nowMs) {
                this.buckets.delete(key);
            }
        }
        while (this.buckets.size > this.maxBuckets) {
            const oldestKey = this.buckets.keys().next().value;
            if (!oldestKey) {
                return;
            }
            this.buckets.delete(oldestKey);
        }
    }
}
function getIpIdentity(request) {
    return request.clientIp ?? "missing-ip";
}
function getDeviceIdentity(request) {
    const explicitDeviceId = (0, request_1.getHeader)(request.headers, "x-booking-device-id") ?? (0, request_1.getHeader)(request.headers, "x-device-id");
    if (explicitDeviceId && /^[A-Za-z0-9._:-]{8,128}$/.test(explicitDeviceId)) {
        return `device:${explicitDeviceId}`;
    }
    const acceptLanguage = (0, request_1.getHeader)(request.headers, "accept-language") ?? "";
    return `fingerprint:${request.userAgent ?? "missing-user-agent"}:${acceptLanguage}`;
}
function hashIdentity(identity) {
    return (0, crypto_1.createHash)("sha256").update(identity).digest("hex").slice(0, 32);
}
function applyRateLimitHeaders(headers, policy, results, nowMs) {
    const tightest = results.reduce((current, candidate) => {
        const currentRemaining = current.rule.limit - current.count;
        const candidateRemaining = candidate.rule.limit - candidate.count;
        return candidateRemaining < currentRemaining ? candidate : current;
    });
    headers["X-RateLimit-Policy"] = policy.name;
    headers["X-RateLimit-Limit"] = String(tightest.rule.limit);
    headers["X-RateLimit-Remaining"] = String(Math.max(0, tightest.rule.limit - tightest.count));
    headers["X-RateLimit-Reset"] = String(Math.ceil(tightest.resetAtMs / 1000));
    const retryAfterSeconds = secondsUntil(tightest.resetAtMs, nowMs);
    headers["X-RateLimit-Reset-After"] = String(retryAfterSeconds);
}
function secondsUntil(resetAtMs, nowMs) {
    return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}
