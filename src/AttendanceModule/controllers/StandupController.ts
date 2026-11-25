import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import ProjectTaskModel from "../../ProjectModule/models/ProjectTask";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import AttendanceModel from "../models/Attendance";
import { ConflictException, sendResponseObject, ValidationException } from "../../node-base/utils";
import { isValidObjectId } from "mongoose";

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 ||
    value.some((id) => typeof id !== "string" || !isValidObjectId(id))) {
    throw new ValidationException("Select valid tasks for your stand-up.");
  }
  return [...new Set(value)];
}

async function taskSnapshots(req: AuthenticatedRequest, selected: string[]) {
  const tasks = await ProjectTaskModel.find({
    organizationId: req.auth!.organizationId,
    assigneeEmployeeIds: req.auth!.employeeId,
    isDeleted: { $ne: true },
    _id: { $in: selected },
  }).select("title");
  if (tasks.length !== selected.length) throw new ValidationException("Select tasks assigned to you.");
  return tasks.map((task) => ({ id: task.id, title: task.title }));
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
  const [yesterday, planned] = await Promise.all([
    taskSnapshots(req, ids(input.yesterday)),
    taskSnapshots(req, ids(input.planned)),
  ]);
  return { yesterday, planned, ...(input.hasBlocker ? { blocker: { text, priority: input.priority } } : {}) };
}

export async function checkOutStandup(req: AuthenticatedRequest, plan: { planned: { id: string; title: string }[] }) {
  const input = req.body.standup;
  if (!input) throw new ValidationException("Review your stand-up before checking out.");
  const completed = ids(input.completed);
  const additional = ids(input.additional);
  const planned = new Set(plan.planned.map((task) => task.id));
  if (completed.some((id) => !planned.has(id)) || additional.some((id) => planned.has(id))) {
    throw new ValidationException("Review your planned and additional tasks.");
  }
  return {
    completed: plan.planned.filter((task) => completed.includes(task.id)),
    pending: plan.planned.filter((task) => !completed.includes(task.id)),
    additional: await taskSnapshots(req, additional),
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
