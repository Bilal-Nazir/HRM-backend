import { Response } from "express";
import { isValidObjectId } from "mongoose";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import { ConflictException, ForbiddenException, ObjectNotFoundException, ValidationException, sendResponseObject } from "../../node-base/utils";
import ProjectModel from "../models/Project";
import ProjectMemberModel from "../models/ProjectMember";
import WorkflowStatusModel from "../models/WorkflowStatus";
import ProjectTaskModel from "../models/ProjectTask";
import ProjectCommentModel from "../models/ProjectComment";
import ProjectActivityModel from "../models/ProjectActivity";
import ProjectAttachmentModel from "../models/ProjectAttachment";
import ProjectReminderModel from "../models/ProjectReminder";
import TaskTimeSessionModel from "../models/TaskTimeSession";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { notifyEmployees, projectManagerEmployeeIds } from "../../NotificationModule/services/notificationService";
import { readTaskDetails } from "../services/taskDetailService";
import { sameHistoryValue } from "../services/taskHistory";
import { pauseTimedTaskIfDue, durationChoice, durationDeadline, settleAutoCompletion, settleAutoPause } from "../services/taskDurationService";

import { ensurePauseStatus } from "../services/pauseWorkflowService";

const object = (value: unknown, label = "ID") => {
  if (typeof value !== "string" || !isValidObjectId(value)) throw new ValidationException(`Invalid ${label}`);
  return value;
};
const clean = (value: unknown, label: string, max = 200) => {
  if (typeof value !== "string" || !value.trim()) throw new ValidationException(`${label} is required`);
  if (value.trim().length > max) throw new ValidationException(`${label} is too long`);
  return value.trim();
};
const optionalDate = (value: unknown) => {
  if (!value) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ValidationException("Invalid date");
  return date;
};
const serialize = (doc: any) => {
  const value = doc?.toObject ? doc.toObject() : doc;
  if (!value) return value;
  const { _id, __v, ...rest } = value;
  return { id: String(_id), ...rest };
};
const isAdmin = (req: AuthenticatedRequest) => req.auth!.permissions.includes("*") || req.auth!.permissions.includes("project.manage");
const isCompanyAdmin = (req: AuthenticatedRequest) => !!(req.auth!.isCompanyOwner || req.auth!.isPlatformAdmin || req.auth!.permissions.includes("*"));
const param = (req: AuthenticatedRequest, name: string) => String(req.params[name]);
const activity = (req: AuthenticatedRequest, projectId: string, action: string, taskId?: string, changes?: Record<string, unknown>) =>
  ProjectActivityModel.create({ organizationId: req.auth!.organizationId!, projectId, taskId, actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, action, changes });
const notifyProject = async (req: AuthenticatedRequest, project: any, task: any, type: string, title: string, message: string, employeeIds: string[]) => {
  const managers = await projectManagerEmployeeIds(req.auth!.organizationId!, project.id,);
  await notifyEmployees({ organizationId: req.auth!.organizationId!, employeeIds: [...employeeIds, ...managers], actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, type, title, message, href: task?.id ? `/projects/${project.id}/tasks/${task.id}${type.includes("comment") ? "?activity=comments" : ""}` : `/projects/${project.id}/board`, projectId: project.id, taskId: task?.id });
};
const timerActionFor = (status: any): "none" | "start" | "stop" => {
  if (status?.category === "done" || status?.category === "paused" || status?.systemKey === "pause") return "stop";
  if (["none", "start", "stop"].includes(status?.timerAction)) return status.timerAction;
  // Preserve the original behaviour for workflow columns created before
  // timerAction existed. Saving the column makes the choice explicit.
  if (status?.category === "in_progress") return "start";
  if (status?.category === "done") return "stop";
  return "none";
};
const timerEmployeeId = (req: AuthenticatedRequest, task: any) => task.assigneeEmployeeIds?.includes(req.auth!.employeeId) ? req.auth!.employeeId : task.assigneeEmployeeIds?.length === 1 ? task.assigneeEmployeeIds[0] : req.auth!.employeeId;
const startTimerSession = (req: AuthenticatedRequest, task: any, startedAt: Date) => TaskTimeSessionModel.create({ organizationId: req.auth!.organizationId, projectId: task.projectId, taskId: task.id, employeeId: timerEmployeeId(req, task), startedByUserId: req.auth!.userId, startedAt });
const stopTimerSession = async (req: AuthenticatedRequest, task: any, endedAt: Date, reason: "pause" | "status_change", fallbackStartedAt: Date) => {
  const open = await TaskTimeSessionModel.findOne({ organizationId: req.auth!.organizationId, taskId: task.id, startedAt: fallbackStartedAt, endedAt: { $exists: false }, isDeleted: { $ne: true } }).sort({ startedAt: -1 });
  if (open) { open.endedAt = endedAt; open.durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - open.startedAt.getTime()) / 1000)); open.stopReason = reason; await open.save(); return; }
  await TaskTimeSessionModel.create({ organizationId: req.auth!.organizationId, projectId: task.projectId, taskId: task.id, employeeId: timerEmployeeId(req, task), startedByUserId: req.auth!.userId, startedAt: fallbackStartedAt, endedAt, durationSeconds: Math.max(0, Math.floor((endedAt.getTime() - fallbackStartedAt.getTime()) / 1000)), stopReason: reason });
};

async function visibleTask(req: AuthenticatedRequest, projectId: string, taskId: string) {
  const task = await ProjectTaskModel.findOne({ _id: object(taskId, "task ID"), organizationId: req.auth!.organizationId, projectId, isDeleted: { $ne: true } });
  if (!task) throw new ObjectNotFoundException("Task");
  if (task.autoCompletionPending) await settleAutoCompletion(task);
  if (task.autoPausePending) await settleAutoPause(task);
  return task;
}

// Compete atomically with the background deadline worker. A stale pause/move
// must never resurrect a timer or overwrite an automatic pause.
async function saveTaskClock(task: any, before: any) {
  if (!before.durationMinutes && !task.durationMinutes) { await task.save(); return; }
  const fields = ["workflowStatusId", "timeStartedAt", "timeStoppedAt", "accumulatedSeconds", "autoCompleteAt", "completionMethod", "completedAt", "autoPaused", "durationExtensionRequired"];
  const set: any = {}, unset: any = {};
  for (const key of fields) { if (task[key] === undefined) unset[key] = 1; else set[key] = task[key]; }
  const updated = await ProjectTaskModel.findOneAndUpdate({ _id: task.id, organizationId: task.organizationId, isDeleted: { $ne: true }, workflowStatusId: before.workflowStatusId, timeStartedAt: before.timeStartedAt || { $exists: false }, durationMinutes: before.durationMinutes || { $exists: false }, accumulatedSeconds: before.accumulatedSeconds || 0, autoPaused: before.autoPaused ? true : { $ne: true }, durationExtensionRequired: before.durationExtensionRequired ? true : { $ne: true } }, { $set: set, $unset: unset }, { new: true });
  if (!updated) throw new ConflictException("The task timer changed. Refresh the task and try again.");
  Object.assign(task, updated.toObject());
}

