import ProjectTaskModel from "../models/ProjectTask";
import TaskTimeSessionModel from "../models/TaskTimeSession";
import ProjectActivityModel from "../models/ProjectActivity";
import { pauseTimedTaskIfDue } from "./taskDurationService";

type Checkout = { organizationId: string; employeeId: string; userId: string; at: Date };

export async function pauseEmployeeTimersAtCheckout({ organizationId, employeeId, userId, at }: Checkout) {
  const sessions = await TaskTimeSessionModel.find({ organizationId, employeeId, endedAt: { $exists: false }, startedAt: { $lte: at } }).lean();
  const tasks = await ProjectTaskModel.find({
    organizationId,
    timeStartedAt: { $lte: at },
    $or: [{ assigneeEmployeeIds: employeeId }, { _id: { $in: sessions.map((session) => session.taskId) } }],
  }).lean();
  const activeSessions = await TaskTimeSessionModel.find({ organizationId, taskId: { $in: tasks.map((task) => String(task._id)) }, endedAt: { $exists: false }, startedAt: { $lte: at } }).sort({ startedAt: -1 }).lean();
  const stopped: { taskId: string; projectId: string; seconds: number }[] = [];
  for (const task of tasks) {
    if (!task.timeStartedAt) continue;
    const startedAt = new Date(task.timeStartedAt);
    const taskId = String(task._id);
    const taskSessions = activeSessions.filter((session) => session.taskId === taskId);
    const owner = taskSessions.find((session) => +new Date(session.startedAt) === +startedAt) || taskSessions[0];
    if (owner?.employeeId && owner.employeeId !== employeeId) continue;
    if (!owner?.employeeId && !task.assigneeEmployeeIds.includes(employeeId)) continue;
    if (task.durationMinutes && await pauseTimedTaskIfDue(task, at)) continue;
    const seconds = Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / 1000));
    // Compare the running interval so a retry cannot add elapsed time twice.
    const updated = await ProjectTaskModel.findOneAndUpdate(
      { _id: task._id, organizationId, timeStartedAt: task.timeStartedAt },
      { $inc: { accumulatedSeconds: seconds }, $set: { timeStoppedAt: at }, $unset: { timeStartedAt: 1, autoCompleteAt: 1 } },
      { new: true },
    );
    if (!updated) continue;
    if (!owner) {
      // Timers started before detailed session tracking still retain their
      // known running interval when they are stopped at checkout.
      await TaskTimeSessionModel.create({ organizationId, projectId: task.projectId, taskId, employeeId, startedByUserId: userId, startedAt, endedAt: at, durationSeconds: seconds, stopReason: "checkout" });
    } else if (!owner.employeeId) {
      await TaskTimeSessionModel.updateOne({ _id: owner._id, organizationId, endedAt: { $exists: false } }, { $set: { employeeId, endedAt: at, durationSeconds: Math.max(0, Math.floor((at.getTime() - new Date(owner.startedAt).getTime()) / 1000)), stopReason: "checkout" } });
    }
    stopped.push({ taskId, projectId: task.projectId, seconds });
  }
  // Also close stale open intervals belonging to this employee, including
  // intervals whose task was already paused, unassigned, or removed.
  for (const session of sessions) {
    await TaskTimeSessionModel.updateOne({ _id: session._id, organizationId, employeeId, endedAt: { $exists: false } }, { $set: { endedAt: at, durationSeconds: Math.max(0, Math.floor((at.getTime() - new Date(session.startedAt).getTime()) / 1000)), stopReason: "checkout" } });
  }
  if (stopped.length) await ProjectActivityModel.insertMany(stopped.map((task) => ({ organizationId, projectId: task.projectId, taskId: task.taskId, actorUserId: userId, actorEmployeeId: employeeId, action: "task.timer_auto_paused", changes: { reason: "checkout", stoppedAt: at, durationSeconds: task.seconds } })));
  return stopped;
}
