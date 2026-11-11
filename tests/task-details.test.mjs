import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = (path) => ts.transpileModule(readFileSync(new URL(`../src/ProjectModule/${path}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const historyScope = { exports: {}, Date };
runInNewContext(compile("services/taskHistory.ts"), historyScope);
const { sameHistoryValue, taskHistoryChanges } = historyScope.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const id = (value) => value.toString(16).padStart(24, "0");
const org = id(1), projectId = id(2), taskId = id(3), userId = id(4), employeeId = id(5), adminId = id(6);

test("history ignores unchanged values, reordered assignees, empty fields and equal dates", () => {
  assert.ok(sameHistoryValue(["a", "b"], ["b", "a"]));
  assert.ok(sameHistoryValue(new Date("2026-11-05T08:00:00Z"), "2026-11-05T08:00:00.000Z"));
  assert.ok(sameHistoryValue(undefined, ""));
  const result = taskHistoryChanges({ action: "task.updated", changes: { before: { title: "One", description: "Old", dueDate: "2026-11-05" }, after: { title: "One", description: "New", dueDate: null } } }, new Map(), new Map(), new Map());
  assert.deepEqual(plain(result), [{ field: "description", label: "Description", before: "Old", after: "New" }, { field: "dueDate", label: "Due date", before: "2026-11-05", after: "None" }]);
});

test("history resolves assignees, parent stories and status names", () => {
  const people = new Map([[employeeId, "Alex Example"]]);
  const fields = taskHistoryChanges({ action: "task.updated", changes: { before: { assigneeEmployeeIds: [] }, after: { assigneeEmployeeIds: [employeeId], parentStoryId: id(7) } } }, people, new Map(), new Map([[id(7), "PR-1: Parent"]]));
  assert.equal(fields[0].after, "Alex Example"); assert.equal(fields[1].after, "PR-1: Parent");
  const status = taskHistoryChanges({ action: "task.status_changed", changes: { fromStatusId: "a", toStatusId: "b" } }, people, new Map([["a", "Backlog"], ["b", "In Progress"]]), new Map());
  assert.deepEqual(plain(status[0]), { field: "status", label: "Status", before: "Backlog", after: "In Progress" });
});

function query(rows) {
  let result = [...rows];
  return { select() { return this; }, sort(order) { const [key, direction] = Object.entries(order)[0]; result.sort((a, b) => (String(a[key]).localeCompare(String(b[key]))) * direction); return this; }, skip(amount) { result = result.slice(amount); return this; }, limit(amount) { result = result.slice(0, amount); return this; }, async lean() { return result; } };
}
function detailFixture() {
  const calls = [];
  const task = { _id: taskId, id: taskId, projectId, organizationId: org, createdBy: userId, reporterEmployeeId: employeeId, assigneeEmployeeIds: [employeeId], workflowStatusId: id(8), type: "task", accumulatedSeconds: 1000, title: "Example", labels: [] };
  const histories = Array.from({ length: 52 }, (_, index) => ({ _id: id(100 + index), actorUserId: userId, actorEmployeeId: employeeId, action: "task.updated", changes: { before: { title: "Old" }, after: { title: "New" } }, createdAt: new Date(2026, 10, 1, index) }));
  const comments = [{ _id: id(10), body: "Historical admin comment", mentionedEmployeeIds: [employeeId], createdAt: new Date() }, { _id: id(11), body: "Current comment", authorUserId: userId, authorEmployeeId: employeeId, mentionedEmployeeIds: [], createdAt: new Date() }];
  const sessions = [{ _id: id(12), employeeId, startedByUserId: userId, startedAt: new Date("2026-11-05T08:00:00Z"), endedAt: new Date("2026-11-05T08:10:00Z"), durationSeconds: 600, stopReason: "pause" }];
  const model = (name, rows) => ({ find(filter) { calls.push({ name, filter }); return query(rows); }, async countDocuments(filter) { calls.push({ name, filter }); return rows.length; }, async aggregate(pipeline) { calls.push({ name, pipeline }); return [{ seconds: 600 }]; } });
  const models = {
    Employee: model("Employee", [{ _id: employeeId, userId, firstName: "Alex", lastName: "Example", employeeCode: "E-1", emergencyContact: "Private", personalEmail: "secret" }]),
    User: model("User", [{ _id: adminId, loginId: "admin", passwordHash: "secret" }]),
    ProjectComment: model("ProjectComment", comments),
    ProjectActivity: { ...model("ProjectActivity", histories), find(filter) { calls.push({ name: "ProjectActivity", filter }); return query(filter.action === "comment.added" ? [{ actorUserId: adminId, changes: { commentId: id(10) } }] : histories); } },
    ProjectAttachment: model("ProjectAttachment", [{ _id: id(13), originalName: "screen.png", storedName: "private-file.png", uploadedByEmployeeId: employeeId }]),
    ProjectTask: model("ProjectTask", []), TaskTimeSession: model("TaskTimeSession", sessions),
    WorkflowStatus: model("WorkflowStatus", [{ _id: id(8), name: "Backlog" }]),
  };
  const scope = { exports: {}, Date, require(path) { if (path === "mongoose") return { isValidObjectId: (value) => /^[a-f0-9]{24}$/i.test(value) }; if (path === "./taskHistory") return historyScope.exports; const modelName = path.split("/").at(-1); return { __esModule: true, default: models[modelName] }; } };
  runInNewContext(compile("services/taskDetailService.ts"), scope);
  return { task, calls, read: (extra = {}) => scope.exports.readTaskDetails({ organizationId: org, task, project: { id: projectId, name: "Project", key: "PR", status: "active" }, canEdit: true, ...extra }) };
}

test("details provide named creators, old admin comment authors, worklog totals and safe public people", async () => {
  const fixture = detailFixture(); const result = await fixture.read();
  assert.equal(result.task.creator.name, "Alex Example"); assert.equal(result.task.reporter.employeeId, employeeId);
  assert.equal(result.comments[0].author.name, "admin"); assert.equal(result.comments[1].author.name, "Alex Example");
  assert.equal(result.activity[0].actor.name, "Alex Example"); assert.equal(result.activity[0].fieldChanges[0].after, "New");
  assert.equal(result.worklog[0].durationSeconds, 600); assert.equal(result.worklogSummary.legacySeconds, 400);
  assert.equal(result.attachments[0].storedName, undefined);
  assert.ok(!JSON.stringify(result).includes("secret")); assert.ok(!JSON.stringify(result).includes("Private"));
  for (const call of fixture.calls) { const filter = call.filter || call.pipeline[0].$match; if (call.name !== "User") assert.equal(filter.organizationId, org); if (["ProjectComment", "ProjectActivity", "ProjectAttachment", "TaskTimeSession"].includes(call.name)) { assert.equal(filter.projectId, projectId); assert.equal(filter.taskId, taskId); } }
});

test("history pagination returns older records without truncating access to them", async () => {
  const fixture = detailFixture(); const first = await fixture.read(), second = await fixture.read({ activityPage: 2 });
  assert.equal(first.activity.length, 50); assert.equal(first.activityPagination.totalCount, 52); assert.equal(first.activityPagination.hasMore, true);
  assert.equal(second.activity.length, 2); assert.equal(second.activityPagination.hasMore, false);
  assert.ok(!second.activity.some((row) => first.activity.some((entry) => row.id === entry.id)));
});

function controllerFixture({ member = { role: "member" }, status = "active", projectExists = true, taskExists = true, models = {} } = {}) {
  const calls = [], reads = [];
  const task = { id: taskId, projectId }, project = { id: projectId, status };
  class AccessError extends Error {}
  const scope = { exports: {}, process, Date, require(path) {
    if (path.startsWith("node:")) return require(path);
    if (path === "mongoose") return { isValidObjectId: (value) => /^[a-f0-9]{24}$/i.test(value) };
    if (path.endsWith("node-base/utils")) return { ValidationException: AccessError, ObjectNotFoundException: AccessError, ForbiddenException: AccessError, ConflictException: AccessError, sendResponseObject: ({ data }) => data };
    if (path.endsWith("services/taskDetailService")) return { async readTaskDetails(options) { reads.push(options); return { task: options.task, permissions: { canEdit: options.canEdit } }; } };
    if (path.endsWith("services/taskHistory")) return historyScope.exports;
    if (path.endsWith("services/pauseWorkflowService")) return { async ensurePauseStatus() {} };
    if (path.includes("/models/") && models[path.split("/").at(-1)]) return { __esModule: true, default: models[path.split("/").at(-1)] };
    if (path.endsWith("models/Project")) return { __esModule: true, default: { async findOne(filter) { calls.push(filter); return projectExists ? project : null; } } };
    if (path.endsWith("models/ProjectMember")) return { __esModule: true, default: { async findOne(filter) { calls.push(filter); return member; } } };
    if (path.endsWith("models/ProjectTask")) return { __esModule: true, default: { async findOne(filter) { calls.push(filter); return taskExists ? task : null; } } };
    return { __esModule: true, default: {} };
  } };
  runInNewContext(compile("controllers/ProjectController.ts"), scope);
  const get = (permissions = [], query = {}) => scope.exports.getTask({ auth: { organizationId: org, userId, employeeId, permissions }, params: { id: projectId, taskId }, query }, {});
  return { get, calls, reads, run: (action, params, body) => scope.exports[action]({ auth: { organizationId: org, userId, employeeId, permissions: ["*"] }, params: { id: projectId, ...params }, body }, {}) };
}

test("task detail endpoint rejects outsiders and deleted/missing tasks before loading history", async () => {
  for (const setup of [{ member: null }, { taskExists: false }, { projectExists: false }]) { const fixture = controllerFixture(setup); await assert.rejects(fixture.get(), /Project|Task/); assert.equal(fixture.reads.length, 0); }
});

test("task detail endpoint scopes access, preserves viewer/archive read-only mode and clamps pagination", async () => {
  const viewer = controllerFixture({ member: { role: "viewer" } }); const result = await viewer.get([], { activityPage: -5, worklogPage: 1000000 });
  assert.equal(result.permissions.canEdit, false); assert.equal(viewer.reads[0].activityPage, 1); assert.equal(viewer.reads[0].worklogPage, 100000);
  assert.ok(viewer.calls.every((filter) => filter.organizationId === org));
  assert.equal((await controllerFixture({ status: "archived" }).get(["*"])).permissions.canEdit, false);
  assert.equal((await controllerFixture().get(["*"])).permissions.canEdit, true);
});

test("removing a member records task-specific assignee history", async () => {
  const events = [];
  const fixture = controllerFixture({ models: {
    ProjectMember: { async findOne() { return { async save() {} }; } },
    ProjectTask: { async countDocuments() { return 1; }, find() { return query([{ _id: taskId, assigneeEmployeeIds: [employeeId, id(9)] }]); }, async updateMany() {} },
    ProjectActivity: { async insertMany(rows) { events.push(...rows); }, async create() {} },
  } });
  await fixture.run("removeMember", { employeeId }, { confirmUnassign: true });
  assert.equal(events.length, 1); assert.equal(events[0].taskId, taskId); assert.equal(events[0].actorUserId, userId);
  assert.deepEqual(plain(events[0].changes), { reason: "member_removed", before: { assigneeEmployeeIds: [employeeId, id(9)] }, after: { assigneeEmployeeIds: [id(9)] } });
});

test("archiving a workflow column records every migrated task's old and new status", async () => {
  const events = [], updates = [];
  const source = { id: id(8), name: "Review", async save() {} }, target = { id: id(9), name: "Backlog" };
  const models = {
    WorkflowStatus: { async findOne(filter) { return filter._id === id(8) ? source : target; }, async updateMany() {} },
    ProjectTask: { async countDocuments() { return 1; }, find() { return query([{ _id: taskId }]); }, async updateMany(filter, update) { updates.push(update); } },
    ProjectActivity: { async insertMany(rows) { events.push(...rows); }, async create() {} },
  };
  const fixture = controllerFixture({ models });
  await fixture.run("deleteStatus", { statusId: id(8) }, { replacementStatusId: id(9) });
  assert.equal(events[0].taskId, taskId); assert.equal(events[0].changes.from, "Review"); assert.equal(events[0].changes.to, "Backlog");
  source.isDefault = true;
  await assert.rejects(fixture.run("deleteStatus", { statusId: id(8) }, { replacementStatusId: id(9) }), /Set another default/);
  assert.equal(updates.length, 1);
});