async function projectAccess(req: AuthenticatedRequest, projectId: string, write = false, adminOnly = false) {
  object(projectId, "project ID");
  const project = await ProjectModel.findOne({ _id: projectId, organizationId: req.auth!.organizationId, isDeleted: { $ne: true } });
  if (!project) throw new ObjectNotFoundException("Project");
  if (adminOnly && !isAdmin(req)) throw new ForbiddenException();
  let member: any = null;
  if (!isAdmin(req)) {
    if (!req.auth!.employeeId) throw new ForbiddenException();
    member = await ProjectMemberModel.findOne({ organizationId: req.auth!.organizationId, projectId, employeeId: req.auth!.employeeId, status: "active", isDeleted: { $ne: true } });
    if (!member) throw new ObjectNotFoundException("Project");
    if (write && member.role === "viewer") throw new ForbiddenException("Viewers cannot modify projects");
  }
  if (write && project.status === "archived") throw new ConflictException("Archived projects are read-only until restored");
  await ensurePauseStatus(project);
  return { project, member };
}

async function enrichMembers(organizationId: string, rows: any[]) {
  const employees = await EmployeeModel.find({ organizationId, _id: { $in: rows.map((row) => row.employeeId) } }).select("firstName lastName employeeCode workEmail jobTitle departmentId employmentStatus").lean();
  const map = new Map(employees.map((person: any) => [String(person._id), serialize(person)]));
  return rows.map((row) => ({ ...serialize(row), employee: map.get(row.employeeId) || null }));
}

export const listProjects = async (req: AuthenticatedRequest, res: Response) => {
  const organizationId = req.auth!.organizationId!;
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(50, Math.max(1, Number(req.query.size) || 12));
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const membership = !isAdmin(req) ? await ProjectMemberModel.find({ organizationId, employeeId: req.auth!.employeeId, status: "active", isDeleted: { $ne: true } }).distinct("projectId") : null;
  const filter: any = { organizationId, isDeleted: { $ne: true }, ...(membership ? { _id: { $in: membership } } : {}), ...(status ? { status } : {}), ...(search ? { $or: [{ name: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { key: new RegExp(search, "i") }] } : {}) };
  const [projects, totalCount] = await Promise.all([ProjectModel.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * size).limit(size).lean(), ProjectModel.countDocuments(filter)]);
  const ids = projects.map((project: any) => String(project._id));
  const [members, tasks, doneStatuses, managers] = await Promise.all([
    ProjectMemberModel.aggregate([{ $match: { organizationId, projectId: { $in: ids }, status: "active", isDeleted: { $ne: true } } }, { $group: { _id: "$projectId", count: { $sum: 1 } } }]),
    ProjectTaskModel.aggregate([{ $match: { organizationId, projectId: { $in: ids }, isDeleted: { $ne: true } } }, { $group: { _id: "$projectId", total: { $sum: 1 }, statusIds: { $push: "$workflowStatusId" } } }]),
    WorkflowStatusModel.find({ organizationId, projectId: { $in: ids }, category: "done", isDeleted: { $ne: true } }).select("projectId _id").lean(),
    EmployeeModel.find({ organizationId, _id: { $in: projects.map((project: any) => project.managerEmployeeId).filter(Boolean) } }).select("firstName lastName employeeCode").lean(),
  ]);
  const memberMap = new Map(members.map((row: any) => [row._id, row.count]));
  const taskMap = new Map(tasks.map((row: any) => [row._id, row]));
  const doneMap = new Map<string, Set<string>>();
  doneStatuses.forEach((status: any) => { const key = status.projectId; if (!doneMap.has(key)) doneMap.set(key, new Set()); doneMap.get(key)!.add(String(status._id)); });
  const managerMap = new Map(managers.map((employee: any) => [String(employee._id), { id: String(employee._id), name: `${employee.firstName} ${employee.lastName}`, employeeCode: employee.employeeCode }]));
  return sendResponseObject({ res, data: { projects: projects.map((project: any) => { const row = taskMap.get(String(project._id)); const totalTasks = row?.total || 0; const completedTasks = row?.statusIds.filter((id: string) => doneMap.get(String(project._id))?.has(id)).length || 0; return { ...serialize(project), manager: managerMap.get(project.managerEmployeeId) || null, memberCount: memberMap.get(String(project._id)) || 0, totalTasks, completedTasks, progress: totalTasks ? Math.round(completedTasks / totalTasks * 100) : 0 }; }), totalCount, page, lastPage: Math.ceil(totalCount / size) } });
};

export const dashboardSummary = async (req: AuthenticatedRequest, res: Response) => {
  const organizationId = req.auth!.organizationId!;
  const membership = !isAdmin(req)
    ? await ProjectMemberModel.find({ organizationId, employeeId: req.auth!.employeeId, status: "active", isDeleted: { $ne: true } }).distinct("projectId")
    : null;
  const projectFilter: any = {
    organizationId,
    isDeleted: { $ne: true },
    ...(membership ? { _id: { $in: membership } } : {}),
  };
  const projects = await ProjectModel.find(projectFilter).sort({ updatedAt: -1 }).lean();
  const projectIds = projects.map((project: any) => String(project._id));
  const [tasks, workflow] = await Promise.all([
    ProjectTaskModel.find({ organizationId, projectId: { $in: projectIds }, isDeleted: { $ne: true } }).select("projectId workflowStatusId dueDate priority assigneeEmployeeIds").lean(),
    WorkflowStatusModel.find({ organizationId, projectId: { $in: projectIds }, isArchived: false, isDeleted: { $ne: true } }).select("projectId _id category").lean(),
  ]);
  const doneIds = new Set(workflow.filter((status: any) => status.category === "done").map((status: any) => String(status._id)));
  const inProgressIds = new Set(workflow.filter((status: any) => status.category === "in_progress").map((status: any) => String(status._id)));
  const now = new Date();
  const completedTasks = tasks.filter((task: any) => doneIds.has(task.workflowStatusId)).length;
  const inProgressTasks = tasks.filter((task: any) => inProgressIds.has(task.workflowStatusId)).length;
  const overdueTasks = tasks.filter((task: any) => task.dueDate && new Date(task.dueDate) < now && !doneIds.has(task.workflowStatusId)).length;
  const projectRows = projects.map((project: any) => {
    const rows = tasks.filter((task: any) => task.projectId === String(project._id));
    const completed = rows.filter((task: any) => doneIds.has(task.workflowStatusId)).length;
    const overdue = rows.filter((task: any) => task.dueDate && new Date(task.dueDate) < now && !doneIds.has(task.workflowStatusId)).length;
    return {
      id: String(project._id),
      name: project.name,
      key: project.key,
      status: project.status,
      totalTasks: rows.length,
      completedTasks: completed,
      overdueTasks: overdue,
      progress: rows.length ? Math.round((completed / rows.length) * 100) : 0,
    };
  });
  const statusCounts = projects.reduce((counts: Record<string, number>, project: any) => {
    counts[project.status] = (counts[project.status] || 0) + 1;
    return counts;
  }, {});
  return sendResponseObject({
    res,
    data: {
      totalProjects: projects.length,
      activeProjects: projects.filter((project: any) => project.status === "active").length,
      totalTasks: tasks.length,
      completedTasks,
      inProgressTasks,
      overdueTasks,
      completionRate: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0,
      unassignedTasks: tasks.filter((task: any) => !task.assigneeEmployeeIds?.length).length,
      statusCounts,
      projects: projectRows.slice(0, 6),
    },
  });
};

