"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
// ─── Race-condition regression: stale idempotency-lock window (R5) ────────────
describe("loadConfig — idempotency lock window validation (R5)", () => {
    it("accepts the defaults", () => {
        expect(() => (0, config_1.loadConfig)({})).not.toThrow();
    });
    it("throws when the stale-lock window is shorter than the worst-case Smoobu round-trip", () => {
        // 5s lock vs. default 8s timeout × (3 retries + 1) × 2 + margin → misconfigured.
        expect(() => (0, config_1.loadConfig)({ BOOKING_API_STALE_IDEMPOTENCY_LOCK_SECONDS: "5" })).toThrow(/STALE_IDEMPOTENCY_LOCK/);
    });
    it("accepts a small stale-lock window when Smoobu timeouts are correspondingly small", () => {
        expect(() => (0, config_1.loadConfig)({
            BOOKING_API_STALE_IDEMPOTENCY_LOCK_SECONDS: "30",
            SMOOBU_TIMEOUT_MS: "1000",
            SMOOBU_MAX_RETRIES: "0",
        })).not.toThrow();
    });
});
