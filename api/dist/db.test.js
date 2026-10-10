"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mockPools = [];
jest.mock("pg", () => ({
    Pool: jest.fn((config) => {
        const pool = {
            config,
            query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
            end: jest.fn().mockResolvedValue(undefined),
        };
        mockPools.push(pool);
        return pool;
    }),
}));
const pg_1 = require("pg");
const db_1 = require("./db");
const rdsCaBundle_1 = require("./rdsCaBundle");
const secrets_1 = require("./secrets");
const CONNECTION_STRING = "postgres://booking_user:booking_password@db.example.com:5432/booking_engine";
const VALID_SECRETS = {
    smoobuApiKey: "smoobu-api-key-123456",
    smoobuApiSecret: "smoobu-api-secret-123456",
    smoobuWebhookSecret: "smoobu-webhook-secret-123456",
    paypalClientId: "paypal-client-id-123456",
    paypalClientSecret: "paypal-client-secret-123456",
    paypalWebhookId: "paypal-webhook-id-123456",
    bookingEncryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    portalSessionSecret: "portal-session-secret-123456",
    rdsConnectionString: CONNECTION_STRING,
};
const PoolMock = pg_1.Pool;
beforeEach(async () => {
    await (0, db_1.closePool)();
    mockPools.length = 0;
    PoolMock.mockClear();
    PoolMock.mockImplementation((config) => {
        const pool = {
            config,
            query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
            end: jest.fn().mockResolvedValue(undefined),
        };
        mockPools.push(pool);
        return pool;
    });
});
afterEach(async () => {
    await (0, db_1.closePool)();
});
test("createPoolConfig: forces RDS TLS verification against the bundled RDS CA", () => {
    expect((0, db_1.createPoolConfig)(CONNECTION_STRING, { max: 2 })).toEqual({
        connectionString: CONNECTION_STRING,
        max: 2,
        ssl: { rejectUnauthorized: true, ca: rdsCaBundle_1.RDS_CA_BUNDLE },
    });
});
test("getPool: creates a singleton pg Pool from the secret RDS connection string and health-checks it", async () => {
    const pool = await (0, db_1.getPool)({
        secretProvider: new secrets_1.StaticSecretProvider(VALID_SECRETS),
        registerShutdownHook: false,
    });
    expect(pool).toBe(mockPools[0]);
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock).toHaveBeenCalledWith({
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: true, ca: rdsCaBundle_1.RDS_CA_BUNDLE },
    });
    expect(mockPools[0].query).toHaveBeenCalledWith("SELECT 1");
    const secondPool = await (0, db_1.getPool)({
        secretProvider: new secrets_1.StaticSecretProvider({
            ...VALID_SECRETS,
            rdsConnectionString: "postgres://other_user:other_password@other.example.com:5432/other_db",
        }),
        registerShutdownHook: false,
    });
    expect(secondPool).toBe(pool);
    expect(PoolMock).toHaveBeenCalledTimes(1);
});
test("checkPoolHealth: wraps failed health checks as retryable database errors", async () => {
    const pool = {
        query: jest.fn().mockRejectedValue(new Error("connection refused")),
    };
    await expect((0, db_1.checkPoolHealth)(pool)).rejects.toMatchObject({
        statusCode: 503,
        code: "database_health_check_failed",
        retryable: true,
    });
});
test("getPool: closes and resets the pool when the initial health-check fails", async () => {
    PoolMock.mockImplementationOnce((config) => {
        const pool = {
            config,
            query: jest.fn().mockRejectedValue(new Error("database down")),
            end: jest.fn().mockResolvedValue(undefined),
        };
        mockPools.push(pool);
        return pool;
    });
    await expect((0, db_1.getPool)({
        secretProvider: new secrets_1.StaticSecretProvider(VALID_SECRETS),
        registerShutdownHook: false,
    })).rejects.toMatchObject({
        code: "database_health_check_failed",
    });
    expect(mockPools[0].end).toHaveBeenCalledTimes(1);
    const retryPool = await (0, db_1.getPool)({
        secretProvider: new secrets_1.StaticSecretProvider(VALID_SECRETS),
        registerShutdownHook: false,
    });
    expect(retryPool).toBe(mockPools[1]);
    expect(PoolMock).toHaveBeenCalledTimes(2);
});
test("closePool: ends the active pool and allows a fresh pool to be created", async () => {
    await (0, db_1.getPool)({
        secretProvider: new secrets_1.StaticSecretProvider(VALID_SECRETS),
        registerShutdownHook: false,
    });
    await (0, db_1.closePool)();
    expect(mockPools[0].end).toHaveBeenCalledTimes(1);
    await (0, db_1.getPool)({
        secretProvider: new secrets_1.StaticSecretProvider(VALID_SECRETS),
        registerShutdownHook: false,
    });
    expect(PoolMock).toHaveBeenCalledTimes(2);
});