export const createProject = async (req: AuthenticatedRequest, res: Response) => {
  if (!isAdmin(req)) throw new ForbiddenException();
  const organizationId = req.auth!.organizationId!, name = clean(req.body.name, "Project name", 120), key = clean(req.body.key, "Project key", 10).toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new ValidationException("Project key must be 2-10 uppercase letters or numbers");
  if (await ProjectModel.exists({ organizationId, key, isDeleted: { $ne: true } })) throw new ConflictException("Project key already exists");
  const managerEmployeeId = req.body.managerEmployeeId ? object(req.body.managerEmployeeId, "manager employee ID") : req.auth!.employeeId;
  if (!managerEmployeeId || !(await EmployeeModel.exists({ _id: managerEmployeeId, organizationId, employmentStatus: "active", isDeleted: { $ne: true } }))) throw new ValidationException("Select an active project manager from this organization");
  const project = await ProjectModel.create({ organizationId, name, key, description: String(req.body.description || "").trim(), managerEmployeeId, startDate: optionalDate(req.body.startDate), targetEndDate: optionalDate(req.body.targetEndDate), priority: req.body.priority || "medium", status: req.body.status || "planned", createdBy: req.auth!.userId });
  await Promise.all([
    ProjectMemberModel.create({ organizationId, projectId: project.id, employeeId: managerEmployeeId, role: "project_manager", addedBy: req.auth!.userId }),
    WorkflowStatusModel.insertMany([
      { organizationId, projectId: project.id, name: "Backlog", order: 0, category: "todo", color: "#7c8b84", isDefault: true, timerAction: "none" },
      { organizationId, projectId: project.id, name: "In Progress", order: 1, category: "in_progress", color: "#3b8ff3", timerAction: "start" },
      { organizationId, projectId: project.id, name: "Pause", order: 2, category: "paused", systemKey: "pause", color: "#d99b32", timerAction: "stop" },
      { organizationId, projectId: project.id, name: "Done", order: 3, category: "done", color: "#149b7b", timerAction: "stop" },
    ]),
  ]);
  const statuses = await WorkflowStatusModel.find({ projectId: project.id }).sort({ order: 1 });
  for (let i = 0; i < statuses.length; i++) statuses[i].allowedTransitionIds = statuses.filter((_, j) => Math.abs(i - j) === 1).map((status) => status.id);
  await Promise.all(statuses.map((status) => status.save()));
  project.pauseStatusId = statuses.find((status) => status.systemKey === "pause")?.id;
  await project.save();
  await activity(req, project.id, "project.created", undefined, { name, key });
  return sendResponseObject({ res, code: 201, data: { project: serialize(project) } });
};

export const getProject = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"));
  const [members, statuses] = await Promise.all([ProjectMemberModel.find({ organizationId: req.auth!.organizationId, projectId: project.id, status: "active", isDeleted: { $ne: true } }), WorkflowStatusModel.find({ organizationId: req.auth!.organizationId, projectId: project.id, isDeleted: { $ne: true } }).sort({ order: 1 })]);
  return sendResponseObject({ res, data: { project: serialize(project), members: await enrichMembers(req.auth!.organizationId!, members), workflow: statuses.map(serialize) } });
};

export const updateProject = async (req: AuthenticatedRequest, res: Response) => {
  const { project, member } = await projectAccess(req, param(req, "id"), true);
  if (!isAdmin(req) && member?.role !== "project_manager") throw new ForbiddenException();
  const allowed = ["name", "description", "priority", "status", "startDate", "targetEndDate"];
  const changes: any = {};
  allowed.forEach((field) => { if (req.body[field] !== undefined) changes[field] = ["startDate", "targetEndDate"].includes(field) ? optionalDate(req.body[field]) : req.body[field]; });
  if (changes.name !== undefined) changes.name = clean(changes.name, "Project name", 120);
  Object.assign(project, changes); await project.save();
  await activity(req, project.id, "project.updated", undefined, changes);
  return sendResponseObject({ res, data: { project: serialize(project) } });
};

export const archiveProject = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), false, true);
  project.status = req.body.restore ? "active" : "archived"; await project.save();
  await activity(req, project.id, req.body.restore ? "project.restored" : "project.archived");
  return sendResponseObject({ res, data: { project: serialize(project) } });
};

export const overview = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"));
  const organizationId = req.auth!.organizationId!, now = new Date();
  const [statuses, tasks, members] = await Promise.all([WorkflowStatusModel.find({ organizationId, projectId: project.id, isDeleted: { $ne: true }, isArchived: false }).sort({ order: 1 }).lean(), ProjectTaskModel.find({ organizationId, projectId: project.id, isDeleted: { $ne: true } }).lean(), ProjectMemberModel.find({ organizationId, projectId: project.id, status: "active", isDeleted: { $ne: true } })]);
  const done = new Set(statuses.filter((status: any) => status.category === "done").map((status: any) => String(status._id)));
  const distribution = statuses.map((status: any) => ({ status: serialize(status), count: tasks.filter((task: any) => task.workflowStatusId === String(status._id)).length }));
  return sendResponseObject({ res, data: { project: serialize(project), totalTasks: tasks.length, completedTasks: tasks.filter((task: any) => done.has(task.workflowStatusId)).length, overdueTasks: tasks.filter((task: any) => task.dueDate && new Date(task.dueDate) < now && !done.has(task.workflowStatusId)).length, upcoming: tasks.filter((task: any) => task.dueDate && new Date(task.dueDate) >= now).sort((a: any,b: any) => +new Date(a.dueDate)-+new Date(b.dueDate)).slice(0,5).map(serialize), distribution, members: await enrichMembers(organizationId, members) } });
};

export const listMembers = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"));
  const rows = await ProjectMemberModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, status: "active", isDeleted: { $ne: true } }).sort({ createdAt: 1 });
  return sendResponseObject({ res, data: { members: await enrichMembers(req.auth!.organizationId!, rows) } });
};

export const addMembers = async (req: AuthenticatedRequest, res: Response) => {
  const { member } = await projectAccess(req, param(req, "id"), true);
  if (!isAdmin(req) && member?.role !== "project_manager") throw new ForbiddenException();
  const entries = Array.isArray(req.body.members) ? req.body.members : [];
  if (!entries.length) throw new ValidationException("Select at least one employee");
  const ids: string[] = [...new Set<string>(entries.map((entry: any) => object(entry.employeeId, "employee ID")))];
  const active = await EmployeeModel.find({ organizationId: req.auth!.organizationId, _id: { $in: ids }, employmentStatus: "active", isDeleted: { $ne: true } }).distinct("_id");
  if (active.length !== ids.length) throw new ValidationException("Only active employees in this organization can be added");
  for (const entry of entries) await ProjectMemberModel.findOneAndUpdate({ organizationId: req.auth!.organizationId, projectId: req.params.id, employeeId: entry.employeeId }, { $set: { role: ["project_manager", "member", "viewer"].includes(entry.role) ? entry.role : "member", status: "active", isDeleted: false, addedBy: req.auth!.userId }, $unset: { removedAt: 1 } }, { upsert: true, new: true });
  await activity(req, param(req, "id"), "members.added", undefined, { employeeIds: ids });
  const project = await ProjectModel.findById(req.params.id);
  if (project) await notifyEmployees({ organizationId: req.auth!.organizationId!, employeeIds: ids, actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, type: "project.member_added", title: `Added to ${project.name}`, message: "You were added to this project.", href: `/projects/${project.id}`, projectId: project.id });
  return listMembers(req, res);
};

