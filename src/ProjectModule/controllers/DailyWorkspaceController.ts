import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import {
  ForbiddenException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import {
  reportDay,
  reportMidnight,
  nextReportDay,
} from "../../AttendanceModule/utils/taskActivityReport";
import ProjectModel from "../models/Project";
import ProjectMemberModel from "../models/ProjectMember";
import ProjectTaskModel from "../models/ProjectTask";
import WorkflowStatusModel from "../models/WorkflowStatus";
import TaskTimeSessionModel from "../models/TaskTimeSession";
import ProjectReminderModel from "../models/ProjectReminder";

// Always derive the employee and company from the session, never from filters.
export async function dailyWorkspace(req: AuthenticatedRequest, res: Response) {
  const { organizationId, employeeId } = req.auth!;
  if (!employeeId) throw new ForbiddenException();
  const timeZone =
    typeof req.query.timezone === "string" ? req.query.timezone : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new ValidationException("Choose a valid time zone");
  }
  const now = new Date(),
    day = reportDay(now, timeZone);
  const from = reportMidnight(day, timeZone);
  const to = reportMidnight(nextReportDay(day), timeZone);
  let weekEnd = day;
  for (let i = 0; i < 7; i++) weekEnd = nextReportDay(weekEnd);
  const memberships = await ProjectMemberModel.distinct("projectId", {
    organizationId,
    employeeId,
    status: "active",
    isDeleted: { $ne: true },
  });
  const projects = await ProjectModel.find({
    organizationId,
    _id: { $in: memberships },
    status: { $ne: "archived" },
    isDeleted: { $ne: true },
  })
    .select("name key")
    .lean();
  const projectIds = projects.map((project) => String(project._id));
  const scope = {
    organizationId,
    projectId: { $in: projectIds },
    isDeleted: { $ne: true },
  };
  const [assigned, statuses, sessions, reminders] = await Promise.all([
    ProjectTaskModel.find({ ...scope, assigneeEmployeeIds: employeeId })
      .select(
        "key title projectId workflowStatusId priority startDate dueDate completedAt durationMinutes autoPaused timeStartedAt accumulatedSeconds",
      )
      .lean(),
    WorkflowStatusModel.find(scope).select("name category").lean(),
    TaskTimeSessionModel.find({
      ...scope,
      employeeId,
      startedAt: { $lt: to },
      $or: [{ endedAt: { $gt: from } }, { endedAt: { $exists: false } }],
    })
      .select("taskId startedAt endedAt")
      .lean(),
    ProjectReminderModel.find({
      ...scope,
      scheduledAt: { $gte: from, $lt: reportMidnight(weekEnd, timeZone) },
    })
      .select("title projectId scheduledAt")
      .sort({ scheduledAt: 1 })
      .lean(),
  ]);
  // Include work recorded today even if a task has since been reassigned.
  const assignedIds = new Set(assigned.map((task) => String(task._id)));
  const historicIds = [
    ...new Set(sessions.map((session) => String(session.taskId))),
  ].filter((id) => !assignedIds.has(id));
  const historic = historicIds.length
    ? await ProjectTaskModel.find({ ...scope, _id: { $in: historicIds } })
        .select(
          "key title projectId workflowStatusId priority startDate dueDate completedAt durationMinutes autoPaused timeStartedAt accumulatedSeconds",
        )
        .lean()
    : [];
  const accessibleIds = new Set(
    [...assigned, ...historic].map((task) => String(task._id)),
  );
  const secondsByTask = new Map<string, number>();
  const running = new Set<string>();
  for (const session of sessions) {
    const id = String(session.taskId);
    if (!accessibleIds.has(id)) continue;
    const start = Math.max(from.getTime(), session.startedAt.getTime());
    const end = Math.min(
      to.getTime(),
      now.getTime(),
      session.endedAt?.getTime() ?? now.getTime(),
    );
    secondsByTask.set(
      id,
      (secondsByTask.get(id) || 0) +
        Math.max(0, Math.floor((end - start) / 1000)),
    );
    if (!session.endedAt) running.add(id);
  }
  const statusMap = new Map(
    statuses.map((status) => [
      String(status._id),
      { name: status.name, category: status.category },
    ]),
  );
  const projectMap = new Map(
    projects.map((project) => [
      String(project._id),
      { id: String(project._id), name: project.name, key: project.key },
    ]),
  );
  const tasks = [...assigned, ...historic].map((task) => ({
    id: String(task._id),
    key: task.key,
    title: task.title,
    projectId: String(task.projectId),
    project: projectMap.get(String(task.projectId)),
    status: statusMap.get(String(task.workflowStatusId)) || {
      name: "Unknown",
      category: "unknown",
    },
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    // Due dates are date-only fields stored at UTC midnight, not timestamps.
    dueDay: task.dueDate?.toISOString().slice(0, 10),
    startDay: task.startDate ? reportDay(task.startDate, timeZone) : undefined,
    completedToday:
      !!task.completedAt && task.completedAt >= from && task.completedAt < to,
    assigned: assignedIds.has(String(task._id)),
    autoPaused: task.autoPaused,
    trackedSecondsToday: secondsByTask.get(String(task._id)) || 0,
    runningForMe: running.has(String(task._id)),
  }));
  const mine = tasks.filter((task) => task.assigned);
  const open = mine.filter((task) => task.status.category !== "done");
  return sendResponseObject({
    res,
    data: {
      day,
      timeZone,
      serverNow: now,
      stats: {
        assigned: mine.length,
        backlog: open.filter((task) => task.status.category === "todo").length,
        inProgress: open.filter(
          (task) => task.status.category === "in_progress",
        ).length,
        paused: open.filter((task) => task.status.category === "paused").length,
        dueToday: open.filter((task) => task.dueDay === day).length,
        overdue: open.filter((task) => task.dueDay && task.dueDay < day).length,
        completedToday: mine.filter(
          (task) => task.status.category === "done" && task.completedToday,
        ).length,
        workedOnToday: secondsByTask.size,
        trackedSecondsToday: [...secondsByTask.values()].reduce(
          (sum, seconds) => sum + seconds,
          0,
        ),
        runningTimers: running.size,
      },
      tasks: tasks.filter(
        (task) =>
          task.status.category !== "done" ||
          task.completedToday ||
          task.trackedSecondsToday > 0,
      ),
      reminders: reminders.map((reminder) => ({
        id: String(reminder._id),
        title: reminder.title,
        scheduledAt: reminder.scheduledAt,
        project: projectMap.get(String(reminder.projectId)),
      })),
    },
  });
}
