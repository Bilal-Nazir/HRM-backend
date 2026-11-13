import { randomBytes } from "node:crypto";
import ProjectModel from "../models/Project";
import ProjectTaskModel from "../models/ProjectTask";
import WorkflowStatusModel from "../models/WorkflowStatus";
import { ensurePauseStatus } from "./pauseWorkflowService";
import TaskTimeSessionModel from "../models/TaskTimeSession";
import ProjectActivityModel from "../models/ProjectActivity";
import { logger, ValidationException } from "../../node-base/utils";

export function durationChoice(
  project: any,
  value: unknown,
  current?: number,
): number {
  if (value === null || value === "" || value === undefined)
    throw new ValidationException("Task duration is required");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ValidationException("Choose a valid task duration");
  // Existing selections remain valid if an admin removes their preset.
  if (value !== current && !project.taskDurationOptionsMinutes?.includes(value))
    throw new ValidationException("Choose a duration configured by the admin");
  return value;
}

export function durationDeadline(task: any, startedAt: Date): Date | undefined {
  if (!task.durationMinutes) return undefined;
  const remaining = task.durationMinutes * 60 - (task.accumulatedSeconds || 0);
  if (remaining <= 0)
    throw new ValidationException(
      "This task has reached its duration. Increase its duration before restarting the timer.",
    );
  return new Date(+startedAt + remaining * 1000);
}

type TimedStop = {
  id?: string;
  pending?: boolean;
  startedAt?: Date;
  endedAt?: Date;
  from?: string;
  to?: string;
  action: string;
  reason: "auto_done" | "auto_pause";
  idField: string;
  pendingField: string;
};

async function settleTimedStop(task: any, event: TimedStop) {
  if (!event.pending || !event.id || !event.startedAt || !event.endedAt) return;
  const scope = {
    organizationId: task.organizationId,
    projectId: task.projectId,
    taskId: String(task._id || task.id),
  };
  const startedAt = new Date(event.startedAt),
    endedAt = new Date(event.endedAt);
  const session = await TaskTimeSessionModel.findOne({
    ...scope,
    startedAt,
    isDeleted: { $ne: true },
  });
  const stop = {
    endedAt,
    durationSeconds: Math.max(0, Math.floor((+endedAt - +startedAt) / 1000)),
    stopReason: event.reason,
  };
  if (session)
    await TaskTimeSessionModel.updateOne(
      { _id: session._id, ...scope },
      { $set: stop },
    );
  else
    await TaskTimeSessionModel.findOneAndUpdate(
      { _id: event.id, ...scope },
      {
        $setOnInsert: {
          ...scope,
          employeeId:
            task.assigneeEmployeeIds?.length === 1
              ? task.assigneeEmployeeIds[0]
              : undefined,
          startedByUserId: task.createdBy,
          startedAt,
          ...stop,
        },
      },
      { upsert: true, new: true },
    );
  const statuses = await WorkflowStatusModel.find({
    organizationId: task.organizationId,
    projectId: task.projectId,
    _id: { $in: [event.from, event.to] },
  }).lean();
  const name = (id?: string) =>
    statuses.find((row) => String(row._id) === id)?.name || "Unknown column";
  await ProjectActivityModel.findOneAndUpdate(
    { _id: event.id },
    {
      $setOnInsert: {
        ...scope,
        actorType: "system",
        action: event.action,
        createdAt: endedAt,
        changes: {
          fromStatusId: event.from,
          toStatusId: event.to,
          from: name(event.from),
          to: name(event.to),
          durationMinutes: task.durationMinutes,
          reason: "duration_reached",
          stoppedAt: endedAt,
        },
      },
    },
    { upsert: true, new: true },
  );
  await ProjectTaskModel.updateOne(
    {
      _id: task._id || task.id,
      organizationId: task.organizationId,
      [event.idField]: event.id,
    },
    { $set: { [event.pendingField]: false } },
  );
}

// Finish already-recorded completions from the previous behavior without
// changing historical Done tasks or relabeling their history.
export const settleAutoCompletion = (task: any) =>
  settleTimedStop(task, {
    id: task.autoCompletionId,
    pending: task.autoCompletionPending,
    startedAt: task.autoCompletionStartedAt,
    endedAt: task.completedAt,
    from: task.autoCompletionFromStatusId,
    to: task.workflowStatusId,
    action: "task.auto_completed",
    reason: "auto_done",
    idField: "autoCompletionId",
    pendingField: "autoCompletionPending",
  });
