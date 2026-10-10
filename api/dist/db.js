"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPoolConfig = createPoolConfig;
exports.createPoolFromSecrets = createPoolFromSecrets;
exports.getPool = getPool;
exports.checkPoolHealth = checkPoolHealth;
exports.closePool = closePool;
const pg_1 = require("pg");
const errors_1 = require("./http/errors");
const rdsCaBundle_1 = require("./rdsCaBundle");
const secrets_1 = require("./secrets");
const HEALTH_CHECK_SQL = "SELECT 1";
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];
let activePool;
let activePoolPromise;
let shutdownHookRegistered = false;
function createPoolConfig(connectionString, overrides = {}) {
    return {
        ...overrides,
        connectionString,
        // RDS server certificates chain to an Amazon RDS regional CA, which is not
        // in Node's default trust store, so rejectUnauthorized alone fails every
        // connection with SELF_SIGNED_CERT_IN_CHAIN. RDS_CA_BUNDLE supplies the
        // full combined RDS CA bundle so verification succeeds for real.
        ssl: isDatabaseTlsDisabled() ? false : { rejectUnauthorized: true, ca: rdsCaBundle_1.RDS_CA_BUNDLE },
    };
}
/**
 * Local-only escape hatch: the docker-compose Postgres speaks plaintext, so TLS
 * verification would fail before a single query ran. Mirrors the existing
 * BOOKING_API_MIGRATION_SSL flag used by scripts/migrate.js.
 *
 * Requires the exact string "false" — an unset, empty, or malformed value keeps
 * TLS on, so this can never be disabled by accident in a deployed environment.
 */
function isDatabaseTlsDisabled() {
    return process.env.BOOKING_API_DB_SSL?.trim().toLowerCase() === "false";
}
async function createPoolFromSecrets(secretProvider, poolConfig = {}) {
    const { rdsConnectionString } = await secretProvider.getSecrets();
    return new pg_1.Pool(createPoolConfig(rdsConnectionString, poolConfig));
}
async function getPool(options = {}) {
    if (!activePoolPromise) {
        activePoolPromise = initializePool(options);
    }
    return activePoolPromise;
}
async function checkPoolHealth(pool) {
    try {
        await pool.query(HEALTH_CHECK_SQL);
    }
    catch (error) {
        throw databaseUnavailable("database_health_check_failed", "Database health check failed.", error);
    }
}
async function closePool() {
    const pool = activePool;
    activePool = undefined;
    activePoolPromise = undefined;
    if (pool) {
        await pool.end();
    }
}
async function initializePool(options) {
    const secretProvider = options.secretProvider ?? (0, secrets_1.createSecretProvider)();
    const pool = await createPoolFromSecrets(secretProvider, options.poolConfig);
    try {
        if (options.healthCheck !== false) {
            await checkPoolHealth(pool);
        }
    }
    catch (error) {
        await closeCreatedPool(pool);
        activePool = undefined;
        activePoolPromise = undefined;
        throw error;
    }
    activePool = pool;
    if (options.registerShutdownHook !== false) {
        registerGracefulShutdownHook();
    }
    return pool;
}
function registerGracefulShutdownHook() {
    if (shutdownHookRegistered) {
        return;
    }
    shutdownHookRegistered = true;
    for (const signal of SHUTDOWN_SIGNALS) {
        process.once(signal, () => {
            void closePool().catch((error) => {
                // eslint-disable-next-line no-console
                console.error("[booking-api] Failed to close PostgreSQL pool during shutdown.", error);
            });
        });
    }
    process.once("beforeExit", () => {
        void closePool().catch((error) => {
            // eslint-disable-next-line no-console
            console.error("[booking-api] Failed to close PostgreSQL pool before exit.", error);
        });
    });
}
async function closeCreatedPool(pool) {
    try {
        await pool.end();
    }
    catch {
        // Ignore shutdown failures after an initialization failure; the original
        // connection/health-check error is the useful failure for callers.
    }
}
function databaseUnavailable(code, message, cause) {
    if (cause instanceof errors_1.ApiError) {
        return cause;
    }
    return new errors_1.ApiError(503, code, message, { retryable: true });
}
