import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = (path) => ts.transpileModule(readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const validatorScope = { exports: {}, require: () => ({ __esModule: true, default: { isValidObjectId: () => true } }) };
runInNewContext(compile("node-base/validator/index.ts"), validatorScope);

function setup() {
  class Base {}
  class ValidationError extends Error {}
  const fields = new Proxy({}, { get: (_target, name) => name });
  const records = [], audits = [], pauses = [];
  const scope = { exports: {}, Date, Intl, require(path) {
    if (path.endsWith("/constants")) return { constants: { fields: { id: "id", Attendance: fields, OfficeLocation: fields } } };
    if (path.endsWith("/baseClasses")) return { BaseControllerClass: Base };
    if (path.endsWith("/utils")) return { ValidationException: ValidationError, ConflictException: ValidationError, ObjectNotFoundException: ValidationError, sendResponseObject: ({ data }) => data };
    if (path.endsWith("/deviceInfo")) return { attendanceDeviceInfo: () => ({ ipAddress: "8.8.8.8", browser: "Chrome" }) };
    if (path.endsWith("/geofence")) return { distanceMeters: () => 10 };
    if (path.endsWith("/audit")) return { async writeAudit(value) { audits.push(value); } };
    if (path.endsWith("/checkoutTimerService")) return { async pauseEmployeeTimersAtCheckout(value) { pauses.push(value); return ["task-1"]; } };
    return { __esModule: true, default: {} };
  } };
  runInNewContext(compile("AttendanceModule/controllers/AttendanceController.ts") + "\nexports.metrics = attendanceMetrics;", scope);
  const instance = scope.exports.default;
  instance.validateData = ({ data, validationRules }) => validatorScope.exports.dataValidator.validate(data, validationRules);
  const employee = { id: "employee-1", primaryOfficeLocationId: "office-1" };
  const office = { id: "office-1", latitude: 33, longitude: 73, geofenceRadiusMeters: 200 };
  instance.dbReadRecord = async ({ readFilter }) => readFilter._id === "employee-1" ? employee : readFilter._id === "office-1" ? office : records.find((row) => !row.checkOutAt) || null;
  const document = (data) => ({ ...data, id: "session-1", toObject() { return { ...data }; }, async display() { return { ...data }; } });
  instance.dbInsertRecord = async ({ data }) => { const row = document(data); records.push(row); return row; };
  instance.dbUpdateRecord = async ({ data, obj }) => { Object.assign(obj, document({ ...obj, ...data })); return obj; };
  const request = (body) => ({ auth: { organizationId: "org-1", employeeId: "employee-1", userId: "user-1" }, body });
  const next = (error) => { throw error; };
  return { records, audits, pauses, metrics: scope.exports.metrics, checkIn: (body) => instance.checkInController(request(body), {}, next), checkOut: (body) => instance.checkOutController(request(body), {}, next) };
}
const unavailable = { locationUnavailable: true, locationFailureCode: "position_unavailable" };

test("check-in requires real coordinates and stores the browser reading and timestamp", async () => {
  const fixture = setup();
  await fixture.checkIn({ latitude: 33, longitude: 73, accuracyMeters: 25, locationCapturedAt: "2026-11-10T04:00:00Z" });
  const record = fixture.records[0];
  assert.equal(record.status, "open"); assert.equal(record.checkInLocation.latitude, 33);
  assert.equal(record.checkInLocation.source, "browser"); assert.equal(record.checkInLocation.accuracyMeters, 25);
  assert.equal(record.checkInLocation.capturedAt.toISOString(), "2026-11-10T04:00:00.000Z");
  assert.equal(record.checkInLocationFailure, undefined); assert.equal(record.officeLocationId, "office-1");
  assert.equal(record.checkInWithinGeofence, true); assert.equal(record.checkInDistanceMeters, 10);
  assert.equal(record.checkInDevice.ipAddress, "8.8.8.8"); assert.ok(record.checkInAt instanceof Date);
  assert.equal(fixture.audits[0].action, "attendance.checked_in");
  assert.ok(!fixture.metrics(record).flags.includes("location_unavailable"));
  await assert.rejects(fixture.checkIn({ latitude: 33, longitude: 73 }), /already have an open/);
});

test("check-out without location is blocked; valid checkout pauses task timers", async () => {
  const fixture = setup();
  await fixture.checkIn({ latitude: 33, longitude: 73 });
  await assert.rejects(fixture.checkOut(unavailable));
  assert.equal(fixture.records[0].checkOutAt, undefined); assert.equal(fixture.pauses.length, 0);
  const result = await fixture.checkOut({ latitude: 33, longitude: 73 });
  assert.equal(result.pausedTaskCount, 1); assert.equal(fixture.pauses.length, 1);
  assert.ok(fixture.records[0].checkOutAt instanceof Date);
  assert.equal(fixture.records[0].checkOutLocation.latitude, 33); assert.equal(fixture.records[0].checkOutWithinGeofence, true);
  assert.equal(fixture.records[0].checkOutLocationFailure, undefined); assert.equal(fixture.records[0].status, "completed");
  assert.equal(fixture.audits.at(-1).action, "attendance.checked_out");
});

test("missing or malformed location submissions cannot silently enter attendance", async () => {
  for (const body of [{}, { latitude: 33 }, unavailable, { locationUnavailable: true }, { locationUnavailable: true, locationFailureCode: "permission_denied" }, { locationUnavailable: "true", locationFailureCode: "timeout" }, { latitude: 999, longitude: 73 }, { latitude: null, longitude: 73 }, { latitude: NaN, longitude: 73 }, { latitude: "33", longitude: "73" }]) {
    const fixture = setup(); await assert.rejects(fixture.checkIn(body)); assert.equal(fixture.records.length, 0); assert.equal(fixture.audits.length, 0);
  }
});
