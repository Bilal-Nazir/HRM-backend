import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../src/ProjectModule/services/checkoutTimerService.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const checkoutAt = new Date("2026-11-05T12:00:00Z");
const startedAt = new Date("2026-11-05T11:00:00Z");

function matches(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") return expected.some((query) => matches(row, query));
    const value = row[field];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === "$exists") return (value !== undefined) === operand;
        if (operator === "$in") return operand.includes(value);
        if (operator === "$lte") return value !== undefined && +new Date(value) <= +new Date(operand);
        throw new Error(`Unsupported test operator ${operator}`);
      });
    }
    if (Array.isArray(value)) return value.includes(expected);
    return expected instanceof Date ? +new Date(value) === +expected : value === expected;
  });
}
function setup(tasks, sessions = []) {
  const events = [];
  const query = (rows) => ({ sort() { return query([...rows].sort((a, b) => +b.startedAt - +a.startedAt)); }, async lean() { return rows.map((row) => ({ ...row })); } });
  const apply = (row, update) => { Object.entries(update.$inc || {}).forEach(([key, amount]) => { row[key] = (row[key] || 0) + amount; }); Object.assign(row, update.$set); Object.keys(update.$unset || {}).forEach((key) => delete row[key]); };
  const Task = {
    find(filter) { return query(tasks.filter((task) => matches(task, filter))); },
    async findOneAndUpdate(filter, update) { const row = tasks.find((task) => matches(task, filter)); if (!row) return null; apply(row, update); return { ...row }; },
  };
  const Session = {
    find(filter) { return query(sessions.filter((session) => matches(session, filter))); },
    async create(row) { sessions.push({ _id: `created-${sessions.length}`, ...row }); },
    async updateOne(filter, update) { const row = sessions.find((session) => matches(session, filter)); if (row) apply(row, update); },
  };
  const scope = { exports: {}, require(path) { return { default: path.endsWith("ProjectTask") ? Task : path.endsWith("TaskTimeSession") ? Session : { async insertMany(rows) { events.push(...rows); } } }; } };
  runInNewContext(source, scope);
  return { pause: () => scope.exports.pauseEmployeeTimersAtCheckout({ organizationId: "org-1", employeeId: "employee-1", userId: "user-1", at: checkoutAt }), tasks, sessions, events };
}
const task = (id, extra = {}) => ({ _id: id, organizationId: "org-1", projectId: "project-1", assigneeEmployeeIds: ["employee-1"], timeStartedAt: startedAt, accumulatedSeconds: 120, workflowStatusId: "in-progress", ...extra });
const session = (id, taskId, extra = {}) => ({ _id: id, organizationId: "org-1", projectId: "project-1", taskId, employeeId: "employee-1", startedAt, ...extra });

test("checkout pauses all employee-owned task timers and records their duration", async () => {
  const fixture = setup([task("a"), task("b")], [session("sa", "a"), session("sb", "b")]);
  assert.equal((await fixture.pause()).length, 2);
  for (const row of fixture.tasks) { assert.equal(row.timeStartedAt, undefined); assert.equal(row.accumulatedSeconds, 3720); assert.equal(+row.timeStoppedAt, +checkoutAt); assert.equal(row.workflowStatusId, "in-progress"); }
  for (const row of fixture.sessions) { assert.equal(row.durationSeconds, 3600); assert.equal(+row.endedAt, +checkoutAt); assert.equal(row.stopReason, "checkout"); }
  assert.equal(fixture.events.length, 2);
  assert.ok(fixture.events.every((event) => event.action === "task.timer_auto_paused"));
});

test("checkout does not pause a colleague's timer on a shared task or another organization", async () => {
  const fixture = setup([task("shared"), task("outside", { organizationId: "org-2" })], [session("other-owner", "shared", { employeeId: "employee-2" }), session("other-org", "outside", { organizationId: "org-2" })]);
  assert.equal((await fixture.pause()).length, 0);
  assert.ok(fixture.tasks.every((row) => row.timeStartedAt));
  assert.ok(fixture.sessions.every((row) => !row.endedAt));
});

test("legacy running tasks retain their known interval as a checkout session", async () => {
  const fixture = setup([task("legacy")]);
  await fixture.pause();
  assert.equal(fixture.tasks[0].accumulatedSeconds, 3720);
  assert.equal(fixture.sessions.length, 1);
  assert.equal(fixture.sessions[0].employeeId, "employee-1");
  assert.equal(fixture.sessions[0].durationSeconds, 3600);
  assert.equal(fixture.sessions[0].stopReason, "checkout");
});

test("retries never add elapsed time or checkout sessions twice", async () => {
  const fixture = setup([task("a")], [session("sa", "a")]);
  await Promise.all([fixture.pause(), fixture.pause()]);
  await fixture.pause();
  assert.equal(fixture.tasks[0].accumulatedSeconds, 3720);
  assert.equal(fixture.sessions.length, 1);
  assert.equal(fixture.events.length, 1);
});

test("employee sessions still stop if the task was unassigned after the timer started", async () => {
  const fixture = setup([task("a", { assigneeEmployeeIds: [] })], [session("sa", "a")]);
  assert.equal((await fixture.pause()).length, 1);
  assert.equal(fixture.tasks[0].timeStartedAt, undefined);
  assert.equal(fixture.sessions[0].stopReason, "checkout");
});

test("checkout closes stale employee sessions without modifying a stopped task", async () => {
  const fixture = setup([task("a", { timeStartedAt: undefined })], [session("sa", "a")]);
  assert.equal((await fixture.pause()).length, 0);
  assert.equal(fixture.tasks[0].accumulatedSeconds, 120);
  assert.equal(fixture.sessions[0].durationSeconds, 3600);
});
