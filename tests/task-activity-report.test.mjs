import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const scope = { exports: {} };
const source = readFileSync(new URL("../src/AttendanceModule/utils/taskActivityReport.ts", import.meta.url), "utf8");
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, scope);
const { reportMidnight, dailyTaskActivity } = scope.exports;
const report = (...args) => JSON.parse(JSON.stringify(dailyTaskActivity(...args)));
const now = new Date("2026-11-06T00:00:00Z");
const overnight = { id: "s1", taskId: "t1", startedAt: "2026-11-04T18:30:00Z", endedAt: "2026-11-04T20:30:00Z" };

test("report dates use local midnight rather than UTC midnight", () => {
  assert.equal(reportMidnight("2026-11-05", "Asia/Karachi").toISOString(), "2026-11-04T19:00:00.000Z");
});

test("an overnight session is split between its two local work days", () => {
  const days = report([overnight], [], "2026-11-04", "2026-11-05", "Asia/Karachi", now);
  assert.deepEqual(days.map(({ date, seconds }) => ({ date, seconds })), [{ date: "2026-11-05", seconds: 5400 }, { date: "2026-11-04", seconds: 1800 }]);
  assert.equal(days.reduce((sum, day) => sum + day.seconds, 0), 7200);
});

test("the same task counts once per day while retaining separate sessions", () => {
  const days = report([overnight, { id: "s2", taskId: "t1", startedAt: "2026-11-04T21:00:00Z", endedAt: "2026-11-04T21:15:00Z" }], [], "2026-11-05", "2026-11-05", "Asia/Karachi", now);
  assert.equal(days.length, 1);
  assert.equal(days[0].taskCount, 1);
  assert.equal(days[0].seconds, 6300);
  assert.equal(days[0].tasks[0].sessionCount, 2);
});

test("sessions that started before the selected range are clipped to it", () => {
  const days = report([overnight], [], "2026-11-05", "2026-11-05", "Asia/Karachi", now);
  assert.equal(days[0].seconds, 5400);
  assert.equal(days[0].tasks[0].intervals[0].startedAt, "2026-11-04T19:00:00.000Z");
});

test("running sessions stop at now and never include future time", () => {
  const days = report([{ id: "open", taskId: "t1", startedAt: "2026-11-05T04:00:00Z" }], [], "2026-11-05", "2026-11-30", "Asia/Karachi", new Date("2026-11-05T04:10:00Z"));
  assert.equal(days.length, 1);
  assert.equal(days[0].seconds, 600);
  assert.equal(days[0].tasks[0].intervals[0].running, true);
});

test("activity without timer records counts the task without inventing hours", () => {
  const days = report([], [{ taskId: "t1", createdAt: new Date("2026-11-05T05:00:00Z"), action: "task.updated" }], "2026-11-05", "2026-11-05", "Asia/Karachi", now);
  assert.equal(days[0].seconds, 0);
  assert.equal(days[0].taskCount, 1);
  assert.equal(days[0].tasks[0].sessionCount, 0);
});

test("daily boundaries handle both shorter and longer daylight-saving days", () => {
  assert.equal((reportMidnight("2026-03-09", "America/New_York") - reportMidnight("2026-03-08", "America/New_York")) / 3600000, 23);
  assert.equal((reportMidnight("2026-11-02", "America/New_York") - reportMidnight("2026-11-01", "America/New_York")) / 3600000, 25);
});
