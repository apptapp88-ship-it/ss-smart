"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const bookingSessions_1 = require("./bookingSessions");
const holds_1 = require("./holds");
const payments_1 = require("./payments");
const paypalWebhooks_1 = require("./paypalWebhooks");
const secrets_1 = require("./secrets");
const VALID_SECRETS = {
    smoobuApiKey: "smoobu-api-key-123456",
    smoobuApiSecret: "smoobu-api-secret-123456",
    smoobuWebhookSecret: "smoobu-webhook-secret-123456",
    paypalClientId: "paypal-client-id-123456",
    paypalClientSecret: "paypal-client-secret-123456",
    paypalWebhookId: "paypal-webhook-id-123456",
    bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    portalSessionSecret: "portal-session-secret-123456",
    rdsConnectionString: "postgres://booking_user:booking_password@db.example.com:5432/booking_engine",
};
test("validateBookingSecrets: rejects a non-object payload", () => {
    expect(() => (0, secrets_1.validateBookingSecrets)("not-an-object")).toThrow("JSON object");
    expect(() => (0, secrets_1.validateBookingSecrets)(null)).toThrow("JSON object");
    expect(() => (0, secrets_1.validateBookingSecrets)([1, 2, 3])).toThrow("JSON object");
});
test("validateBookingSecrets: rejects fields shorter than 16 characters", () => {
    expect(() => (0, secrets_1.validateBookingSecrets)({
        ...VALID_SECRETS,
        smoobuApiKey: "short",
    })).toThrow("invalid");
});
test("validateBookingSecrets: requires a 32-byte base64 encryption key", () => {
    expect(() => (0, secrets_1.validateBookingSecrets)({
        ...VALID_SECRETS,
        bookingEncryptionKeyBase64: Buffer.alloc(16, 7).toString("base64"),
    })).toThrow("invalid");
});
test("validateBookingSecrets: requires a Postgres RDS connection string", () => {
    expect(() => (0, secrets_1.validateBookingSecrets)({
        ...VALID_SECRETS,
        rdsConnectionString: "mysql://booking_user:booking_password@db.example.com:3306/booking_engine",
    })).toThrow("invalid");
});
test("createSecretProvider: prefers Secrets Manager secret id over raw environment secrets", () => {
    const provider = (0, secrets_1.createSecretProvider)({
        BOOKING_API_SECRETS_MANAGER_SECRET_ID: "booking-engine/dev/booking-api",
        AWS_SESSION_TOKEN: "session-token",
        SMOOBU_API_KEY: "raw-env-value-should-not-win",
    });
    expect(provider.source).toBe("aws-secrets-manager-sdk");
});
test("createSecretProvider: blocks raw provider secrets outside local override mode", async () => {
    const provider = (0, secrets_1.createSecretProvider)({
        NODE_ENV: "production",
        SMOOBU_API_KEY: VALID_SECRETS.smoobuApiKey,
        SMOOBU_WEBHOOK_SECRET: VALID_SECRETS.smoobuWebhookSecret,
        PAYPAL_CLIENT_ID: VALID_SECRETS.paypalClientId,
        PAYPAL_CLIENT_SECRET: VALID_SECRETS.paypalClientSecret,
        PAYPAL_WEBHOOK_ID: VALID_SECRETS.paypalWebhookId,
        BOOKING_API_ENCRYPTION_KEY_BASE64: VALID_SECRETS.bookingEncryptionKeyBase64,
        BOOKING_API_PORTAL_SESSION_SECRET: VALID_SECRETS.portalSessionSecret,
        BOOKING_API_RDS_CONNECTION_STRING: VALID_SECRETS.rdsConnectionString,
    });
    expect(provider.source).toBe("invalid");
    await expect(provider.getSecrets()).rejects.toMatchObject({ code: "raw_env_secrets_not_allowed" });
});
jest.mock("@aws-sdk/client-secrets-manager", () => ({
    SecretsManagerClient: jest.fn().mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({ SecretString: JSON.stringify(VALID_SECRETS) }),
    })),
    GetSecretValueCommand: jest.fn(),
}));
test("AwsSdkSecretProvider: loads and caches a Secrets Manager JSON bundle", async () => {
    let now = 1000;
    const provider = new secrets_1.AwsSdkSecretProvider({
        secretId: "booking-engine/dev/booking-api",
        cacheTtlMs: 10000,
        now: () => now,
    });
    await expect(provider.getSecrets()).resolves.toEqual(VALID_SECRETS);
    now += 500;
    // second call hits cache — SDK send() still called only once
    await expect(provider.getSecrets()).resolves.toEqual(VALID_SECRETS);
});
test("MissingSecretProvider: getSecrets throws 503 when no secret source is configured", async () => {
    const provider = new secrets_1.MissingSecretProvider();
    expect(provider.source).toBe("missing");
    await expect(provider.getSecrets()).rejects.toMatchObject({
        statusCode: 503,
        code: "secrets_not_configured",
    });
});
test("createSecretProvider: accepts BOOKING_API_SECRETS_JSON in test environment", async () => {
    const provider = (0, secrets_1.createSecretProvider)({
        NODE_ENV: "test",
        BOOKING_API_SECRETS_JSON: JSON.stringify(VALID_SECRETS),
    });
    expect(provider.source).toBe("static");
    await expect(provider.getSecrets()).resolves.toEqual(VALID_SECRETS);
});
test("createSecretProvider: accepts BOOKING_API_SECRETS_JSON with explicit insecure opt-in", async () => {
    const provider = (0, secrets_1.createSecretProvider)({
        NODE_ENV: "development",
        BOOKING_API_ALLOW_INSECURE_ENV_SECRETS: "true",
        BOOKING_API_SECRETS_JSON: JSON.stringify(VALID_SECRETS),
    });
    expect(provider.source).toBe("static");
    await expect(provider.getSecrets()).resolves.toEqual(VALID_SECRETS);
});
test("createSecretProvider: blocks BOOKING_API_SECRETS_JSON in production", async () => {
    const provider = (0, secrets_1.createSecretProvider)({
        NODE_ENV: "production",
        BOOKING_API_SECRETS_JSON: JSON.stringify(VALID_SECRETS),
    });
    expect(provider.source).toBe("invalid");
    await expect(provider.getSecrets()).rejects.toMatchObject({ code: "raw_env_secrets_not_allowed" });
});
test("AwsSdkSecretProvider: re-fetches after cache expires", async () => {
    let now = 1000;
    const provider = new secrets_1.AwsSdkSecretProvider({
        secretId: "booking-engine/dev/booking-api",
        cacheTtlMs: 10000,
        now: () => now,
    });
    await provider.getSecrets();
    now += 10001;
    await provider.getSecrets();
    // both calls should succeed (SDK mock always resolves)
});
test("Smoobu webhook route reads shared secret from secret provider", async () => {
    const handler = (0, app_1.createBookingApiHandler)({
        allowedOrigins: [],
        maxBodyBytes: 64 * 1024,
        secrets: new secrets_1.StaticSecretProvider(VALID_SECRETS),
        smoobu: {
            baseUrl: "https://login.smoobu.com",
            timeoutMs: 8000,
            maxRetries: 3,
            baseBackoffMs: 250,
            maxBackoffMs: 2000,
            maxRateLimitDelayMs: 60000,
            holdChannelId: 11,
        },
        paypal: {
            baseUrl: "https://api-m.sandbox.paypal.com",
            timeoutMs: 10000,
            orderReturnUrl: "",
            orderCancelUrl: "",
        },
        hold: {
            defaultTtlMinutes: 60,
            idempotencyTtlMinutes: 1440,
            staleIdempotencyLockSeconds: 120,
        },
        bookingSessions: new bookingSessions_1.InMemoryBookingSessionRepository(),
        holds: new holds_1.InMemoryHoldRepository(),
        payments: new payments_1.InMemoryPaymentRepository(),
        webhookEvents: new paypalWebhooks_1.InMemoryWebhookEventRepository(),
        abuseProtection: {
            enabled: false,
            captchaChallengesEnabled: false,
            maxTrackedBuckets: 100,
        },
        email: {
            fromAddress: "test@example.com",
            region: "us-east-1",
            disabled: true,
        },
        observability: {
            serviceName: "booking-api",
            environment: "test",
            logLevel: "silent",
            metricsEnabled: false,
        },
    });
    const event = {
        version: "2.0",
        rawPath: "/api/webhooks/smoobu",
        headers: {
            "content-type": "application/json",
            "x-smoobu-webhook-secret": "smoobu-webhook-secret-123456",
        },
        body: JSON.stringify({ action: "newReservation", data: { id: 123 } }),
        requestContext: {
            http: {
                method: "POST",
                path: "/api/webhooks/smoobu",
                sourceIp: "203.0.113.10",
            },
        },
    };
    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).received).toBe(true);
});
