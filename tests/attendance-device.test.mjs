import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = (path) => ts.transpileModule(readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true } }).outputText;
const utilScope = { exports: {}, Date, require };
runInNewContext(compile("AttendanceModule/utils/deviceInfo.ts"), utilScope);
const { attendanceDeviceInfo } = utilScope.exports;
const req = (ua, device = {}) => ({ headers: { "user-agent": ua }, ip: "203.0.113.8", socket: { remoteAddress: "::ffff:127.0.0.1" }, body: { device } });
const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

test("captures desktop browser, OS, request IP and bounded client hints", () => {
  const at = new Date("2026-11-06T10:00:00Z");
  const info = attendanceDeviceInfo(req(chromeMac, { platform: "macOS", model: "", architecture: "arm", bitness: "64", timezone: "Asia/Karachi", screenWidth: 1440, screenHeight: 900, logicalProcessors: 8 }), at);
  assert.equal(info.deviceType, "desktop"); assert.equal(info.os, "macOS"); assert.equal(info.browser, "Chrome"); assert.equal(info.osVersion, "10.15.7");
  assert.equal(info.architecture, "arm"); assert.equal(info.bitness, "64"); assert.equal(info.screenWidth, 1440);
  assert.equal(info.ipAddress, "203.0.113.8"); assert.equal(info.connectionIp, "::ffff:127.0.0.1"); assert.equal(info.capturedAt, at);
});

test("recognizes phones, tablets, iPad desktop mode and Edge without calling them Chrome", () => {
  const phone = attendanceDeviceInfo(req("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile Safari/537.36"));
  assert.equal(phone.deviceType, "mobile"); assert.equal(phone.os, "Android");
  assert.equal(attendanceDeviceInfo(req("Mozilla/5.0 (Linux; Android 13; SM-X700) Chrome/130.0.0.0 Safari/537.36")).deviceType, "tablet");
  const ipad = attendanceDeviceInfo(req("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15", { touchPoints: 5 }));
  assert.equal(ipad.os, "iPadOS"); assert.equal(ipad.deviceType, "tablet");
  assert.equal(attendanceDeviceInfo(req(`${chromeMac} Edg/143.0.12.0`)).browser, "Edge");
  assert.equal(attendanceDeviceInfo(req("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1")).os, "iOS");
});

test("metadata cannot overwrite server addresses, timestamps or add fabricated hardware identifiers", () => {
  const info = attendanceDeviceInfo(req(chromeMac, { ipAddress: "10.0.0.99", capturedAt: "yesterday", macAddress: "00:11:22:33:44:55", serialNumber: "secret", browser: "Fake", deviceType: "tablet", screenWidth: Infinity, viewportHeight: -1, memoryGB: 9999, touchPoints: -5, platform: "a".repeat(5000), timezone: "bad\nvalue", bitness: "128" }));
  assert.equal(info.ipAddress, "203.0.113.8"); assert.equal(info.browser, "Chrome"); assert.equal(info.deviceType, "desktop");
  assert.equal(info.macAddress, undefined); assert.equal(info.serialNumber, undefined); assert.ok(info.capturedAt instanceof Date);
  assert.equal(info.screenWidth, undefined); assert.equal(info.viewportHeight, undefined); assert.equal(info.memoryGB, undefined); assert.equal(info.touchPoints, undefined); assert.equal(info.bitness, undefined);
  assert.equal(info.platform.length, 60); assert.equal(info.timezone, "badvalue");
  assert.equal(attendanceDeviceInfo({ ...req(undefined), body: {} }).deviceType, "unknown");
});

function controller() {
  class Base {}
  const constants = new Proxy({}, { get: (_target, name) => name });
  const scope = { exports: {}, Date, Intl, require(path) {
    if (path.endsWith("/constants")) return { constants: { fields: new Proxy({ Attendance: constants, OfficeLocation: constants }, { get: (target, name) => target[name] || name }) } };
    if (path.endsWith("/baseClasses")) return { BaseControllerClass: Base };
    if (path.endsWith("/deviceInfo")) return utilScope.exports;
    if (path.endsWith("/audit")) return { async writeAudit() {} };
    if (path.endsWith("/checkoutTimerService")) return { async pauseEmployeeTimersAtCheckout() { return []; } };
    if (path.endsWith("/utils")) return { sendResponseObject: ({ data }) => data };
    return { __esModule: true, default: {} };
  } };
  runInNewContext(compile("AttendanceModule/controllers/AttendanceController.ts"), scope);
  const instance = scope.exports.default;
  instance.validateData = async () => ({ isValid: true, postData: { latitude: 33, longitude: 73 } });
  instance.getOfficeDistance = async () => ({ withinGeofence: true });
  return instance;
}

test("check-in and check-out store separate device snapshots even when validation strips client fields", async () => {
  const instance = controller(); let saved;
  const document = (data) => ({ id: "session-1", ...data, toObject: () => data, display: async () => ({ id: "session-1" }) });
  let reads = 0;
  instance.dbReadRecord = async () => ++reads === 1 ? null : { id: "employee-1" };
  instance.dbInsertRecord = async ({ data }) => { saved = document(data); return saved; };
  const request = { ...req(chromeMac, { platform: "macOS" }), auth: { organizationId: "org-1", employeeId: "employee-1", userId: "user-1" } };
  await instance.checkInController(request, {}, (e) => { throw e; });
  const original = saved.checkInDevice;
  assert.equal(original.os, "macOS"); assert.equal(original.platform, "macOS");
  instance.dbReadRecord = async () => saved;
  instance.dbUpdateRecord = async ({ data }) => { saved = document({ ...saved, ...data }); return saved; };
  await instance.checkOutController({ ...request, headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1" }, body: { device: {} } }, {}, (e) => { throw e; });
  assert.equal(saved.checkInDevice, original); assert.equal(saved.checkOutDevice.deviceType, "mobile"); assert.equal(saved.checkOutDevice.os, "iOS"); assert.equal(saved.checkOutDevice.capturedAt, saved.checkOutAt);
});

test("device snapshots require an explicit admin serializer option", async () => {
  class Base { display__includes_excludes({ data }) { return data; } }
  const noop = () => () => {};
  const fields = new Proxy({}, { get: (_target, key) => key });
  const scope = { exports: {}, Date, require(path) {
    if (path === "@typegoose/typegoose") return { __esModule: true, default: { getModelForClass: () => ({}) }, prop: noop, index: noop };
    if (path.endsWith("/baseClasses")) return { BaseModelClass: Base, baseModelOptions: {} };
    if (path.endsWith("/constants")) return { constants: { fields: { ...Object.fromEntries(["id", "createdAt", "updatedAt"].map((key) => [key, key])), Attendance: fields } } };
    return {};
  } };
  runInNewContext(compile("AttendanceModule/models/Attendance.ts"), scope);
  const record = new scope.exports.AttendanceClass();
  record.checkInDevice = { ipAddress: "203.0.113.8" };
  assert.equal((await record.display({ detail: true })).checkInDevice, undefined);
  assert.equal((await record.display({ detail: true, includeDevice: true })).checkInDevice.ipAddress, "203.0.113.8");
});