export const updateMember = async (req: AuthenticatedRequest, res: Response) => {
  const { project, member } = await projectAccess(req, param(req, "id"), true);
  if (!isAdmin(req) && member?.role !== "project_manager") throw new ForbiddenException();
  if (!["project_manager", "member", "viewer"].includes(req.body.role)) throw new ValidationException("Invalid project role");
  const target = await ProjectMemberModel.findOne({ organizationId: req.auth!.organizationId, projectId: project.id, employeeId: object(param(req, "employeeId")), status: "active", isDeleted: { $ne: true } });
  if (!target) throw new ObjectNotFoundException("Project member");
  target.role = req.body.role; await target.save();
  if (req.body.role === "project_manager") { project.managerEmployeeId = target.employeeId; await project.save(); }
  await activity(req, project.id, "member.role_changed", undefined, { employeeId: target.employeeId, role: target.role });
  return sendResponseObject({ res, data: { member: serialize(target) } });
};

export const removeMember = async (req: AuthenticatedRequest, res: Response) => {
  const { project, member } = await projectAccess(req, param(req, "id"), true);
  if (!isAdmin(req) && member?.role !== "project_manager") throw new ForbiddenException();
  const employeeId = object(param(req, "employeeId")), target = await ProjectMemberModel.findOne({ organizationId: req.auth!.organizationId, projectId: project.id, employeeId, status: "active", isDeleted: { $ne: true } });
  if (!target) throw new ObjectNotFoundException("Project member");
  if (project.managerEmployeeId === employeeId) throw new ConflictException("Assign another project manager before removing this member");
  const assignedCount = await ProjectTaskModel.countDocuments({ organizationId: req.auth!.organizationId, projectId: project.id, assigneeEmployeeIds: employeeId, isDeleted: { $ne: true } });
  if (assignedCount && !req.body.confirmUnassign) throw new ConflictException(`${assignedCount} active tasks are assigned to this member. Confirm unassignment to continue.`);
  if (assignedCount) {
    const affected = await ProjectTaskModel.find({ organizationId: req.auth!.organizationId, projectId: project.id, assigneeEmployeeIds: employeeId }).select("assigneeEmployeeIds").lean();
    await ProjectTaskModel.updateMany({ organizationId: req.auth!.organizationId, projectId: project.id, assigneeEmployeeIds: employeeId }, { $pull: { assigneeEmployeeIds: employeeId } });
    await ProjectActivityModel.insertMany(affected.map((task) => ({ organizationId: req.auth!.organizationId, projectId: project.id, taskId: String(task._id), actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, action: "task.updated", changes: { reason: "member_removed", before: { assigneeEmployeeIds: task.assigneeEmployeeIds }, after: { assigneeEmployeeIds: task.assigneeEmployeeIds.filter((id) => id !== employeeId) } } })));
  }
  target.status = "removed"; target.removedAt = new Date(); await target.save();
  await activity(req, project.id, "member.removed", undefined, { employeeId, unassignedTasks: assignedCount });
  return sendResponseObject({ res, data: { removed: true, unassignedTasks: assignedCount } });
};

export const getWorkflow = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"));
  const workflow = await WorkflowStatusModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } }).sort({ order: 1 });
  return sendResponseObject({ res, data: { workflow: workflow.map(serialize) } });
};

export const updateDurationSettings = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true, true);
  const values = req.body.taskDurationOptionsMinutes;
  if (!Array.isArray(values) || values.length < 1 || values.length > 50 || values.some((value: unknown) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 525600)) throw new ValidationException("Provide at least one and up to 50 durations, from 1 minute to 365 days");
  const options = [...new Set<number>(values)].sort((a, b) => a - b);
  const before = { taskDurationOptionsMinutes: project.taskDurationOptionsMinutes };
  project.taskDurationOptionsMinutes = options; await project.save();
  await activity(req, project.id, "workflow.duration_settings_updated", undefined, { before, after: { taskDurationOptionsMinutes: options, pauseStatusId: project.pauseStatusId } });
  return sendResponseObject({ res, data: { project: serialize(project) } });
};

export const createStatus = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"), true, true);
  const count = await WorkflowStatusModel.countDocuments({ organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } });
  const timerAction = ["none", "start", "stop"].includes(req.body.timerAction) ? req.body.timerAction : "none";
  const status = await WorkflowStatusModel.create({ organizationId: req.auth!.organizationId, projectId: req.params.id, name: clean(req.body.name, "Column name", 60), order: count, category: req.body.category || "todo", color: /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : "#7c8b84", isDefault: Boolean(req.body.isDefault), moveRoles: Array.isArray(req.body.moveRoles) ? req.body.moveRoles : ["project_manager", "member"], timerAction });
  if (status.isDefault) await WorkflowStatusModel.updateMany({ organizationId: req.auth!.organizationId, projectId: req.params.id, _id: { $ne: status._id } }, { isDefault: false });
  await activity(req, param(req, "id"), "workflow.column_created", undefined, { statusId: status.id, name: status.name });
  return sendResponseObject({ res, code: 201, data: { status: serialize(status) } });
};

export const updateStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true, true);
  const status = await WorkflowStatusModel.findOne({ _id: object(param(req, "statusId")), organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } });
  if (!status) throw new ObjectNotFoundException("Workflow column");
  if (status.systemKey === "pause" && (req.body.isArchived !== undefined && req.body.isArchived !== false || req.body.isDefault !== undefined && req.body.isDefault !== false || req.body.name !== undefined && req.body.name !== "Pause" || req.body.category !== undefined && req.body.category !== "paused" || req.body.timerAction !== undefined && req.body.timerAction !== "stop")) throw new ConflictException("The default Pause column must remain available and stop task timers");
  for (const field of ["name", "category", "color", "isArchived", "moveRoles"] as const) if (req.body[field] !== undefined) (status as any)[field] = field === "name" ? clean(req.body[field], "Column name", 60) : req.body[field];
  if (req.body.timerAction !== undefined) {
    if (!["none", "start", "stop"].includes(req.body.timerAction)) throw new ValidationException("Invalid timer behavior");
    status.timerAction = req.body.timerAction;
  }
  if (req.body.allowedTransitionIds !== undefined) { const ids = [...new Set((req.body.allowedTransitionIds as unknown[]).map((id) => object(id, "transition status ID")))]; const count = await WorkflowStatusModel.countDocuments({ organizationId: req.auth!.organizationId, projectId: req.params.id, _id: { $in: ids }, isDeleted: { $ne: true } }); if (count !== ids.length) throw new ValidationException("A transition points outside this workflow"); status.allowedTransitionIds = ids; }
  if (req.body.isDefault) { await WorkflowStatusModel.updateMany({ organizationId: req.auth!.organizationId, projectId: req.params.id, _id: { $ne: status._id } }, { isDefault: false }); status.isDefault = true; }
  await status.save(); await activity(req, param(req, "id"), "workflow.column_updated", undefined, { statusId: status.id });
  return sendResponseObject({ res, data: { status: serialize(status) } });
};