export const settleAutoPause = (task: any) =>
  settleTimedStop(task, {
    id: task.autoPauseId,
    pending: task.autoPausePending,
    startedAt: task.autoPauseStartedAt,
    endedAt: task.autoPausedAt,
    from: task.autoPauseFromStatusId,
    to: task.autoPauseStatusId,
    action: "task.auto_paused",
    reason: "auto_pause",
    idField: "autoPauseId",
    pendingField: "autoPausePending",
  });

export async function pauseTimedTaskIfDue(task: any, now = new Date()) {
  if (
    !task.durationMinutes ||
    !task.timeStartedAt ||
    task.isDeleted ||
    task.autoPaused
  )
    return null;
  const remaining = Math.max(
    0,
    task.durationMinutes * 60 - (task.accumulatedSeconds || 0),
  );
  const endedAt = new Date(+new Date(task.timeStartedAt) + remaining * 1000);
  if (+endedAt > +now) return null;
  const scope = {
    organizationId: task.organizationId,
    projectId: task.projectId,
    isDeleted: { $ne: true },
  };
  const project = await ProjectModel.findOne({
    _id: task.projectId,
    organizationId: task.organizationId,
    isDeleted: { $ne: true },
    status: { $ne: "archived" },
  });
  if (!project) return null;
  const target = await ensurePauseStatus(project);
  const updated = await ProjectTaskModel.findOneAndUpdate(
    {
      _id: task._id || task.id,
      ...scope,
      workflowStatusId: task.workflowStatusId,
      timeStartedAt: task.timeStartedAt,
      durationMinutes: task.durationMinutes,
      accumulatedSeconds: task.accumulatedSeconds || 0,
      autoPaused: { $ne: true },
    },
    {
      $set: {
        workflowStatusId: target.id,
        accumulatedSeconds: Math.max(
          task.durationMinutes * 60,
          task.accumulatedSeconds || 0,
        ),
        timeStoppedAt: endedAt,
        autoPausedAt: endedAt,
        autoPaused: true,
        durationExtensionRequired: true,
        autoPauseId: randomBytes(12).toString("hex"),
        autoPauseStartedAt: task.timeStartedAt,
        autoPauseFromStatusId: task.workflowStatusId,
        autoPauseStatusId: target.id,
        autoPausePending: true,
      },
      $unset: {
        timeStartedAt: 1,
        autoCompleteAt: 1,
        completedAt: 1,
        completionMethod: 1,
      },
    },
    { new: true },
  );
  if (!updated) return null;
  await settleAutoPause(updated);
  return updated;
}

let scanning = false;
export async function pauseDueTasks(now = new Date()) {
  if (scanning) return;
  scanning = true;
  try {
    const due = await ProjectTaskModel.find({
      isDeleted: { $ne: true },
      autoCompleteAt: { $lte: now },
      timeStartedAt: { $exists: true },
      durationMinutes: { $gt: 0 },
      autoPaused: { $ne: true },
    })
      .limit(200)
      .lean();
    for (const task of due) {
      try {
        await pauseTimedTaskIfDue(task, now);
      } catch (error) {
        logger.error("Task auto-pause failed", {
          taskId: String(task._id),
          error,
        });
      }
    }
    const pending = await ProjectTaskModel.find({ autoPausePending: true })
      .limit(200)
      .lean();
    for (const task of pending) {
      try {
        await settleAutoPause(task);
      } catch (error) {
        logger.error("Task auto-pause settlement failed", {
          taskId: String(task._id),
          error,
        });
      }
    }
    const legacy = await ProjectTaskModel.find({ autoCompletionPending: true })
      .limit(200)
      .lean();
    for (const task of legacy) {
      try {
        await settleAutoCompletion(task);
      } catch (error) {
        logger.error("Legacy completion settlement failed", {
          taskId: String(task._id),
          error,
        });
      }
    }
  } finally {
    scanning = false;
  }
}

export function startTaskDurationWorker() {
  const run = () => {
    void pauseDueTasks().catch((error) =>
      logger.error("Task duration scan failed", { error }),
    );
  };
  run();
  const timer = setInterval(run, 1000);
  timer.unref();
  return timer;
}
