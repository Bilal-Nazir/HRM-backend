import { randomBytes } from "node:crypto";
import ProjectModel from "../models/Project";
import ProjectTaskModel from "../models/ProjectTask";
import WorkflowStatusModel from "../models/WorkflowStatus";
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
  if (!project.autoCompleteStatusId)
    throw new ValidationException(
      "Ask an admin to configure a completion column first",
    );
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

export async function settleAutoCompletion(task: any) {
  if (
    !task.autoCompletionPending ||
    !task.autoCompletionId ||
    !task.completedAt ||
    !task.autoCompletionStartedAt
  )
    return;
  const scope = {
    organizationId: task.organizationId,
    projectId: task.projectId,
    taskId: String(task._id || task.id),
  };
  const endedAt = new Date(task.completedAt),
    startedAt = new Date(task.autoCompletionStartedAt);
  let session = await TaskTimeSessionModel.findOne({
    ...scope,
    startedAt,
    isDeleted: { $ne: true },
  });
  if (session) {
    // Idempotent and also corrects a checkout/pause racing with the deadline.
    await TaskTimeSessionModel.updateOne(
      { _id: session._id, ...scope },
      {
        $set: {
          endedAt,
          durationSeconds: Math.max(
            0,
            Math.floor((+endedAt - +startedAt) / 1000),
          ),
          stopReason: "auto_done",
        },
      },
    );
  } else {
    session = await TaskTimeSessionModel.findOneAndUpdate(
      { _id: task.autoCompletionId, ...scope },
      {
        $setOnInsert: {
          ...scope,
          employeeId:
            task.assigneeEmployeeIds?.length === 1
              ? task.assigneeEmployeeIds[0]
              : undefined,
          startedByUserId: task.createdBy,
          startedAt,
          endedAt,
          durationSeconds: Math.max(
            0,
            Math.floor((+endedAt - +startedAt) / 1000),
          ),
          stopReason: "auto_done",
        },
      },
      { upsert: true, new: true },
    );
  }
  const statuses = await WorkflowStatusModel.find({
    organizationId: task.organizationId,
    projectId: task.projectId,
    _id: { $in: [task.autoCompletionFromStatusId, task.workflowStatusId] },
  }).lean();
  const name = (id: string) =>
    statuses.find((row) => String(row._id) === id)?.name || "Unknown column";
  await ProjectActivityModel.findOneAndUpdate(
    { _id: task.autoCompletionId },
    {
      $setOnInsert: {
        ...scope,
        actorUserId: "system",
        action: "task.auto_completed",
        createdAt: endedAt,
        changes: {
          fromStatusId: task.autoCompletionFromStatusId,
          toStatusId: task.workflowStatusId,
          from: name(task.autoCompletionFromStatusId),
          to: name(task.workflowStatusId),
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
      autoCompletionId: task.autoCompletionId,
    },
    { $set: { autoCompletionPending: false } },
  );
}

export async function completeTimedTaskIfDue(task: any, now = new Date()) {
  if (!task.durationMinutes || !task.timeStartedAt || task.isDeleted)
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
  if (!project?.autoCompleteStatusId) return null;
  const target = await WorkflowStatusModel.findOne({
    _id: project.autoCompleteStatusId,
    ...scope,
    isArchived: false,
    category: "done",
  });
  if (!target) return null;
  const updated = await ProjectTaskModel.findOneAndUpdate(
    {
      _id: task._id || task.id,
      ...scope,
      workflowStatusId: task.workflowStatusId,
      timeStartedAt: task.timeStartedAt,
      durationMinutes: task.durationMinutes,
      accumulatedSeconds: task.accumulatedSeconds || 0,
    },
    {
      $set: {
        workflowStatusId: target.id,
        accumulatedSeconds: Math.max(
          task.durationMinutes * 60,
          task.accumulatedSeconds || 0,
        ),
        timeStoppedAt: endedAt,
        completedAt: endedAt,
        completionMethod: "auto",
        autoCompletionId: randomBytes(12).toString("hex"),
        autoCompletionStartedAt: task.timeStartedAt,
        autoCompletionFromStatusId: task.workflowStatusId,
        autoCompletionPending: true,
      },
      $unset: { timeStartedAt: 1, autoCompleteAt: 1 },
    },
    { new: true },
  );
  if (!updated) return null;
  await settleAutoCompletion(updated);
  return updated;
}

let scanning = false;
export async function completeDueTasks(now = new Date()) {
  if (scanning) return;
  scanning = true;
  try {
    // The deadline is stored on the server; no browser needs to remain open.
    const due = await ProjectTaskModel.find({
      isDeleted: { $ne: true },
      autoCompleteAt: { $lte: now },
      timeStartedAt: { $exists: true },
      durationMinutes: { $gt: 0 },
    })
      .limit(200)
      .lean();
    for (const task of due) {
      try {
        await completeTimedTaskIfDue(task, now);
      } catch (error) {
        logger.error("Task auto-completion failed", {
          taskId: String(task._id),
          error,
        });
      }
    }
    const pending = await ProjectTaskModel.find({ autoCompletionPending: true })
      .limit(200)
      .lean();
    for (const task of pending) {
      try {
        await settleAutoCompletion(task);
      } catch (error) {
        logger.error("Task auto-completion settlement failed", {
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
    void completeDueTasks().catch((error) =>
      logger.error("Task duration scan failed", { error }),
    );
  };
  run();
  const timer = setInterval(run, 1000);
  timer.unref();
  return timer;
}
