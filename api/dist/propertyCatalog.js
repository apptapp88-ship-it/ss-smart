"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOKING_PROPERTIES_BY_ID = exports.BOOKING_PROPERTIES_BY_SMOOBU_ID = exports.BOOKING_PROPERTIES = void 0;
exports.isPetFriendly = isPetFriendly;
exports.listingUrlForLanguage = listingUrlForLanguage;
/**
 * Demo catalog. Replace with your own properties — each `smoobuApartmentId`
 * must match the apartment ID Smoobu assigns to that listing (visible in the
 * Smoobu dashboard URL when you open an apartment). `propertyId` is your own
 * stable internal ID (any unique string; the values below are just examples)
 * and `slug` is the URL-safe identifier used to build listing links — see
 * `listingUrlForLanguage` below.
 */
exports.BOOKING_PROPERTIES = [
    {
        propertyId: "11111111-0000-4000-8000-000000000001",
        smoobuApartmentId: 100001,
        slug: "SunsetVilla",
        name: "Sunset Villa",
        guestCapacity: 6,
        thumbnailUrl: "https://picsum.photos/seed/sunset-villa/1000/700",
        amenities: [
            { code: "bath", label: "Private equipped bathroom" },
            { code: "kitchen", label: "Private equipped kitchen" },
            { code: "ac", label: "A/C" },
            { code: "parking", label: "Private fenced parking" },
            { code: "wifi", label: "100Mbps WiFi" },
            { code: "pet", label: "Pet friendly" },
        ],
    },
    {
        propertyId: "11111111-0000-4000-8000-000000000002",
        smoobuApartmentId: 100002,
        slug: "PalmCottage",
        name: "Palm Cottage",
        guestCapacity: 4,
        thumbnailUrl: "https://picsum.photos/seed/palm-cottage/1000/700",
        amenities: [
            { code: "bath", label: "Private equipped bathroom" },
            { code: "kitchen", label: "Private equipped kitchen" },
            { code: "ac", label: "A/C" },
            { code: "wifi", label: "100Mbps WiFi" },
            { code: "parking", label: "Outside parking" },
            { code: "pet", label: "Pet friendly" },
        ],
    },
    {
        propertyId: "11111111-0000-4000-8000-000000000003",
        smoobuApartmentId: 100003,
        slug: "OceanBreeze",
        name: "Ocean Breeze House",
        guestCapacity: 2,
        thumbnailUrl: "https://picsum.photos/seed/ocean-breeze/1000/700",
        amenities: [
            { code: "pool", label: "Private pool" },
            { code: "bath", label: "Private equipped bathroom" },
            { code: "kitchen", label: "Private equipped kitchen" },
            { code: "ac", label: "A/C" },
            { code: "parking", label: "Private unfenced parking" },
            { code: "wifi", label: "100Mbps WiFi" },
        ],
    },
    {
        propertyId: "11111111-0000-4000-8000-000000000004",
        smoobuApartmentId: 100004,
        slug: "JungleLoft",
        name: "Jungle Loft",
        guestCapacity: 8,
        thumbnailUrl: "https://picsum.photos/seed/jungle-loft/1000/700",
        amenities: [
            { code: "bath", label: "2 bathrooms" },
            { code: "kitchen", label: "Private equipped kitchen" },
            { code: "ac", label: "A/C" },
            { code: "wifi", label: "100Mbps WiFi" },
            { code: "parking", label: "Private fenced parking" },
        ],
    },
];
/**
 * Whether the home accepts a pet. Derived from the `pet` amenity so the badge a
 * guest sees on the card and the filter behind the "travelling with a pet"
 * toggle can never disagree.
 */
function isPetFriendly(property) {
    return property.amenities.some((amenity) => amenity.code === "pet");
}
exports.BOOKING_PROPERTIES_BY_SMOOBU_ID = new Map(exports.BOOKING_PROPERTIES.map((property) => [property.smoobuApartmentId, property]));
exports.BOOKING_PROPERTIES_BY_ID = new Map(exports.BOOKING_PROPERTIES.map((property) => [property.propertyId, property]));
function listingUrlForLanguage(slug, language) {
    return `/${slug}${language === "es" ? "ES" : ""}`;
}
