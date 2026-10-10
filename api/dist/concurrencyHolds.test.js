"use strict";
/**
 * C23 — Concurrency test: simultaneous hold creation for the same property
 *
 * Fires two POST /api/holds requests for the same property and dates using
 * Promise.all to verify that only one succeeds and the other receives 409
 * property_no_longer_available.
 *
 * The in-memory repository enforces this via an overlap scan on insertion,
 * mirroring the behaviour of the RDS exclusion constraint
 * (holds_no_overlapping_active_inventory). The RDS constraint path is
 * exercised separately in holds.test.ts via the mapHoldInsertError tests.
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
const app_1 = require("./app");
const bookingSessions_1 = require("./bookingSessions");
const holds_1 = require("./holds");
const payments_1 = require("./payments");
const secrets_1 = require("./secrets");
// ── test config ───────────────────────────────────────────────────────────────
let bookingSessions;
let holds;
const originalFetch = global.fetch;
function createTestConfig() {
    bookingSessions = new bookingSessions_1.InMemoryBookingSessionRepository();
    holds = new holds_1.InMemoryHoldRepository();
    return {
        allowedOrigins: ["https://booking.test"],
        maxBodyBytes: 64 * 1024,
        secrets: new secrets_1.StaticSecretProvider({
            smoobuApiKey: "smoobu-secret-value",
            smoobuApiSecret: "smoobu-api-secret-value",
            smoobuWebhookSecret: "smoobu-webhook-secret-value",
            paypalClientId: "paypal-client-id-value",
            paypalClientSecret: "paypal-client-secret-value",
            paypalWebhookId: "paypal-webhook-id-value",
            bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
            portalSessionSecret: "portal-session-secret-value",
            rdsConnectionString: "postgres://booking_user:pw@db.test:5432/booking_engine",
        }),
        smoobu: {
            baseUrl: "https://login.smoobu.com",
            customerId: 9,
            timeoutMs: 8000,
            maxRetries: 0,
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
        bookingSessions,
        holds,
        payments: new payments_1.InMemoryPaymentRepository(),
        hold: {
            defaultTtlMinutes: 60,
            idempotencyTtlMinutes: 1440,
            staleIdempotencyLockSeconds: 120,
        },
        abuseProtection: { enabled: false, captchaChallengesEnabled: false, maxTrackedBuckets: 100 },
        email: { fromAddress: "test@example.com", region: "us-east-1", disabled: true },
        observability: { serviceName: "booking-api", environment: "test", logLevel: "silent", metricsEnabled: false },
    };
}
function happySmoobuFetch() {
    return jest.fn(async (url) => {
        const { pathname } = new URL(url.toString());
        const body = pathname === "/booking/checkApartmentAvailability"
            ? { availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} }
            : { id: 9900099 };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    });
}
function searchEvent(deviceId) {
    return {
        version: "2.0",
        rawPath: "/api/search",
        headers: {
            "content-type": "application/json",
            origin: "https://booking.test",
            "x-booking-device-id": deviceId,
        },
        body: JSON.stringify({ arrivalDate: "2099-09-01", departureDate: "2099-09-05", guests: 2, language: "en", source: "booking_page" }),
        requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.10" } },
    };
}
function holdEvent(body, idempotencyKey, ip) {
    return {
        version: "2.0",
        rawPath: "/api/holds",
        headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            origin: "https://booking.test",
            "x-booking-device-id": idempotencyKey,
        },
        body: JSON.stringify(body),
        requestContext: { http: { method: "POST", path: "/api/holds", sourceIp: ip } },
    };
}
// ── setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-01T10:00:00Z"));
});
afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
});
// ── concurrency tests ─────────────────────────────────────────────────────────
test("simultaneous holds for the same property and dates: exactly one succeeds and one gets 409", async () => {
    global.fetch = happySmoobuFetch();
    const config = createTestConfig();
    const handler = (0, app_1.createBookingApiHandler)(config);
    // User A and User B search independently and both see the property as available
    const [searchA, searchB] = await Promise.all([
        handler(searchEvent("device-concurrent-A")),
        handler(searchEvent("device-concurrent-B")),
    ]);
    expect(searchA.statusCode).toBe(200);
    expect(searchB.statusCode).toBe(200);
    const bodyA = JSON.parse(searchA.body);
    const bodyB = JSON.parse(searchB.body);
    const propertyId = bodyA.properties[0].propertyId;
    // Both quotes target the same property
    expect(bodyB.properties[0].propertyId).toBe(propertyId);
    const holdRequestA = {
        quoteId: bodyA.quoteId,
        bookingSessionId: bodyA.bookingSessionId,
        propertyId,
        paymentMethod: "paypal",
        guest: { firstName: "Alice", lastName: "A", email: "alice@example.com" },
        portalPassword: "alice-secure-password",
        termsAccepted: true,
    };
    const holdRequestB = {
        quoteId: bodyB.quoteId,
        bookingSessionId: bodyB.bookingSessionId,
        propertyId,
        paymentMethod: "paypal",
        guest: { firstName: "Bob", lastName: "B", email: "bob@example.com" },
        portalPassword: "bob-secure-password",
        termsAccepted: true,
    };
    // Fire both hold requests simultaneously
    const [respA, respB] = await Promise.all([
        handler(holdEvent(holdRequestA, "concurrent-idem-A-0001", "203.0.113.11")),
        handler(holdEvent(holdRequestB, "concurrent-idem-B-0001", "203.0.113.12")),
    ]);
    const statuses = [respA.statusCode, respB.statusCode].sort((a, b) => a - b);
    // Exactly one must succeed and exactly one must be rejected
    expect(statuses).toEqual([200, 409]);
    // The 409 response must carry the property_no_longer_available code
    const failed = respA.statusCode === 409 ? respA : respB;
    expect(JSON.parse(failed.body).error.code).toBe("property_no_longer_available");
    // Only one Smoobu reservation should have been created
    const smoobuReservationCalls = global.fetch.mock.calls.filter(([url]) => new URL(url.toString()).pathname === "/api/reservations");
    expect(smoobuReservationCalls).toHaveLength(1);
    // The hold store should contain exactly one active hold for the property
    const successResp = respA.statusCode === 200 ? respA : respB;
    const { booking } = JSON.parse(successResp.body);
    const storedHold = await holds.getByBookingSessionId(booking.bookingSessionId);
    expect(storedHold?.status).toBe("active");
    expect(storedHold?.propertyId).toBe(propertyId);
});
test("simultaneous holds for non-overlapping dates both succeed", async () => {
    global.fetch = jest.fn(async (url) => {
        const { pathname } = new URL(url.toString());
        const id = pathname === "/api/reservations" ? (pathname.includes("A") ? 9900101 : 9900102) : undefined;
        const body = pathname === "/booking/checkApartmentAvailability"
            ? { availableApartments: [100001], prices: { "100001": { price: 510, currency: "USD" } }, errorMessages: {} }
            : { id: id ?? 9900103 };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const config = createTestConfig();
    const handler = (0, app_1.createBookingApiHandler)(config);
    // User A searches for Aug 1–5, User B for Aug 10–14 (no overlap)
    const searchAResp = await handler({
        version: "2.0",
        rawPath: "/api/search",
        headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "dev-nonoverlap-A" },
        body: JSON.stringify({ arrivalDate: "2099-08-01", departureDate: "2099-08-05", guests: 2, language: "en", source: "booking_page" }),
        requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.20" } },
    });
    const searchBResp = await handler({
        version: "2.0",
        rawPath: "/api/search",
        headers: { "content-type": "application/json", origin: "https://booking.test", "x-booking-device-id": "dev-nonoverlap-B" },
        body: JSON.stringify({ arrivalDate: "2099-08-10", departureDate: "2099-08-14", guests: 2, language: "en", source: "booking_page" }),
        requestContext: { http: { method: "POST", path: "/api/search", sourceIp: "203.0.113.21" } },
    });
    const bA = JSON.parse(searchAResp.body);
    const bB = JSON.parse(searchBResp.body);
    const [holdA, holdB] = await Promise.all([
        handler(holdEvent({ quoteId: bA.quoteId, bookingSessionId: bA.bookingSessionId, propertyId: bA.properties[0].propertyId,
            paymentMethod: "paypal", guest: { firstName: "Alice", lastName: "A", email: "alice@example.com" },
            portalPassword: "alice-secure-passphrase", termsAccepted: true }, "nonoverlap-idem-A-0001", "203.0.113.20")),
        handler(holdEvent({ quoteId: bB.quoteId, bookingSessionId: bB.bookingSessionId, propertyId: bB.properties[0].propertyId,
            paymentMethod: "paypal", guest: { firstName: "Bob", lastName: "B", email: "bob@example.com" },
            portalPassword: "bob-secure-passphrase", termsAccepted: true }, "nonoverlap-idem-B-0001", "203.0.113.21")),
    ]);
    expect(holdA.statusCode).toBe(200);
    expect(holdB.statusCode).toBe(200);
});
test("RDS overlap constraint error (23P01) is mapped to 409 property_no_longer_available", async () => {
    const { RdsHoldRepository } = await Promise.resolve().then(() => __importStar(require("./holds")));
    const query = jest.fn(async () => {
        throw { code: "23P01", constraint: "holds_no_overlapping_active_inventory" };
    });
    const repo = new RdsHoldRepository({ query });
    await expect(repo.createCreatingHold({
        bookingSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        propertyId: "11111111-0000-4000-8000-000000000001",
        arrivalDate: "2099-09-01",
        departureDate: "2099-09-05",
        expiresAt: "2026-06-01T11:00:00.000Z",
        smoobuChannelId: 11,
        smoobuCreatePayloadHash: "hash-concurrent",
    })).rejects.toMatchObject({
        statusCode: 409,
        code: "property_no_longer_available",
        retryable: false,
    });
});
// ─── Race-condition regression: orphaned Smoobu reservation cleanup (R4) ──────
test("R4: cancels the just-created Smoobu reservation when hold activation fails", async () => {
    const fetchFn = happySmoobuFetch();
    global.fetch = fetchFn;
    const config = createTestConfig();
    // Simulate the DB failing right after the Smoobu reservation was created.
    jest.spyOn(holds, "activateHold").mockRejectedValue(new Error("db unavailable"));
    const handler = (0, app_1.createBookingApiHandler)(config);
    const search = await handler(searchEvent("device-r4"));
    const body = JSON.parse(search.body);
    const holdRequest = {
        quoteId: body.quoteId,
        bookingSessionId: body.bookingSessionId,
        propertyId: body.properties[0].propertyId,
        paymentMethod: "paypal",
        guest: { firstName: "Ana", lastName: "Mora", email: "ana@example.com" },
        portalPassword: "correct horse battery staple",
        termsAccepted: true,
    };
    const resp = await handler(holdEvent(holdRequest, "r4-idempotency-key-000001", "203.0.113.9"));
    expect(resp.statusCode).toBeGreaterThanOrEqual(500);
    // The reservation created on Smoobu (id 9900099) must be cancelled in the catch.
    const deleteCall = fetchFn.mock.calls.find(([url, init]) => String(init?.method ?? "").toUpperCase() === "DELETE" &&
        new URL(url.toString()).pathname === "/api/reservations/9900099");
    expect(deleteCall).toBeDefined();
});