export const reorderStatuses = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"), true, true);
  const ids = Array.isArray(req.body.statusIds) ? req.body.statusIds.map((id: unknown) => object(id, "status ID")) : [];
  const count = await WorkflowStatusModel.countDocuments({ organizationId: req.auth!.organizationId, projectId: req.params.id, _id: { $in: ids }, isDeleted: { $ne: true } });
  if (!ids.length || count !== ids.length) throw new ValidationException("Provide every valid workflow status in order");
  await Promise.all(ids.map((id: string, order: number) => WorkflowStatusModel.updateOne({ _id: id }, { order })));
  await activity(req, param(req, "id"), "workflow.reordered", undefined, { statusIds: ids });
  return getWorkflow(req, res);
};

export const deleteStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true, true);
  const status = await WorkflowStatusModel.findOne({ _id: object(param(req, "statusId")), organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } });
  if (!status) throw new ObjectNotFoundException("Workflow column");
  if (status.systemKey === "pause") throw new ConflictException("The default Pause column cannot be archived");
  if (status.isDefault) throw new ConflictException("Set another default column before removing this one");
  const count = await ProjectTaskModel.countDocuments({ organizationId: req.auth!.organizationId, projectId: req.params.id, workflowStatusId: status.id, isDeleted: { $ne: true } });
  if (count) {
    const replacementId = object(req.body.replacementStatusId, "replacement status ID");
    const replacement = replacementId === status.id ? null : await WorkflowStatusModel.findOne({ _id: replacementId, organizationId: req.auth!.organizationId, projectId: req.params.id, isArchived: false, isDeleted: { $ne: true } });
    if (!replacement) throw new ValidationException("Choose a valid replacement column");
    const affected = await ProjectTaskModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, workflowStatusId: status.id }).select("_id").lean();
    await ProjectTaskModel.updateMany({ organizationId: req.auth!.organizationId, projectId: req.params.id, workflowStatusId: status.id }, { workflowStatusId: replacementId });
    await ProjectActivityModel.insertMany(affected.map((task) => ({ organizationId: req.auth!.organizationId, projectId: req.params.id, taskId: String(task._id), actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, action: "task.status_changed", changes: { fromStatusId: status.id, toStatusId: replacementId, from: status.name, to: replacement.name, reason: "column_archived" } })));
  }
  status.isArchived = true; await status.save(); await WorkflowStatusModel.updateMany({ projectId: req.params.id }, { $pull: { allowedTransitionIds: status.id } });
  await activity(req, param(req, "id"), "workflow.column_archived", undefined, { statusId: status.id, migratedTasks: count });
  return sendResponseObject({ res, data: { archived: true, migratedTasks: count } });
};

async function validAssignees(req: AuthenticatedRequest, projectId: string, values: unknown) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map((id) => object(id, "assignee ID")))];
  if (!ids.length) return ids;
  const count = await ProjectMemberModel.countDocuments({ organizationId: req.auth!.organizationId, projectId, employeeId: { $in: ids }, status: "active", isDeleted: { $ne: true } });
  if (count !== ids.length) throw new ValidationException("Every assignee must be a current project member");
  return ids;
}

export const listTasks = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"));
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(200, Math.max(1, Number(req.query.size) || 100));
  const filter: any = { organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } };
  if (req.query.statusId) filter.workflowStatusId = object(req.query.statusId);
  if (req.query.assigneeId) filter.assigneeEmployeeIds = object(req.query.assigneeId);
  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.type) filter.type = req.query.type;
  if (req.query.search) filter.$or = [{ title: new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { key: new RegExp(String(req.query.search), "i") }];
  const [tasks, totalCount] = await Promise.all([ProjectTaskModel.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * size).limit(size).lean(), ProjectTaskModel.countDocuments(filter)]);
  const people = await EmployeeModel.find({ organizationId: req.auth!.organizationId, _id: { $in: tasks.flatMap((task: any) => task.assigneeEmployeeIds) } }).select("firstName lastName employeeCode jobTitle").lean();
  const peopleMap = new Map(people.map((person: any) => [String(person._id), { id: String(person._id), name: `${person.firstName} ${person.lastName}`, employeeCode: person.employeeCode, jobTitle: person.jobTitle }]));
  return sendResponseObject({ res, data: { tasks: tasks.map((task: any) => ({ ...serialize(task), assignees: task.assigneeEmployeeIds.map((id: string) => peopleMap.get(id)).filter(Boolean) })), totalCount, page, lastPage: Math.ceil(totalCount / size) } });
};

export const listDeletedTasks = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"));
  const tasks = await ProjectTaskModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: true }).sort({ updatedAt: -1 }).limit(200).lean();
  const people = await EmployeeModel.find({ organizationId: req.auth!.organizationId, _id: { $in: tasks.flatMap((task: any) => task.assigneeEmployeeIds) } }).select("firstName lastName employeeCode jobTitle").lean();
  const peopleMap = new Map(people.map((person: any) => [String(person._id), { id: String(person._id), name: `${person.firstName} ${person.lastName}`, employeeCode: person.employeeCode, jobTitle: person.jobTitle }]));
  return sendResponseObject({ res, data: { tasks: tasks.map((task: any) => ({ ...serialize(task), assignees: task.assigneeEmployeeIds.map((id: string) => peopleMap.get(id)).filter(Boolean) })) } });
};

export const createTask = async (req: AuthenticatedRequest, res: Response) => {
  // Every project participant, including viewers, may create tasks. Stories
  // remain restricted below. Admins may create work without an employee row.
  const { project, member } = await projectAccess(req, param(req, "id"));
  if (project.status === "archived") throw new ConflictException("Archived projects are read-only until restored");
  const type = req.body.type === "story" ? "story" : "task", title = clean(req.body.title, type === "story" ? "Story title" : "Task title", 180);
  if (type === "story" && !isAdmin(req) && member?.role !== "project_manager") throw new ForbiddenException("Only the project manager can create stories");
  const assigneeEmployeeIds = await validAssignees(req, project.id, req.body.assigneeEmployeeIds);
  let workflowStatusId = req.body.workflowStatusId;
  if (!workflowStatusId) workflowStatusId = (await WorkflowStatusModel.findOne({ organizationId: req.auth!.organizationId, projectId: project.id, isDefault: true, isArchived: false, isDeleted: { $ne: true } }))?.id;
  const initialStatus = workflowStatusId ? await WorkflowStatusModel.findOne({ _id: object(workflowStatusId), organizationId: req.auth!.organizationId, projectId: project.id, isArchived: false, isDeleted: { $ne: true } }) : null;
  if (!initialStatus) throw new ValidationException("Project has no valid default workflow column");
  if (!["todo", "in_progress"].includes(initialStatus.category)) throw new ValidationException("New tasks can only start in Backlog or In Progress");
  const durationMinutes = durationChoice(project, req.body.durationMinutes);
  const sequenced = await ProjectModel.findOneAndUpdate({ _id: project.id }, { $inc: { nextIssueNumber: 1 } }, { new: false });
  if (!sequenced) throw new ObjectNotFoundException("Project");
  const issueNumber = sequenced.nextIssueNumber;
  if (req.body.parentStoryId && !(await ProjectTaskModel.exists({ _id: object(req.body.parentStoryId), organizationId: req.auth!.organizationId, projectId: project.id, type: "story", isDeleted: { $ne: true } }))) throw new ValidationException("Parent story is not part of this project");
  const timerStartedAt = timerActionFor(initialStatus) === "start" ? new Date() : undefined;
  const task = await ProjectTaskModel.create({ organizationId: req.auth!.organizationId, projectId: project.id, issueNumber, key: `${project.key}-${issueNumber}`, type, title, description: String(req.body.description || "").trim(), parentStoryId: req.body.parentStoryId || undefined, assigneeEmployeeIds, reporterEmployeeId: req.auth!.employeeId, createdBy: req.auth!.userId, priority: req.body.priority || "medium", workflowStatusId, durationMinutes, timeStartedAt: timerStartedAt, autoCompleteAt: timerStartedAt ? durationDeadline({ durationMinutes, accumulatedSeconds: 0 }, timerStartedAt) : undefined, startDate: optionalDate(req.body.startDate), dueDate: optionalDate(req.body.dueDate), labels: Array.isArray(req.body.labels) ? req.body.labels.map((label: unknown) => String(label).trim()).filter(Boolean).slice(0, 20) : [] });
  if (task.timeStartedAt) await startTimerSession(req, task, task.timeStartedAt);
  await activity(req, project.id, `${type}.created`, task.id, { key: task.key, title });
  await notifyProject(req, project, task, `project.${type}_created`, `New ${type} in ${project.name}`, title, assigneeEmployeeIds);
  return sendResponseObject({ res, code: 201, data: { task: serialize(task) } });
};

