import ProjectTaskModel from "../models/ProjectTask";
import WorkflowStatusModel from "../models/WorkflowStatus";
import { notifyEmployees } from "../../NotificationModule/services/notificationService";
import { logger } from "../../node-base/utils";

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
let scanInProgress = false;

export async function sendUpcomingTaskReminders() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);
    const candidates = await ProjectTaskModel.find({
      isDeleted: { $ne: true },
      reminder24hSentAt: { $exists: false },
      "assigneeEmployeeIds.0": { $exists: true },
      dueDate: { $gt: now, $lte: windowEnd },
    }).lean();
    if (!candidates.length) return;

    const projectIds = [...new Set(candidates.map((task: any) => String(task.projectId)))];
    const activeStatuses = await WorkflowStatusModel.find({
      projectId: { $in: projectIds },
      category: { $in: ["todo", "in_progress"] },
      isArchived: false,
      isDeleted: { $ne: true },
    }).select("_id").lean();
    const activeStatusIds = new Set(activeStatuses.map((status: any) => String(status._id)));

    for (const task of candidates as any[]) {
      if (!activeStatusIds.has(String(task.workflowStatusId))) continue;
      const dueDate = new Date(task.dueDate);
      if (dueDate <= now || dueDate > windowEnd) continue;

      const claimed = await ProjectTaskModel.findOneAndUpdate(
        { _id: task._id, reminder24hSentAt: { $exists: false } },
        { $set: { reminder24hSentAt: new Date() } },
        { new: true },
      );
      if (!claimed) continue;
      try {
        await notifyEmployees({
          organizationId: String(task.organizationId),
          employeeIds: task.assigneeEmployeeIds.map(String),
          type: "project.task_upcoming",
          title: "Task due within 24 hours",
          message: `${task.key}: ${task.title} · ${dueDate.toLocaleString("en-US", { hour12: true })}`,
          href: `/projects/${task.projectId}/board`,
          projectId: String(task.projectId),
          taskId: String(task._id),
        });
        logger.info(`Sent due-date reminder for ${task.key}`);
      } catch (error) {
        await ProjectTaskModel.updateOne({ _id: task._id }, { $unset: { reminder24hSentAt: 1 } });
        logger.error(`Unable to send upcoming reminder for ${task.key}`, { error });
      }
    }
  } finally {
    scanInProgress = false;
  }
}

export function startTaskReminderWorker() {
  void sendUpcomingTaskReminders().catch((error) => logger.error("Task reminder scan failed", { error }));
  const timer = setInterval(() => {
    void sendUpcomingTaskReminders().catch((error) => logger.error("Task reminder scan failed", { error }));
  }, SCAN_INTERVAL_MS);
  timer.unref();
  return timer;
}
