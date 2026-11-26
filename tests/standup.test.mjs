import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("../src/AttendanceModule/controllers/StandupController.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } },
).outputText;

const id = (value) => value.toString(16).padStart(24, "0");
const auth = { organizationId: "org", employeeId: "employee" };
const columns = [
  { _id: id(1), name: "Ideas", category: "todo" },
  { _id: id(2), name: "Quality review", category: "in_progress" },
  { _id: id(3), name: "Waiting on client", category: "paused" },
  { _id: id(4), name: "Released", category: "done" },
  { _id: id(5), name: "Archived", category: "todo", isArchived: true },
].map((column) => ({ organizationId: "org", projectId: "project", ...column }));
const tasks = columns.map((column, index) => ({
  _id: id(10 + index), organizationId: "org", projectId: "project",
  assigneeEmployeeIds: ["employee"], workflowStatusId: column._id,
  key: `APP-${index + 1}`, title: `Task ${index + 1}`,
}));
tasks.push({ ...tasks[0], _id: id(20), assigneeEmployeeIds: ["coworker"] });
tasks.push({ ...tasks[0], _id: id(21), organizationId: "other-org" });
tasks.push({ ...tasks[0], _id: id(22), projectId: "other-project" });

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value?.$in) return value.$in.includes(row[key]);
    if (value && "$ne" in Object(value)) return row[key] !== value.$ne;
    return Array.isArray(row[key]) ? row[key].includes(value) : row[key] === value;
  });
}

const model = (rows) => ({
  find: (filter) => {
    const query = { select: () => query, sort: () => query, lean: async () => rows.filter((row) => matches(row, filter)) };
    return query;
  },
  distinct: async (key, filter) => rows.filter((row) => matches(row, filter)).map((row) => row[key]),
});
const models = {
  ProjectTask: model(tasks),
  WorkflowStatus: model(columns),
  ProjectMember: model([{ ...auth, projectId: "project", status: "active" }]),
};
const scope = { exports: {}, require(path) {
  if (path === "mongoose") return { isValidObjectId: (value) => /^[\da-f]{24}$/i.test(value) };
  if (path.endsWith("/utils")) return { ValidationException: Error, sendResponseObject: ({ data }) => data };
  return { __esModule: true, default: models[path.split("/").at(-1)] };
} };
runInNewContext(source, scope);
const { standupTaskOptions, checkInStandup, checkOutStandup } = scope.exports;

test("stand-up options use custom column categories and are scoped to the employee's assigned projects", async () => {
  const checkIn = await standupTaskOptions({ auth, query: { stage: "check-in" } }, {});
  const checkOut = await standupTaskOptions({ auth, query: { stage: "check-out" } }, {});
  assert.deepEqual(Array.from(checkIn.tasks, ({ key, column }) => [key, column]), [["APP-1", "Ideas"], ["APP-2", "Quality review"]]);
  assert.deepEqual(Array.from(checkOut.tasks, ({ key, column }) => [key, column]), [["APP-3", "Waiting on client"], ["APP-4", "Released"]]);
  await assert.rejects(checkInStandup({ auth, body: { standup: { planned: [id(12)], hasBlocker: false } } }, true), /To do or In progress/);
  await assert.rejects(checkInStandup({ auth, body: { standup: { planned: [id(20)], hasBlocker: false } } }, true), /assigned tasks/);
});

test("checkout records Paused and Done selections separately and preserves unreported plans", async () => {
  const plan = await checkInStandup({ auth, body: { standup: { planned: [id(10)], hasBlocker: false } } }, true);
  assert.equal(plan.planned[0].key, "APP-1");
  assert.equal(plan.yesterday, undefined);
  const result = await checkOutStandup({ auth, body: { standup: { workedOn: [id(12), id(13)] } } }, plan);
  assert.deepEqual(Array.from(result.completed, ({ key }) => key), ["APP-4"]);
  assert.deepEqual(Array.from(result.paused, ({ key }) => key), ["APP-3"]);
  assert.deepEqual(Array.from(result.pending, ({ key }) => key), ["APP-1"]);
  await assert.rejects(checkOutStandup({ auth, body: { standup: { workedOn: [id(10)] } } }, plan), /Paused or Done/);
});