export const getTask = async (req: AuthenticatedRequest, res: Response) => {
  const { project, member } = await projectAccess(req, param(req, "id"));
  const task = await visibleTask(req, param(req, "id"), param(req, "taskId"));
  const page = (value: unknown) => Math.max(1, Math.min(100000, Math.floor(Number(value) || 1)));
  const data = await readTaskDetails({ organizationId: req.auth!.organizationId!, task, project, canEdit: project.status !== "archived" && (isAdmin(req) || member?.role !== "viewer"), canAdministerTask: isCompanyAdmin(req), activityPage: page(req.query.activityPage), worklogPage: page(req.query.worklogPage) });
  return sendResponseObject({ res, data });
};

export const updateTask = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true);
  const task = await visibleTask(req, param(req, "id"), param(req, "taskId"));
  const completed = await pauseTimedTaskIfDue(task);
  if (completed) throw new ConflictException("This task just paused automatically. Refresh before editing it.");
  const before: any = {}, changes: any = {};
  for (const field of ["title", "description", "priority", "parentStoryId", "startDate", "dueDate", "labels"] as const) if (req.body[field] !== undefined) { before[field] = (task as any)[field]; changes[field] = ["startDate", "dueDate"].includes(field) ? optionalDate(req.body[field]) : req.body[field]; }
  if (changes.title !== undefined) changes.title = clean(changes.title, "Title", 180);
  if (req.body.assigneeEmployeeIds !== undefined) { before.assigneeEmployeeIds = task.assigneeEmployeeIds; changes.assigneeEmployeeIds = await validAssignees(req, param(req, "id"), req.body.assigneeEmployeeIds); }
  if (req.body.durationMinutes !== undefined) {
    if (task.durationExtensionRequired && req.body.durationMinutes !== task.durationMinutes && !isCompanyAdmin(req)) throw new ForbiddenException("Only an admin can increase the duration after an automatic pause");
    before.durationMinutes = task.durationMinutes;
    changes.durationMinutes = durationChoice(project, req.body.durationMinutes, task.durationMinutes);
    const tracked = (task.accumulatedSeconds || 0) + (task.timeStartedAt ? Math.max(0, Math.floor((Date.now() - +task.timeStartedAt) / 1000)) : 0);
    if (changes.durationMinutes && changes.durationMinutes !== task.durationMinutes && changes.durationMinutes * 60 <= tracked) throw new ValidationException("Choose a duration greater than the time already tracked");
    if (task.durationExtensionRequired && changes.durationMinutes !== task.durationMinutes) { before.durationExtensionRequired = true; changes.durationExtensionRequired = false; }
  }
  for (const field of Object.keys(changes)) if (sameHistoryValue(before[field], changes[field])) { delete before[field]; delete changes[field]; }
  if (!Object.keys(changes).length) return sendResponseObject({ res, data: { task: serialize(task) } });
  if (Object.prototype.hasOwnProperty.call(changes, "dueDate")) task.reminder24hSentAt = undefined;
  const snapshot = task.toObject();
  Object.assign(task, changes);
  if (Object.prototype.hasOwnProperty.call(changes, "durationMinutes")) {
    task.autoCompleteAt = task.timeStartedAt ? durationDeadline(task, task.timeStartedAt) : undefined;
    const set = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)), unset = Object.fromEntries(Object.entries(changes).filter(([, value]) => value === undefined).map(([key]) => [key, 1]));
    if (Object.prototype.hasOwnProperty.call(changes, "dueDate")) unset.reminder24hSentAt = 1;
    if (task.autoCompleteAt) set.autoCompleteAt = task.autoCompleteAt; else unset.autoCompleteAt = 1;
    const updated = await ProjectTaskModel.findOneAndUpdate({ _id: task.id, organizationId: task.organizationId, workflowStatusId: snapshot.workflowStatusId, timeStartedAt: snapshot.timeStartedAt || { $exists: false }, durationMinutes: snapshot.durationMinutes || { $exists: false }, accumulatedSeconds: snapshot.accumulatedSeconds || 0, autoPaused: snapshot.autoPaused ? true : { $ne: true }, durationExtensionRequired: snapshot.durationExtensionRequired ? true : { $ne: true } }, { $set: set, $unset: unset }, { new: true });
    if (!updated) throw new ConflictException("The task timer changed. Refresh and try again.");
  } else await task.save();
  await activity(req, param(req, "id"), "task.updated", task.id, { before, after: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value === undefined ? null : value])) });
  const newlyAssigned = Array.isArray(changes.assigneeEmployeeIds) ? changes.assigneeEmployeeIds.filter((id: string) => !(before.assigneeEmployeeIds || []).includes(id)) : [];
  if (newlyAssigned.length) await notifyProject(req, project, task, "project.task_assigned", `Task assigned in ${project.name}`, task.title, newlyAssigned);
  return sendResponseObject({ res, data: { task: serialize(task) } });
};

export const deleteTask = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true);
  const task = await visibleTask(req, param(req, "id"), param(req, "taskId"));
  if (task.autoPaused && !isCompanyAdmin(req)) throw new ForbiddenException("Only an admin can delete an automatically paused task");
  task.isDeleted = true;
  await task.save();
  await activity(req, project.id, "task.deleted", task.id, { key: task.key, title: task.title });
  return sendResponseObject({ res, data: { id: task.id } });
};

export const restoreTask = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"), true);
  const task = await ProjectTaskModel.findOne({ _id: object(param(req, "taskId"), "task ID"), organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: true });
  if (!task) throw new ObjectNotFoundException("Deleted task");
  if (task.autoPaused && !isCompanyAdmin(req)) throw new ForbiddenException("Only an admin can restore an automatically paused task");
  task.isDeleted = false;
  await task.save();
  await activity(req, param(req, "id"), "task.restored", task.id, { key: task.key, title: task.title });
  return sendResponseObject({ res, data: { task: serialize(task) } });
};

