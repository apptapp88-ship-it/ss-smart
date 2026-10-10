"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCalendarRequest = handleCalendarRequest;
exports.invalidateCalendarRatesCache = invalidateCalendarRatesCache;
exports.clearCalendarRatesCache = clearCalendarRatesCache;
exports.invalidateCalendarRatesCacheFromWebhook = invalidateCalendarRatesCacheFromWebhook;
const errors_1 = require("./http/errors");
const response_1 = require("./http/response");
const propertyCatalog_1 = require("./propertyCatalog");
const smoobuClient_1 = require("./smoobuClient");
const cacheFactory_1 = require("./cacheFactory");
const DEFAULT_CURRENCY = "USD";
const LOW_PRICE_THRESHOLD = 0.9;
const HIGH_PRICE_THRESHOLD = 1.1;
// Module-level CacheAdapter instance — survives Lambda warm starts
const adapter = (0, cacheFactory_1.createCacheAdapter)((0, cacheFactory_1.getCacheBackend)());
async function handleCalendarRequest(request, config, responseHeaders, observability, now = Date.now) {
    const property = getPropertyBySlug(request.apartmentSlug);
    if (!property) {
        throw new errors_1.ApiError(404, "property_not_found", "Property was not found.");
    }
    const cacheKey = calendarCacheKey(property.smoobuApartmentId, request.month);
    const ttlSeconds = cacheFactory_1.TTL_SCOPES["calendar-rates"];
    const nowMs = now();
    const today = costaRicaToday(nowMs);
    const cachedRaw = await adapter.get(cacheKey);
    if (cachedRaw !== null) {
        const cached = parseCacheEntry(cachedRaw);
        // An entry written by a previous deploy has a different shape; treat it as a
        // miss rather than serving a payload we can no longer mask correctly.
        if (cached) {
            // Report the actual remaining TTL, not the full TTL, so callers know how
            // stale the entry is (mirrors the behaviour of the original Map-based cache).
            const remainingTtlSeconds = Math.max(0, Math.ceil((cached.expiresAtMs - nowMs) / 1000));
            return (0, response_1.jsonResponse)(200, withCache(finalizeCalendarPayload(cached.raw, today), "hit", cached.generatedAt, remainingTtlSeconds), responseHeaders);
        }
    }
    const { startDate, endDate } = monthBounds(request.month);
    const smoobuClient = await (0, smoobuClient_1.createSmoobuClient)(config);
    const rates = await smoobuClient.getRates({
        apartmentIds: [property.smoobuApartmentId],
        startDate,
        endDate,
    }, observability);
    const raw = normalizeCalendarPayload(property, request.month, rates.data);
    const generatedAt = new Date(nowMs).toISOString();
    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const entry = { raw, generatedAt, expiresAtMs };
    await adapter.set(cacheKey, JSON.stringify(entry), ttlSeconds);
    return (0, response_1.jsonResponse)(200, withCache(finalizeCalendarPayload(raw, today), "miss", generatedAt, ttlSeconds), responseHeaders);
}
function parseCacheEntry(serialized) {
    try {
        const parsed = JSON.parse(serialized);
        if (!parsed?.raw || !Array.isArray(parsed.raw.days) || typeof parsed.generatedAt !== "string") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
async function invalidateCalendarRatesCache(filters = {}) {
    if (filters.apartmentId !== undefined && filters.month !== undefined) {
        // Exact key match
        const key = calendarCacheKey(filters.apartmentId, filters.month);
        const count = await adapter.invalidateByPrefix(key);
        return count;
    }
    if (filters.apartmentId !== undefined) {
        // All months for a specific apartment
        const prefix = `${filters.apartmentId}:`;
        return adapter.invalidateByPrefix(prefix);
    }
    // No filters — clear everything
    return adapter.invalidateByPrefix("");
}
async function clearCalendarRatesCache() {
    await adapter.invalidateByPrefix("");
}
async function invalidateCalendarRatesCacheFromWebhook(body, observability) {
    const action = typeof body.action === "string" ? body.action : undefined;
    if (action !== "updateRates") {
        return { action, invalidatedEntries: 0 };
    }
    const apartmentId = extractWebhookApartmentId(body);
    const months = extractWebhookMonths(body);
    let invalidatedEntries = 0;
    if (!apartmentId) {
        invalidatedEntries = await invalidateCalendarRatesCache();
    }
    else if (months.length === 0) {
        invalidatedEntries = await invalidateCalendarRatesCache({ apartmentId });
    }
    else {
        for (const month of months) {
            invalidatedEntries += await invalidateCalendarRatesCache({ apartmentId, month });
        }
    }
    observability.recordStateTransition({
        entityType: "webhook_event",
        toState: "processed",
        action: "smoobu_updateRates_cache_invalidation",
        success: true,
        provider: "smoobu",
        providerObjectId: apartmentId ? String(apartmentId) : undefined,
    });
    return { action, invalidatedEntries };
}
function normalizeCalendarPayload(property, month, response) {
    const rateDays = getApartmentRates(response, property.smoobuApartmentId);
    const days = enumerateMonthDates(month).map((date) => normalizeCalendarDay(date, rateDays[date]));
    return {
        property: {
            propertyId: property.propertyId,
            slug: property.slug,
            name: property.name,
        },
        month,
        currency: DEFAULT_CURRENCY,
        days,
    };
}
/**
 * Turns raw Smoobu nights into the public payload.
 *
 * Smoobu keeps reporting `available: 1` for nights that have already passed —
 * it has no notion of "now". Serving those through would advertise a night the
 * guest physically cannot book (the search widget floors check-in at today), so
 * anything before `today` in Costa Rica is forced unavailable *before* stats are
 * computed. Otherwise dead nights would also drag the month average — and with
 * it every dot colour — off the real bookable range.
 */
function finalizeCalendarPayload(raw, today) {
    const days = raw.days.map((day) => ({
        ...day,
        available: day.available && day.date >= today,
    }));
    const stats = computeStats(days);
    const classifiedDays = days.map((day) => {
        const dot = classifyDot(day, stats.averagePriceCents);
        return {
            ...day,
            dot,
            ariaLabelKey: ariaLabelKey(dot),
        };
    });
    return {
        property: raw.property,
        month: raw.month,
        currency: raw.currency,
        days: classifiedDays,
        stats,
    };
}
/**
 * Costa Rica sits at UTC-6 year-round (no DST), so a fixed offset is exact.
 */
function costaRicaToday(nowMs) {
    return new Date(nowMs - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function getApartmentRates(response, apartmentId) {
    const root = response && typeof response === "object" && "data" in response ? response.data : response;
    if (!root || typeof root !== "object" || Array.isArray(root)) {
        return {};
    }
    const apartmentRates = root[String(apartmentId)];
    if (!apartmentRates || typeof apartmentRates !== "object" || Array.isArray(apartmentRates)) {
        return {};
    }
    return apartmentRates;
}
function normalizeCalendarDay(date, rateDay) {
    return {
        date,
        available: normalizeAvailable(rateDay?.available),
        priceCents: normalizePriceCents(rateDay?.price),
        minStay: normalizeMinStay(rateDay?.min_length_of_stay),
    };
}
function computeStats(days) {
    const availablePrices = days
        .filter((day) => day.available && day.priceCents !== null)
        .map((day) => day.priceCents);
    if (availablePrices.length === 0) {
        return {
            availableNightCount: 0,
            minPriceCents: null,
            maxPriceCents: null,
            averagePriceCents: null,
        };
    }
    const total = availablePrices.reduce((sum, price) => sum + price, 0);
    return {
        availableNightCount: availablePrices.length,
        minPriceCents: Math.min(...availablePrices),
        maxPriceCents: Math.max(...availablePrices),
        averagePriceCents: Math.round(total / availablePrices.length),
    };
}
function classifyDot(day, averagePriceCents) {
    if (!day.available || day.priceCents === null || averagePriceCents === null) {
        return "grey";
    }
    if (day.priceCents < averagePriceCents * LOW_PRICE_THRESHOLD) {
        return "green";
    }
    if (day.priceCents > averagePriceCents * HIGH_PRICE_THRESHOLD) {
        return "red";
    }
    return "yellow";
}
function ariaLabelKey(dot) {
    if (dot === "grey") {
        return "calendar.unavailable";
    }
    if (dot === "green") {
        return "calendar.priceLow";
    }
    if (dot === "red") {
        return "calendar.priceHigh";
    }
    return "calendar.priceAverage";
}
function normalizeAvailable(value) {
    if (typeof value === "number") {
        return value > 0;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return value === "1" || value.toLowerCase() === "true";
    }
    return false;
}
function normalizePriceCents(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return null;
    }
    return Math.round(value * 100);
}
function normalizeMinStay(value) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }
    return null;
}
function getPropertyBySlug(slug) {
    const normalized = slug.toLowerCase();
    return propertyCatalog_1.BOOKING_PROPERTIES.find((property) => property.slug.toLowerCase() === normalized);
}
function withCache(payload, status, generatedAt, ttlSeconds) {
    return {
        ...payload,
        cache: {
            status,
            ttlSeconds,
            generatedAt,
        },
    };
}
function calendarCacheKey(apartmentId, month) {
    return `${apartmentId}:${month}`;
}
function monthBounds(month) {
    const startDate = `${month}-01`;
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return {
        startDate,
        endDate: `${month}-${String(lastDay).padStart(2, "0")}`,
    };
}
function enumerateMonthDates(month) {
    const { startDate, endDate } = monthBounds(month);
    const dates = [];
    let currentMs = Date.parse(`${startDate}T00:00:00Z`);
    const endMs = Date.parse(`${endDate}T00:00:00Z`);
    while (currentMs <= endMs) {
        dates.push(new Date(currentMs).toISOString().slice(0, 10));
        currentMs += 86400000;
    }
    return dates;
}
function extractWebhookApartmentId(body) {
    const data = getObject(body.data);
    const candidates = [
        data?.apartmentId,
        data?.apartmentID,
        data?.apartment_id,
        data?.apartment,
        body.apartmentId,
        body.apartmentID,
        body.apartment_id,
    ];
    for (const candidate of candidates) {
        const parsed = parsePositiveInteger(candidate);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
}
function extractWebhookMonths(body) {
    const data = getObject(body.data);
    const months = new Set();
    const candidates = [
        data?.month,
        data?.date,
        data?.startDate,
        data?.endDate,
        data?.start_date,
        data?.end_date,
        data?.dates,
        body.month,
        body.date,
        body.startDate,
        body.endDate,
        body.start_date,
        body.end_date,
        body.dates,
    ];
    for (const candidate of candidates) {
        collectMonths(candidate, months);
    }
    return Array.from(months);
}
function collectMonths(value, months) {
    if (Array.isArray(value)) {
        value.forEach((item) => collectMonths(item, months));
        return;
    }
    if (typeof value !== "string") {
        return;
    }
    // Smoobu rate-update operations can represent date ranges as
    // "YYYY-MM-DD:YYYY-MM-DD"; single webhook dates fall through unchanged.
    for (const dateLike of value.split(":")) {
        if (/^\d{4}-\d{2}$/.test(dateLike)) {
            months.add(dateLike);
            continue;
        }
        const match = /^(\d{4}-\d{2})-\d{2}$/.exec(dateLike);
        if (match) {
            months.add(match[1]);
        }
    }
}
function parsePositiveInteger(value) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        return Number(value);
    }
    return undefined;
}
function getObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
