"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const propertyCatalog_1 = require("./propertyCatalog");
test("booking property catalog uses unique Smoobu apartment IDs", () => {
    expect(propertyCatalog_1.BOOKING_PROPERTIES).toHaveLength(4);
    const ids = propertyCatalog_1.BOOKING_PROPERTIES.map((property) => property.smoobuApartmentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([100001, 100002, 100003, 100004]);
    expect(ids).not.toEqual([1, 2, 3, 4]);
});
test("booking property catalog lookup maps cover every configured property", () => {
    for (const property of propertyCatalog_1.BOOKING_PROPERTIES) {
        expect(propertyCatalog_1.BOOKING_PROPERTIES_BY_ID.get(property.propertyId)).toBe(property);
        expect(propertyCatalog_1.BOOKING_PROPERTIES_BY_SMOOBU_ID.get(property.smoobuApartmentId)).toBe(property);
    }
});