export const permanentlyDeleteTask = async (req: AuthenticatedRequest, res: Response) => {
  const { member } = await projectAccess(req, param(req, "id"), true);
  if (!isAdmin(req) && member?.role !== "project_manager") throw new ForbiddenException("Only a project manager can permanently delete tasks");
  const task = await ProjectTaskModel.findOne({ _id: object(param(req, "taskId"), "task ID"), organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: true });
  if (!task) throw new ObjectNotFoundException("Deleted task");
  if (task.autoPaused && !isCompanyAdmin(req)) throw new ForbiddenException("Only an admin can delete an automatically paused task");
  const attachments = await ProjectAttachmentModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, taskId: task.id }).select("storedName").lean();
  await activity(req, param(req, "id"), "task.permanently_deleted", task.id, { key: task.key, title: task.title });
  await Promise.all([
    ProjectCommentModel.deleteMany({ organizationId: req.auth!.organizationId, projectId: req.params.id, taskId: task.id }),
    ProjectAttachmentModel.deleteMany({ organizationId: req.auth!.organizationId, projectId: req.params.id, taskId: task.id }),
    TaskTimeSessionModel.deleteMany({ organizationId: req.auth!.organizationId, projectId: req.params.id, taskId: task.id }),
    task.deleteOne(),
    ...attachments.map((attachment: any) => unlink(path.join(attachmentDirectory, attachment.storedName)).catch(() => undefined)),
  ]);
  return sendResponseObject({ res, data: { id: task.id } });
};

export const moveTask = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true);
  const task = await visibleTask(req, param(req, "id"), param(req, "taskId"));
  if (task.autoPaused && !isCompanyAdmin(req)) throw new ForbiddenException("Only an admin can move an automatically paused task");
  const completed = await pauseTimedTaskIfDue(task);
  if (completed) return sendResponseObject({ res, data: { task: serialize(completed) } });
  const snapshot = task.toObject();
  const targetId = object(req.body.workflowStatusId, "workflow status ID");
  if (task.workflowStatusId === targetId) return sendResponseObject({ res, data: { task: serialize(task) } });
  const [current, target] = await Promise.all([WorkflowStatusModel.findOne({ _id: task.workflowStatusId, organizationId: req.auth!.organizationId, projectId: req.params.id }), WorkflowStatusModel.findOne({ _id: targetId, organizationId: req.auth!.organizationId, projectId: req.params.id, isArchived: false, isDeleted: { $ne: true } })]);
  if (!current || !target) throw new ValidationException("Invalid workflow transition");
  const before = task.workflowStatusId;
  const now = new Date();

  // Timer behaviour is configured per destination column. Neutral columns do
  // not alter the timer, so it can continue across review/QA columns.
  const timerAction = timerActionFor(target);
  if (timerAction === "start" && task.durationExtensionRequired) throw new ConflictException("An admin must increase the duration before this task can resume");
  if (timerAction === "start") durationChoice(project, task.durationMinutes, task.durationMinutes);
  task.completionMethod = target.category === "done" ? "manual" : undefined;
  task.completedAt = target.category === "done" ? now : undefined;
  if (timerAction === "stop" && task.timeStartedAt) {
    task.accumulatedSeconds = (task.accumulatedSeconds || 0) + Math.max(0, Math.floor((now.getTime() - task.timeStartedAt.getTime()) / 1000));
    task.timeStoppedAt = now;
    task.timeStartedAt = undefined;
    task.autoCompleteAt = undefined;
  }
  if (timerAction === "start" && !task.timeStartedAt) {
    task.timeStartedAt = now;
    task.timeStoppedAt = undefined;
    task.autoCompleteAt = durationDeadline(task, now);
  }
  if (task.autoPaused) task.autoPaused = false;
  task.workflowStatusId = target.id;
  await saveTaskClock(task, snapshot);
  if (timerAction === "stop" && snapshot.timeStartedAt) await stopTimerSession(req, task, now, "status_change", snapshot.timeStartedAt);
  if (timerAction === "start" && !snapshot.timeStartedAt) await startTimerSession(req, task, now);
  await activity(req, param(req, "id"), "task.status_changed", task.id, { fromStatusId: before, toStatusId: target.id, from: current.name, to: target.name, ...(snapshot.autoPaused ? { reason: "admin_released_auto_pause" } : {}) });
  await notifyProject(req, project, task, "project.task_moved", `${task.title} moved`, `${current.name} → ${target.name}`, task.assigneeEmployeeIds);
  return sendResponseObject({ res, data: { task: serialize(task) } });
};

export const updateTaskTimer = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true);
  const task = await visibleTask(req, param(req, "id"), param(req, "taskId"));
  const completed = await pauseTimedTaskIfDue(task);
  if (completed) return sendResponseObject({ res, data: { task: serialize(completed) } });
  const snapshot = task.toObject();
  const action = String(req.body.action || "");
  if (!["start", "pause"].includes(action)) throw new ValidationException("Timer action must be start or pause");
  if (action === "start" && task.autoPaused) throw new ForbiddenException("An admin must move this task out of Pause before it can resume");
  if (action === "start" && task.durationExtensionRequired) throw new ForbiddenException("An admin must increase the duration before this task can resume");
  if (action === "start" && task.completedAt) throw new ConflictException("Move this task to an active column before restarting its timer");
  if (action === "start") durationChoice(project, task.durationMinutes, task.durationMinutes);
  if ((action === "pause" && !task.timeStartedAt) || (action === "start" && task.timeStartedAt)) return sendResponseObject({ res, data: { task: serialize(task) } });
  const now = new Date();
  const previousStart = task.timeStartedAt;
  if (action === "pause" && task.timeStartedAt) {
    task.accumulatedSeconds = (task.accumulatedSeconds || 0) + Math.max(0, Math.floor((now.getTime() - task.timeStartedAt.getTime()) / 1000));
    task.timeStoppedAt = now;
    task.timeStartedAt = undefined;
    task.autoCompleteAt = undefined;
  } else if (action === "start" && !task.timeStartedAt) {
    task.timeStartedAt = now;
    task.timeStoppedAt = undefined;
    task.autoCompleteAt = durationDeadline(task, now);
  }
  await saveTaskClock(task, snapshot);
  if (action === "pause" && previousStart) await stopTimerSession(req, task, now, "pause", previousStart);
  if (action === "start") await startTimerSession(req, task, now);
  await activity(req, param(req, "id"), action === "start" ? "task.timer_started" : "task.timer_paused", task.id, { startedAt: previousStart || now, ...(action === "pause" ? { stoppedAt: now, durationSeconds: Math.max(0, Math.floor((+now - +new Date(previousStart!)) / 1000)) } : {}) });
  return sendResponseObject({ res, data: { task: serialize(task) } });
};

