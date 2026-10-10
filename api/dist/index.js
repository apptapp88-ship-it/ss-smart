"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBookingApiHandler = exports.handler = void 0;
const app_1 = require("./app");
Object.defineProperty(exports, "createBookingApiHandler", { enumerable: true, get: function () { return app_1.createBookingApiHandler; } });
exports.handler = (0, app_1.createBookingApiHandler)();
