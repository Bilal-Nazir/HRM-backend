import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../src/AttendanceModule/controllers/LocationReviewController.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const get = (record, path) => path.split(".").reduce((value, key) => value?.[key], record);
function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((condition) => matches(record, condition));
    const field = get(record, key);
    if (value && typeof value === "object") return Object.entries(value).every(([operator, expected]) => operator === "$ne" ? field !== expected : operator === "$exists" ? (field !== undefined) === expected : operator === "$lt" ? field < expected : operator === "$in" ? expected.includes(field) : false);
    return field === value;
  });
}
const query = (value) => ({ sort() { return this; }, select() { return this; }, skip() { return this; }, limit() { return this; }, lean() { return Promise.resolve(Array.isArray(value) ? value.map((doc) => doc.toObject()) : value?.toObject()); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function model() {
  const rows = [], filters = [];
  const document = (data) => ({ isDeleted: false, ...data, get id() { return this._id; }, toObject() { return Object.fromEntries(Object.entries(this).filter(([key, value]) => typeof value !== "function" && key !== "id")); }, set(value) { Object.assign(this, value); }, async save() { this.updatedAt = new Date(); return this; }, async display() { return this.toObject(); } });
  return { rows, filters, seed(data) { const doc = document(data); rows.push(doc); return doc; },
    async create(data) { return this.seed({ _id: String(rows.length + 1).padStart(24, "a"), status: "pending", active: true, ...data }); },
    findOne(filter) { filters.push(filter); return query(rows.find((row) => matches(row, filter)) || null); },
    find(filter) { filters.push(filter); return query(rows.filter((row) => matches(row, filter))); },
    async countDocuments(filter) { return rows.filter((row) => matches(row, filter)).length; },
    async findOneAndUpdate(filter, update) { filters.push(filter); const row = rows.find((row) => matches(row, filter)); if (row) { Object.assign(row, update.$set); row.updatedAt = new Date(); } return row || null; },
    async updateOne(filter, update) { const row = rows.find((row) => matches(row, filter)); if (row) Object.assign(row, update.$set); },
  };
}
function setup() {
  const attendance = model(), reviews = model(), employees = model(), offices = model();
  const audits = [], notifications = [], pauses = [];
  employees.seed({ _id: "employee-1", organizationId: "org-1", employmentStatus: "active", firstName: "Test", lastName: "Employee", employeeCode: "E1", primaryOfficeLocationId: "office-1" });
  offices.seed({ _id: "office-1", organizationId: "org-1", status: "active", latitude: 33, longitude: 73, geofenceRadiusMeters: 200 });
  class Failure extends Error {}
  const context = { exports: {}, Date, require(path) {
    if (path === "mongoose") return { isValidObjectId: (value) => /^[a-f0-9]{24}$/.test(value) };
    if (path.endsWith("/models/Attendance")) return { __esModule: true, default: attendance };
    if (path.endsWith("/LocationReviewRequest")) return { __esModule: true, default: reviews };
    if (path.endsWith("/Employee")) return { __esModule: true, default: employees };
    if (path.endsWith("/OfficeLocation")) return { __esModule: true, default: offices };
    if (path.endsWith("/utils")) return { ConflictException: Failure, ForbiddenException: Failure, ObjectNotFoundException: Failure, ValidationException: Failure, sendResponseObject: ({ data }) => data };
    if (path.endsWith("/audit")) return { async writeAudit(entry) { audits.push(entry); } };
    if (path.endsWith("/deviceInfo")) return { attendanceDeviceInfo: () => ({ browser: "Employee browser", ipAddress: "8.8.8.8" }) };
    if (path.endsWith("/geofence")) return { distanceMeters: () => 10 };
    if (path.endsWith("/checkoutTimerService")) return { async pauseEmployeeTimersAtCheckout(entry) { pauses.push(entry); } };
    if (path.endsWith("/notificationService")) return { async createNotifications(entry) { notifications.push(entry); }, async organizationAdminUserIds() { return ["admin-user"]; } };
    throw new Error(`Unexpected import ${path}`);
  } };
  runInNewContext(source, context);
  const auth = { organizationId: "org-1", employeeId: "employee-1", userId: "employee-user", permissions: ["attendance.checkin", "attendance.read.self"] };
  const req = (body = {}, admin = false, params = {}, query = {}) => ({ body, params, query, auth: { ...auth, ...(admin ? { userId: "admin-user", permissions: ["organization.update"] } : {}) } });
  const create = () => context.exports.createLocationRequest(req({ action: "check_in", latitude: 33, longitude: 73, reason: "Laptop cannot determine my location" }), {});
  const review = (id, decision = "approve", admin = true) => context.exports.reviewLocationRequest(req({ decision, latitude: 33.1, longitude: 73.1, reviewComment: "Confirmed with employee" }, admin, { requestId: id }), {});
  return { ...context.exports, attendance, reviews, employees, audits, notifications, pauses, req, create, review };
}

test("location review requires an explicit valid numeric pin, including valid zero coordinates", () => {
  const fixture = setup();
  for (const input of [undefined, null, {}, { latitude: null, longitude: 73 }, { latitude: "33", longitude: 73 }, { latitude: Infinity, longitude: 73 }, { latitude: 91, longitude: 73 }]) assert.throws(() => fixture.manualCoordinates(input), /valid location pin/);
  assert.equal(fixture.manualCoordinates({ latitude: 0, longitude: 0 }).latitude, 0);
});

test("sending a pin creates only a pending request and notifies admins without recording attendance", async () => {
  const fixture = setup(), result = await fixture.create();
  assert.equal(fixture.attendance.rows.length, 0); assert.equal(result.request.status, "pending");
  assert.equal(result.request.latitude, 33); assert.equal(result.request.device, undefined);
  assert.equal(fixture.reviews.rows[0].device.browser, "Employee browser");
  assert.equal(fixture.audits[0].action, "attendance.location_requested");
  assert.equal(fixture.notifications[0].recipientUserIds[0], "admin-user");
  assert.equal(fixture.notifications[0].href, "/attendance#location-review");
  const missing = fixture.req({ action: "check_in", reason: "No location" });
  await assert.rejects(fixture.createLocationRequest(missing, {}), /valid location pin/);
  assert.equal(fixture.attendance.rows.length, 0);
});

test("employees cannot approve, correct or list organization-wide location requests", async () => {
  const fixture = setup(), { request } = await fixture.create();
  await assert.rejects(fixture.review(request.id, "approve", false), /Only an administrator/);
  await assert.rejects(fixture.correctAttendanceLocation(fixture.req({}, false, { attendanceId: request.id }), {}), /Only an administrator/);
  await assert.rejects(fixture.listLocationRequests(fixture.req({}, false, {}, { scope: "organization" }), {}), /Only an administrator/);
  assert.equal(fixture.attendance.rows.length, 0); assert.equal(fixture.reviews.rows[0].status, "pending");
});

test("all review and correction lookups are restricted to the current organization", async () => {
  const fixture = setup(), { request } = await fixture.create();
  const foreign = fixture.req({ decision: "approve", latitude: 33, longitude: 73, reviewComment: "Confirmed employee" }, true, { requestId: request.id });
  foreign.auth.organizationId = "other-org";
  await assert.rejects(fixture.reviewLocationRequest(foreign, {}), /Location request/);
  assert.equal(fixture.attendance.rows.length, 0);
  const ownList = await fixture.listLocationRequests(fixture.req({}, false, {}, {}), {});
  assert.equal(ownList.requests.length, 1); assert.equal(ownList.requests[0].device, undefined);
  const otherEmployee = fixture.req(); otherEmployee.auth.employeeId = "employee-2";
  assert.equal((await fixture.listLocationRequests(otherEmployee, {})).requests.length, 0);
  await assert.rejects(fixture.cancelLocationRequest({ ...otherEmployee, params: { requestId: request.id } }, {}), /no longer pending/);
});

test("admin confirms a real pin before attendance is created, preserving the proposed pin and employee device", async () => {
  const fixture = setup(), { request } = await fixture.create(), start = Date.now();
  const result = await fixture.review(request.id), row = fixture.attendance.rows[0];
  assert.equal(fixture.attendance.rows.length, 1); assert.equal(result.request.status, "approved");
  assert.equal(row.checkInLocation.latitude, 33.1); assert.equal(row.checkInLocation.source, "admin");
  assert.equal(row.checkInLocation.enteredByUserId, "admin-user"); assert.equal(row.checkInLocation.accuracyMeters, undefined);
  assert.equal(row.checkInDevice.browser, "Employee browser"); assert.ok(row.checkInAt.valueOf() >= start);
  assert.equal(fixture.reviews.rows[0].latitude, 33); assert.equal(fixture.reviews.rows[0].active, false);
  assert.equal(fixture.audits.at(-1).action, "attendance.location_request_approved");
  assert.equal((await fixture.review(request.id)).alreadyRecorded, true); assert.equal(fixture.attendance.rows.length, 1);
});

test("rejection and cancellation never create attendance", async () => {
  const rejected = setup(), first = await rejected.create(); await rejected.review(first.request.id, "reject");
  assert.equal(rejected.reviews.rows[0].status, "rejected"); assert.equal(rejected.attendance.rows.length, 0);
  const cancelled = setup(), second = await cancelled.create();
  await cancelled.cancelLocationRequest(cancelled.req({}, false, { requestId: second.request.id }), {});
  assert.equal(cancelled.reviews.rows[0].status, "cancelled"); await assert.rejects(cancelled.review(second.request.id), /already reviewed/);
  assert.equal(cancelled.attendance.rows.length, 0);
});

test("an interrupted approval recovers its saved attendance and review metadata without duplication", async () => {
  const fixture = setup(), { request } = await fixture.create();
  fixture.reviews.rows[0].save = async function () { this.status = "processing"; delete this.reviewComment; delete this.reviewedByUserId; throw new Error("Simulated save interruption"); };
  await assert.rejects(fixture.review(request.id), /save interruption/);
  assert.equal(fixture.attendance.rows.length, 1);
  assert.equal((await fixture.review(request.id)).alreadyRecorded, true);
  assert.equal(fixture.attendance.rows.length, 1);
  assert.equal(fixture.reviews.rows[0].status, "approved");
  assert.equal(fixture.reviews.rows[0].reviewComment, "Confirmed with employee");
  assert.equal(fixture.reviews.rows[0].reviewedByUserId, "admin-user");
});

test("admin-confirmed checkout ends the original session and pauses that employee's timers", async () => {
  const fixture = setup(), first = await fixture.create(); await fixture.review(first.request.id);
  const row = fixture.attendance.rows[0], originalAt = row.checkInAt;
  const second = await fixture.createLocationRequest(fixture.req({ action: "check_out", latitude: 33, longitude: 73, reason: "Unable to get location on checkout" }), {});
  await fixture.review(second.request.id);
  assert.equal(row.checkInAt, originalAt); assert.ok(row.checkOutAt instanceof Date);
  assert.equal(row.checkOutLocation.source, "admin"); assert.equal(row.status, "completed");
  assert.equal(fixture.pauses.length, 1); assert.equal(fixture.pauses[0].employeeId, "employee-1");
  assert.equal((await fixture.review(first.request.id)).alreadyRecorded, true); assert.equal(fixture.attendance.rows.length, 1);
});

test("approval of an obsolete request fails without creating a second open session", async () => {
  const fixture = setup(), { request } = await fixture.create();
  fixture.attendance.seed({ _id: "b".repeat(24), organizationId: "org-1", employeeId: "employee-1", checkInAt: new Date() });
  await assert.rejects(fixture.review(request.id), /already checked in/);
  assert.equal(fixture.attendance.rows.length, 1); assert.equal(fixture.reviews.rows[0].status, "pending");
});

test("concurrent admin reviews can claim a pending request only once", async () => {
  const fixture = setup(), { request } = await fixture.create();
  const results = await Promise.allSettled([fixture.review(request.id), fixture.review(request.id)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(fixture.attendance.rows.length, 1);
});

test("manual correction keeps event times and audits both the original and replacement location", async () => {
  const fixture = setup(), created = await fixture.create(); await fixture.review(created.request.id);
  const row = fixture.attendance.rows[0], originalAt = row.checkInAt;
  await fixture.correctAttendanceLocation(fixture.req({ stage: "check_in", latitude: 34, longitude: 74, reason: "Corrected after employee confirmation" }, true, { attendanceId: row.id }), {});
  assert.equal(row.checkInAt, originalAt); assert.equal(row.checkInLocation.latitude, 34); assert.equal(row.checkInLocation.source, "admin");
  assert.equal(fixture.audits.at(-1).before.checkInLocation.latitude, 33.1); assert.equal(fixture.audits.at(-1).after.checkInLocation.latitude, 34);
  await assert.rejects(fixture.correctAttendanceLocation(fixture.req({ stage: "check_out", latitude: 34, longitude: 74, reason: "Cannot invent a checkout" }, true, { attendanceId: row.id }), {}), /not checked out/);
  const missing = fixture.req({ stage: "check_in", latitude: 34, longitude: 74, reason: "Cross organization attempt" }, true, { attendanceId: row.id }); missing.auth.organizationId = "other-org";
  await assert.rejects(fixture.correctAttendanceLocation(missing, {}), /Attendance/);
});