export const addComment = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true);
  const task = await visibleTask(req, param(req, "id"), param(req, "taskId"));
  const mentionedEmployeeIds: string[] = [...new Set<string>((Array.isArray(req.body.mentionedEmployeeIds) ? req.body.mentionedEmployeeIds : []).map((id: unknown) => object(id, "mentioned employee ID")))];
  if (mentionedEmployeeIds.length) {
    const validMentionCount = await ProjectMemberModel.countDocuments({ organizationId: req.auth!.organizationId, projectId: req.params.id, employeeId: { $in: mentionedEmployeeIds }, status: "active", isDeleted: { $ne: true } });
    if (validMentionCount !== mentionedEmployeeIds.length) throw new ValidationException("Every mentioned person must be an active project member");
  }
  const comment = await ProjectCommentModel.create({ organizationId: req.auth!.organizationId, projectId: req.params.id, taskId: req.params.taskId, authorEmployeeId: req.auth!.employeeId, authorUserId: req.auth!.userId, mentionedEmployeeIds, body: clean(req.body.body, "Comment", 5000) });
  await activity(req, param(req, "id"), "comment.added", param(req, "taskId"), { commentId: comment.id });
  await notifyProject(req, project, task, "project.comment_added", `New comment on ${task.title}`, String(comment.body).slice(0, 180), [...task.assigneeEmployeeIds, task.reporterEmployeeId].filter((id): id is string => Boolean(id)));
  if (mentionedEmployeeIds.length) {
    const author = req.auth!.employeeId ? await EmployeeModel.findOne({ _id: req.auth!.employeeId, organizationId: req.auth!.organizationId }).select("firstName lastName").lean() : null;
    await notifyEmployees({ organizationId: req.auth!.organizationId!, employeeIds: mentionedEmployeeIds, actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, type: "project.comment_mentioned", title: `${author ? `${author.firstName} ${author.lastName}` : "A teammate"} mentioned you`, message: `${task.key}: ${String(comment.body).slice(0, 180)}`, href: `/projects/${project.id}/tasks/${task.id}?activity=comments`, projectId: project.id, taskId: task.id });
  }
  return sendResponseObject({ res, code: 201, data: { comment: serialize(comment) } });
};

const attachmentDirectory = path.resolve(process.env.PROJECT_UPLOAD_DIR || path.join(process.cwd(), "uploads", "project-attachments"));
const allowedMimeTypes = new Set(["image/png","image/jpeg","image/webp","image/gif","application/pdf","text/plain","text/csv","application/zip","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
export const addAttachment = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req,param(req,"id"),true);
  const taskId=object(param(req,"taskId"),"task ID");
  await visibleTask(req,param(req,"id"),taskId);
  const originalName=clean(req.body.name,"File name",180),mimeType=String(req.body.mimeType||"");
  if(!allowedMimeTypes.has(mimeType))throw new ValidationException("This file type is not allowed");
  const match=String(req.body.data||"").match(/^data:[^;]+;base64,(.+)$/);
  if(!match)throw new ValidationException("Invalid attachment data");
  const bytes=Buffer.from(match[1],"base64");
  if(!bytes.length||bytes.length>8*1024*1024)throw new ValidationException("Attachments must be between 1 byte and 8 MB");
  await mkdir(attachmentDirectory,{recursive:true});
  const extension=path.extname(originalName).replace(/[^.a-z0-9]/gi,"").slice(0,10),storedName=`${randomUUID()}${extension}`;
  await writeFile(path.join(attachmentDirectory,storedName),bytes,{flag:"wx"});
  const attachment=await ProjectAttachmentModel.create({organizationId:req.auth!.organizationId,projectId:param(req,"id"),taskId,uploadedByUserId:req.auth!.userId,uploadedByEmployeeId:req.auth!.employeeId,originalName,storedName,mimeType,size:bytes.length});
  await activity(req,param(req,"id"),"attachment.added",taskId,{attachmentId:attachment.id,name:originalName,size:bytes.length});
  const value=serialize(attachment);delete value.storedName;
  return sendResponseObject({res,code:201,data:{attachment:value}});
};
export const downloadAttachment = async (req:AuthenticatedRequest,res:Response) => {
  await projectAccess(req,param(req,"id"));
  const attachment=await ProjectAttachmentModel.findOne({_id:object(param(req,"attachmentId"),"attachment ID"),organizationId:req.auth!.organizationId,projectId:param(req,"id"),isDeleted:{$ne:true}});
  if(!attachment)throw new ObjectNotFoundException("Attachment");
  await visibleTask(req,param(req,"id"),attachment.taskId);
  const bytes=await readFile(path.join(attachmentDirectory,attachment.storedName)).catch(()=>null);
  if(!bytes)throw new ObjectNotFoundException("Attachment file");
  res.setHeader("Content-Type",attachment.mimeType);res.setHeader("Content-Disposition",`${attachment.mimeType.startsWith("image/") || attachment.mimeType === "application/pdf" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`);res.send(bytes);
};

export const listActivity = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"));
  const rows = await ProjectActivityModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } }).sort({ createdAt: -1 }).limit(Math.min(200, Number(req.query.size) || 100)).lean();
  return sendResponseObject({ res, data: { activity: rows.map(serialize) } });
};

export const listReminders = async (req: AuthenticatedRequest, res: Response) => {
  await projectAccess(req, param(req, "id"));
  const rows = await ProjectReminderModel.find({ organizationId: req.auth!.organizationId, projectId: req.params.id, isDeleted: { $ne: true } }).sort({ scheduledAt: 1 }).limit(500).lean();
  return sendResponseObject({ res, data: { reminders: rows.map(serialize) } });
};

export const createReminder = async (req: AuthenticatedRequest, res: Response) => {
  const { project } = await projectAccess(req, param(req, "id"), true);
  const scheduledAt = optionalDate(req.body.scheduledAt);
  if (!scheduledAt) throw new ValidationException("Reminder date and time are required");
  const reminder = await ProjectReminderModel.create({ organizationId: req.auth!.organizationId, projectId: project.id, title: clean(req.body.title, "Reminder title", 180), note: String(req.body.note || "").trim().slice(0, 2000), scheduledAt, createdBy: req.auth!.userId, createdByEmployeeId: req.auth!.employeeId });
  await activity(req, project.id, "reminder.created", undefined, { reminderId: reminder.id, title: reminder.title, scheduledAt });
  const memberIds = (await ProjectMemberModel.find({ organizationId: req.auth!.organizationId, projectId: project.id, status: "active", isDeleted: { $ne: true } }).distinct("employeeId")).map(String);
  await notifyEmployees({ organizationId: req.auth!.organizationId!, employeeIds: memberIds, actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId, type: "project.reminder_created", title: `Reminder in ${project.name}`, message: `${reminder.title} · ${scheduledAt.toLocaleString()}`, href: `/projects/${project.id}?view=calendar`, projectId: project.id });
  return sendResponseObject({ res, code: 201, data: { reminder: serialize(reminder) } });
};

export const myTasks = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.auth!.employeeId) throw new ForbiddenException();
  const memberships = await ProjectMemberModel.find({ organizationId: req.auth!.organizationId, employeeId: req.auth!.employeeId, status: "active", isDeleted: { $ne: true } }).distinct("projectId");
  const tasks = await ProjectTaskModel.find({ organizationId: req.auth!.organizationId, projectId: { $in: memberships }, assigneeEmployeeIds: req.auth!.employeeId, isDeleted: { $ne: true } }).sort({ dueDate: 1, updatedAt: -1 }).limit(200).lean();
  const projects = await ProjectModel.find({ _id: { $in: memberships }, organizationId: req.auth!.organizationId }).select("name key status").lean();
  const projectMap = new Map(projects.map((project: any) => [String(project._id), serialize(project)]));
  return sendResponseObject({ res, data: { tasks: tasks.map((task: any) => ({ ...serialize(task), project: projectMap.get(task.projectId) })) } });
};
