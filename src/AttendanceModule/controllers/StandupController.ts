import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import ProjectTaskModel from "../../ProjectModule/models/ProjectTask";
import ProjectMemberModel from "../../ProjectModule/models/ProjectMember";
import WorkflowStatusModel from "../../ProjectModule/models/WorkflowStatus";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import AttendanceModel, { StandupTaskSnapshot } from "../models/Attendance";
import { ConflictException, sendResponseObject, ValidationException } from "../../node-base/utils";
import { isValidObjectId } from "mongoose";

const categoriesByStage = {
  "check-in": ["todo", "in_progress"],
  "check-out": ["paused", "done"],
};
type Stage = keyof typeof categoriesByStage;

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 ||
    value.some((id) => typeof id !== "string" || !isValidObjectId(id))) {
    throw new ValidationException("Select valid tasks for your stand-up.");
  }
  return [...new Set(value.map((id: string) => id.toLowerCase()))];
}

async function eligibleTasks(req: AuthenticatedRequest, stage: Stage, selected?: string[]) {
  const { organizationId, employeeId } = req.auth!;
  if (!employeeId || selected?.length === 0) return [];
  const projects = await ProjectMemberModel.distinct("projectId", {
    organizationId, employeeId, status: "active", isDeleted: { $ne: true },
  });
  if (!projects.length) return [];
  const columns = await WorkflowStatusModel.find({
    organizationId, projectId: { $in: projects },
    category: { $in: categoriesByStage[stage] },
    isArchived: { $ne: true }, isDeleted: { $ne: true },
  }).select("projectId name category").lean();
  if (!columns.length) return [];
  const columnById = new Map(columns.map((column) => [String(column._id), column]));
  const tasks = await ProjectTaskModel.find({
    organizationId,
    projectId: { $in: projects },
    workflowStatusId: { $in: [...columnById.keys()] },
    assigneeEmployeeIds: employeeId,
    isDeleted: { $ne: true },
    ...(selected && { _id: { $in: selected } }),
  }).select("projectId workflowStatusId key title").sort({ updatedAt: -1, _id: -1 }).lean();
  return tasks.flatMap((task) => {
    const column = columnById.get(String(task.workflowStatusId));
    return column && String(column.projectId) === String(task.projectId) ? [{
      id: String(task._id), key: task.key, title: task.title,
      column: column.name, category: column.category,
    }] : [];
  });
}

async function selectedTasks(req: AuthenticatedRequest, stage: Stage, selected: string[]) {
  const tasks = await eligibleTasks(req, stage, selected);
  if (tasks.length !== selected.length) {
    const allowed = stage === "check-in" ? "To do or In progress" : "Paused or Done";
    throw new ValidationException(`Select assigned tasks that are still in ${allowed}. Reopen the form to refresh the list.`);
  }
  return tasks;
}

const snapshot = ({ id, key, title }: StandupTaskSnapshot): StandupTaskSnapshot => ({ id, key, title });

export async function standupTaskOptions(req: AuthenticatedRequest, res: Response) {
  const stage = req.query.stage;
  if (stage !== "check-in" && stage !== "check-out") throw new ValidationException("Choose check-in or check-out.");
  const tasks = await eligibleTasks(req, stage);
  return sendResponseObject({ res, data: { tasks } });
}

export async function requireStandupToStartWork(req: AuthenticatedRequest) {
  const { organizationId, employeeId, isCompanyOwner, isPlatformAdmin } = req.auth!;
  if (isCompanyOwner || isPlatformAdmin || !employeeId) return;
  const organization = await OrganizationModel.findById(organizationId).select("standupEnabled");
  if (!organization?.standupEnabled) return;
  const open = await AttendanceModel.exists({
    organizationId, employeeId, standup: { $exists: true },
    checkOutAt: { $exists: false }, isDeleted: { $ne: true },
  });
  if (!open) throw new ConflictException("Check in and submit your stand-up before starting work.");
}

export async function checkInStandup(req: AuthenticatedRequest, enabled: boolean) {
  if (!enabled) return undefined;
  const input = req.body.standup;
  if (!input || typeof input.hasBlocker !== "boolean") throw new ValidationException("Complete your stand-up before checking in.");
  const text = typeof input.blocker === "string" ? input.blocker.trim() : "";
  if (input.hasBlocker && (!text || text.length > 240 || /[\r\n]/.test(text) || !["high", "medium", "low"].includes(input.priority))) {
    throw new ValidationException("Enter a one-line blocker and choose its priority.");
  }
  const planned = (await selectedTasks(req, "check-in", ids(input.planned))).map(snapshot);
  return { planned, ...(input.hasBlocker ? { blocker: { text, priority: input.priority } } : {}) };
}

export async function checkOutStandup(req: AuthenticatedRequest, plan: { planned: StandupTaskSnapshot[] }) {
  const input = req.body.standup;
  if (!input) throw new ValidationException("Review your stand-up before checking out.");
  // Accept the previous payload during a rolling release.
  const selected = input.workedOn === undefined
    ? ids([...ids(input.completed), ...ids(input.additional)])
    : ids(input.workedOn);
  const workedOn = await selectedTasks(req, "check-out", selected);
  const reported = new Set(selected);
  return {
    completed: workedOn.filter((task) => task.category === "done").map(snapshot),
    paused: workedOn.filter((task) => task.category === "paused").map(snapshot),
    pending: plan.planned.filter((task) => !reported.has(task.id)),
  };
}

export async function standupStatus(req: AuthenticatedRequest, res: Response) {
  const { organizationId, employeeId } = req.auth!;
  const [organization, open] = await Promise.all([
    OrganizationModel.findById(organizationId).select("standupEnabled"),
    employeeId ? AttendanceModel.findOne({ organizationId, employeeId, checkOutAt: { $exists: false }, isDeleted: { $ne: true } }).sort({ checkInAt: -1 }).select("standup") : null,
  ]);
  return sendResponseObject({ res, data: { enabled: !!organization?.standupEnabled, plan: open?.standup ?? null } });
}

export async function updateStandup(req: AuthenticatedRequest, res: Response) {
  if (typeof req.body.enabled !== "boolean") throw new ValidationException("Choose whether stand-up reports are required.");
  await OrganizationModel.updateOne({ _id: req.auth!.organizationId }, { $set: { standupEnabled: req.body.enabled } });
  return sendResponseObject({ res, data: { enabled: req.body.enabled } });
}

export async function standupReports(req: AuthenticatedRequest, res: Response) {
  const { organizationId } = req.auth!;
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const rows = await AttendanceModel.find({ organizationId, standup: { $exists: true }, isDeleted: { $ne: true } })
    .select("employeeId workDate checkInAt checkOutAt standup standupResult")
    .sort({ workDate: -1, employeeId: 1, checkInAt: -1 }).skip((page - 1) * 50).limit(51).lean();
  const employees = await EmployeeModel.find({ organizationId, _id: { $in: rows.map((row) => row.employeeId) } }).select("firstName lastName").lean();
  const names = new Map(employees.map((employee) => [String(employee._id), `${employee.firstName} ${employee.lastName}`]));
  return sendResponseObject({ res, data: { hasMore: rows.length > 50, reports: rows.slice(0, 50).map((row) => ({ ...row, employeeName: names.get(String(row.employeeId)) || "Former employee" })) } });
}
