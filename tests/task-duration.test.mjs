import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = (file) => ts.transpileModule(readFileSync(new URL(`../src/ProjectModule/${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const id = (n) => n.toString(16).padStart(24, "0"), org = id(1), projectId = id(2), taskId = id(3), active = id(4), done = id(5), employeeId = id(6), userId = id(7);
const now = new Date("2026-11-10T12:00:00Z");
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((condition) => matches(row, condition));
    const value = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) return Object.entries(expected).every(([op, operand]) => op === "$exists" ? (value !== undefined) === operand : op === "$ne" ? value !== operand : op === "$in" ? operand.includes(value) : op === "$lte" ? value !== undefined && +value <= +operand : op === "$gt" ? value > operand : false);
    return expected instanceof Date ? +value === +expected : Array.isArray(value) ? value.includes(expected) : value === expected;
  });
}
function model(seed = []) {
  const rows = structuredClone(seed), filters = [];
  const doc = (row) => row && { ...structuredClone(row), get id() { return this._id; }, toObject() { return Object.fromEntries(Object.entries(this).filter(([key, value]) => typeof value !== "function" && key !== "id")); }, async save() { const target = rows.find((item) => item._id === this._id); Object.assign(target, this.toObject()); return this; } };
  const query = (values) => ({ limit() { return this; }, sort() { return this; }, select() { return this; }, async lean() { return structuredClone(values); }, then(resolve, reject) { return Promise.resolve(Array.isArray(values) ? values.map(doc) : doc(values)).then(resolve, reject); } });
  const apply = (row, update) => { Object.assign(row, update.$set); for (const key of Object.keys(update.$unset || {})) delete row[key]; };
  return { rows, filters,
    find(filter) { filters.push(filter); return query(rows.filter((row) => matches(row, filter))); },
    findOne(filter) { filters.push(filter); return query(rows.find((row) => matches(row, filter)) || null); },
    async exists(filter) { return rows.find((row) => matches(row, filter)) ? { _id: "exists" } : null; },
    async countDocuments(filter) { return rows.filter((row) => matches(row, filter)).length; },
    async create(value) { const row = { _id: id(100 + rows.length), accumulatedSeconds: 0, ...value }; rows.push(row); return doc(row); },
    async insertMany(values) { for (const value of values) await this.create(value); },
    async findOneAndUpdate(filter, update, options = {}) {
      filters.push(filter); let row = rows.find((value) => matches(value, filter));
      if (!row && options.upsert) { row = { _id: filter._id, ...structuredClone(update.$setOnInsert) }; rows.push(row); }
      if (!row) return null; apply(row, update); return doc(row);
    },
    async updateOne(filter, update) { const row = rows.find((value) => matches(value, filter)); if (row) apply(row, update); },
  };
}
const running = (extra = {}) => ({ _id: taskId, organizationId: org, projectId, createdBy: userId, assigneeEmployeeIds: [employeeId], workflowStatusId: active, accumulatedSeconds: 600, durationMinutes: 30, timeStartedAt: new Date(+now - 20 * 60000), autoCompleteAt: now, isDeleted: false, ...extra });
function fixture(seed = running()) {
  const tasks = model(seed ? [seed] : []), projects = model([{ _id: projectId, organizationId: org, status: "active", taskDurationOptionsMinutes: [30, 60, 240], autoCompleteStatusId: done }]);
  const statuses = model([{ _id: active, organizationId: org, projectId, name: "In Progress", category: "in_progress", isArchived: false }, { _id: done, organizationId: org, projectId, name: "Finished", category: "done", isArchived: false }]);
  const sessions = model(seed?.timeStartedAt ? [{ _id: id(10), organizationId: org, projectId, taskId, employeeId, startedByUserId: userId, startedAt: seed.timeStartedAt }] : []), history = model();
  class Failure extends Error {}
  const modules = { Project: projects, ProjectTask: tasks, WorkflowStatus: statuses, TaskTimeSession: sessions, ProjectActivity: history };
  const context = { exports: {}, Date, setInterval, require(path) {
    if (path.endsWith("/utils")) return { ValidationException: Failure, ConflictException: Failure, ForbiddenException: Failure, ObjectNotFoundException: Failure, sendResponseObject: ({ data }) => data, logger: { error() {} } };
    const name = path.split("/").pop(); if (modules[name]) return { __esModule: true, default: modules[name] };
    return require(path);
  } };
  runInNewContext(compile("services/taskDurationService.ts"), context);
  const controllerScope = { exports: {}, Date, process: { env: {}, cwd: () => "/tmp" }, require(path) {
    if (path.endsWith("/taskDurationService")) return context.exports;
    if (path.endsWith("/taskHistory")) return { sameHistoryValue: (a, b) => JSON.stringify(a) === JSON.stringify(b) };
    if (path.endsWith("/notificationService")) return { async projectManagerEmployeeIds() { return []; }, async notifyEmployees() {} };
    if (path.endsWith("/taskDetailService")) return {};
    if (path.includes("/models/") && !modules[path.split("/").pop()]) return { __esModule: true, default: model() };
    return context.require(path);
  } };
  runInNewContext(compile("controllers/ProjectController.ts"), controllerScope);
  const req = (body = {}, admin = true) => ({ params: { id: projectId, taskId }, query: {}, body, auth: { organizationId: org, userId, employeeId, permissions: admin ? ["project.manage"] : [] } });
  const checkoutScope = { exports: {}, require: (path) => path.endsWith("/taskDurationService") ? context.exports : context.require(path) };
  runInNewContext(compile("services/checkoutTimerService.ts"), checkoutScope);
  return { ...context.exports, ...checkoutScope.exports, controller: controllerScope.exports, req, tasks, projects, statuses, sessions, history };
}

test("duration choices are admin-defined whole minutes; removed selections are retained only on existing tasks", () => {
  const f = fixture(), project = f.projects.rows[0];
  assert.equal(f.durationChoice(project, 30), 30);
  for (const value of [undefined, null, "", "30", 0, -1, 1.5, Infinity, 99]) assert.throws(() => f.durationChoice(project, value));
  assert.equal(f.durationChoice(project, 45, 45), 45); assert.throws(() => f.durationChoice(project, 45));
  assert.throws(() => f.durationChoice({ taskDurationOptionsMinutes: [30] }, 30), /completion column/);
});

test("resume deadline counts accumulated work while excluding paused time", () => {
  const f = fixture();
  assert.equal(+f.durationDeadline({ durationMinutes: 30, accumulatedSeconds: 600 }, now), +now + 20 * 60000);
  assert.equal(f.durationDeadline({}, now), undefined);
  assert.throws(() => f.durationDeadline({ durationMinutes: 30, accumulatedSeconds: 1800 }, now), /reached its duration/);
});

test("server completion moves to configured column, caps at the exact limit and records system history and worklog", async () => {
  const f = fixture(); await f.completeDueTasks(new Date(+now + 10 * 60000));
  const row = f.tasks.rows[0];
  assert.equal(row.workflowStatusId, done); assert.equal(row.completionMethod, "auto"); assert.equal(+row.completedAt, +now);
  assert.equal(row.timeStartedAt, undefined); assert.equal(row.autoCompleteAt, undefined); assert.equal(row.accumulatedSeconds, 1800);
  assert.equal(f.sessions.rows[0].durationSeconds, 1200); assert.equal(f.sessions.rows[0].stopReason, "auto_done"); assert.equal(+f.sessions.rows[0].endedAt, +now);
  assert.equal(f.history.rows[0].actorUserId, "system"); assert.equal(f.history.rows[0].action, "task.auto_completed"); assert.equal(f.history.rows[0].changes.to, "Finished");
  await f.completeDueTasks(new Date(+now + 20 * 60000)); assert.equal(f.history.rows.length, 1); assert.equal(f.sessions.rows.length, 1);
});

test("paused, untimed, deleted, archived and not-yet-due tasks are never auto-completed", async () => {
  for (const extra of [{ timeStartedAt: undefined }, { durationMinutes: undefined }, { isDeleted: true }, { timeStartedAt: new Date(+now - 5 * 60000), autoCompleteAt: new Date(+now + 15 * 60000) }]) {
    const f = fixture(running(extra)); await f.completeDueTasks(now); assert.equal(f.tasks.rows[0].workflowStatusId, active); assert.equal(f.history.rows.length, 0);
  }
  const archived = fixture(); archived.projects.rows[0].status = "archived"; await archived.completeDueTasks(now); assert.equal(archived.tasks.rows[0].workflowStatusId, active);
});

test("completion target must belong to the same project and organization and be an active Done column", async () => {
  for (const extra of [{ organizationId: id(99) }, { projectId: id(99) }, { category: "in_progress" }, { isArchived: true }, { isDeleted: true }]) {
    const f = fixture(); Object.assign(f.statuses.rows[1], extra); await f.completeDueTasks(now); assert.equal(f.tasks.rows[0].workflowStatusId, active); assert.equal(f.history.rows.length, 0);
  }
});

test("concurrent workers claim completion once and settlement retries cannot duplicate history or sessions", async () => {
  const f = fixture(), task = structuredClone(f.tasks.rows[0]);
  const result = await Promise.all([f.completeTimedTaskIfDue(task, now), f.completeTimedTaskIfDue(task, now)]);
  assert.equal(result.filter(Boolean).length, 1);
  f.tasks.rows[0].autoCompletionPending = true;
  await Promise.all([f.settleAutoCompletion(structuredClone(f.tasks.rows[0])), f.settleAutoCompletion(structuredClone(f.tasks.rows[0]))]);
  assert.equal(f.history.rows.length, 1); assert.equal(f.sessions.rows.length, 1);
});

test("a newer pause or duration edit wins over a stale worker snapshot", async () => {
  for (const change of [{ timeStartedAt: undefined, accumulatedSeconds: 1700 }, { durationMinutes: 60 }]) {
    const f = fixture(), stale = structuredClone(f.tasks.rows[0]); Object.assign(f.tasks.rows[0], change);
    assert.equal(await f.completeTimedTaskIfDue(stale, now), null); assert.equal(f.history.rows.length, 0);
  }
});

test("completion settlement survives a process restart and preserves legacy timers without a session", async () => {
  const f = fixture(); f.sessions.rows.length = 0;
  const original = f.history.findOneAndUpdate; f.history.findOneAndUpdate = async () => { throw new Error("simulated interruption"); };
  await assert.rejects(f.completeTimedTaskIfDue(structuredClone(f.tasks.rows[0]), now), /interruption/);
  assert.equal(f.tasks.rows[0].autoCompletionPending, true); assert.equal(f.sessions.rows.length, 1);
  f.history.findOneAndUpdate = original; await f.completeDueTasks(now);
  assert.equal(f.tasks.rows[0].autoCompletionPending, false); assert.equal(f.sessions.rows.length, 1); assert.equal(f.history.rows.length, 1);
});

test("only admins can save presets, and destination validation rejects foreign/non-Done columns", async () => {
  const f = fixture();
  await assert.rejects(f.controller.updateDurationSettings(f.req({ taskDurationOptionsMinutes: [30], autoCompleteStatusId: done }, false), {}));
  for (const body of [{ taskDurationOptionsMinutes: [0], autoCompleteStatusId: done }, { taskDurationOptionsMinutes: [30], autoCompleteStatusId: active }, { taskDurationOptionsMinutes: [30], autoCompleteStatusId: id(99) }, { taskDurationOptionsMinutes: [30] }]) await assert.rejects(f.controller.updateDurationSettings(f.req(body), {}));
  await f.controller.updateDurationSettings(f.req({ taskDurationOptionsMinutes: [240, 30, 60, 30], autoCompleteStatusId: done }), {});
  assert.deepEqual(Array.from(f.projects.rows[0].taskDurationOptionsMinutes), [30, 60, 240]);
  await assert.rejects(f.controller.updateDurationSettings(f.req({ taskDurationOptionsMinutes: [], autoCompleteStatusId: null }), {}), /at least one/);
});

test("manual completion remains manual, pause removes its deadline, and resume schedules remaining time", async () => {
  const f = fixture(running({ timeStartedAt: new Date(Date.now() - 60000), autoCompleteAt: new Date(Date.now() + 19 * 60000) }));
  await f.controller.updateTaskTimer(f.req({ action: "pause" }), {});
  assert.equal(f.tasks.rows[0].autoCompleteAt, undefined); assert.equal(f.tasks.rows[0].completionMethod, undefined);
  await f.controller.updateTaskTimer(f.req({ action: "start" }), {});
  assert.ok(+f.tasks.rows[0].autoCompleteAt > Date.now());
  await f.controller.moveTask(f.req({ workflowStatusId: done }), {});
  assert.equal(f.tasks.rows[0].completionMethod, "manual"); assert.equal(f.tasks.rows[0].timeStartedAt, undefined); assert.equal(f.tasks.rows[0].autoCompleteAt, undefined);
  await assert.rejects(f.controller.updateTaskTimer(f.req({ action: "start" }), {}), /active column/);
});

test("pause after the deadline completes automatically rather than recording overtime", async () => {
  const f = fixture(running({ timeStartedAt: new Date(Date.now() - 30 * 60000) }));
  await f.controller.updateTaskTimer(f.req({ action: "pause" }), {});
  assert.equal(f.tasks.rows[0].completionMethod, "auto"); assert.equal(f.tasks.rows[0].accumulatedSeconds, 1800);
});

test("duration changes are validated and the configured completion column cannot be archived", async () => {
  const f = fixture(running({ timeStartedAt: undefined, autoCompleteAt: undefined }));
  await assert.rejects(f.controller.updateTask(f.req({ durationMinutes: 99 }), {}), /configured by the admin/);
  await f.controller.updateTask(f.req({ durationMinutes: 60 }), {}); assert.equal(f.tasks.rows[0].durationMinutes, 60);
  await assert.rejects(f.controller.deleteStatus({ ...f.req(), params: { id: projectId, statusId: done } }, {}), /another timed-task completion column/);
  await assert.rejects(f.controller.updateStatus({ ...f.req({ category: "todo" }), params: { id: projectId, statusId: done } }, {}), /another timed-task completion column/);
});

test("new tasks save their chosen duration and deadline together and reject non-admin presets", async () => {
  const f = fixture(null); Object.assign(f.projects.rows[0], { key: "TEST", nextIssueNumber: 1 });
  const body = { title: "Time limited work", durationMinutes: 30, workflowStatusId: active, assigneeEmployeeIds: [] };
  await assert.rejects(f.controller.createTask(f.req({ ...body, durationMinutes: 99 }), {}), /configured by the admin/);
  await f.controller.createTask(f.req(body), {});
  const task = f.tasks.rows[0]; assert.equal(task.durationMinutes, 30); assert.ok(task.timeStartedAt instanceof Date);
  assert.equal(+task.autoCompleteAt - +task.timeStartedAt, 30 * 60000); assert.equal(f.sessions.rows.length, 1);
});

test("checkout before the limit pauses, while checkout at the limit records Auto done", async () => {
  const before = fixture();
  await before.pauseEmployeeTimersAtCheckout({ organizationId: org, employeeId, userId, at: new Date(+now - 60000) });
  assert.equal(before.tasks.rows[0].completionMethod, undefined); assert.equal(before.tasks.rows[0].autoCompleteAt, undefined); assert.equal(before.sessions.rows[0].stopReason, "checkout");
  const reached = fixture();
  await reached.pauseEmployeeTimersAtCheckout({ organizationId: org, employeeId, userId, at: now });
  assert.equal(reached.tasks.rows[0].completionMethod, "auto"); assert.equal(reached.tasks.rows[0].accumulatedSeconds, 1800); assert.equal(reached.sessions.rows[0].stopReason, "auto_done");
});

test("task creation requires a duration and existing task durations cannot be cleared", async () => {
  for (const value of [undefined, null, "", 0]) {
    const create = fixture(null); Object.assign(create.projects.rows[0], { key: "TEST", nextIssueNumber: 1 });
    await assert.rejects(create.controller.createTask(create.req({ title: "Required duration", workflowStatusId: active, durationMinutes: value }), {}));
    assert.equal(create.tasks.rows.length, 0);
    if (value !== undefined) {
      const edit = fixture(running({ timeStartedAt: undefined, autoCompleteAt: undefined }));
      await assert.rejects(edit.controller.updateTask(edit.req({ durationMinutes: value }), {}));
      assert.equal(edit.tasks.rows[0].durationMinutes, 30);
    }
  }
});

test("legacy tasks must select a duration before starting a timer or moving to a timer-start column", async () => {
  const f = fixture(running({ durationMinutes: undefined, timeStartedAt: undefined, autoCompleteAt: undefined, workflowStatusId: id(11) }));
  f.sessions.rows.length = 0;
  f.statuses.rows.push({ _id: id(11), organizationId: org, projectId, name: "Backlog", category: "todo", isArchived: false });
  await assert.rejects(f.controller.updateTaskTimer(f.req({ action: "start" }), {}), /duration is required/);
  await assert.rejects(f.controller.moveTask(f.req({ workflowStatusId: active }), {}), /duration is required/);
  assert.equal(f.tasks.rows[0].timeStartedAt, undefined); assert.equal(f.sessions.rows.length, 0);
  await f.controller.updateTask(f.req({ durationMinutes: 30 }), {});
  await f.controller.updateTaskTimer(f.req({ action: "start" }), {});
  assert.equal(f.tasks.rows[0].durationMinutes, 30); assert.ok(f.tasks.rows[0].autoCompleteAt);
});
