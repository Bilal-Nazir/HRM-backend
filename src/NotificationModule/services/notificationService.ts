import UserModel from "../../AuthModule/models/User";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import ProjectMemberModel from "../../ProjectModule/models/ProjectMember";
import NotificationModel from "../models/Notification";

type Notice = {
  organizationId: string;
  recipientUserIds: string[];
  recipientEmployees?: Map<string, string>;
  actorUserId?: string;
  actorEmployeeId?: string;
  type: string;
  title: string;
  message: string;
  href: string;
  projectId?: string;
  taskId?: string;
};

export async function userRecipientsForEmployees(organizationId: string, employeeIds: string[]) {
  const employees = await EmployeeModel.find({ organizationId, _id: { $in: [...new Set(employeeIds.filter(Boolean))] }, employmentStatus: "active", isDeleted: { $ne: true } }).select("userId").lean();
  const employeeByUser = new Map<string, string>();
  for (const employee of employees as any[]) if (employee.userId) employeeByUser.set(String(employee.userId), String(employee._id));
  return employeeByUser;
}

export async function organizationAdminUserIds(organizationId: string) {
  const [users, employeeUserIds] = await Promise.all([
    UserModel.find({ organizationId, isActive: true, isDeleted: { $ne: true } }).select("_id").lean(),
    EmployeeModel.find({ organizationId, userId: { $exists: true }, isDeleted: { $ne: true } }).distinct("userId"),
  ]);
  const employeeUsers = new Set(employeeUserIds.map(String));
  return users.map((user: any) => String(user._id)).filter((id) => !employeeUsers.has(id));
}

export async function projectManagerEmployeeIds(organizationId: string, projectId: string) {
  return (await ProjectMemberModel.find({ organizationId, projectId, role: "project_manager", status: "active", isDeleted: { $ne: true } }).distinct("employeeId")).map(String);
}

export async function createNotifications(input: Notice) {
  const recipients = [...new Set(input.recipientUserIds)].filter((id) => id && id !== input.actorUserId);
  if (!recipients.length) return;
  await NotificationModel.insertMany(recipients.map((recipientUserId) => ({
    organizationId: input.organizationId,
    recipientUserId,
    recipientEmployeeId: input.recipientEmployees?.get(recipientUserId),
    actorUserId: input.actorUserId,
    actorEmployeeId: input.actorEmployeeId,
    type: input.type,
    title: input.title,
    message: input.message,
    href: input.href,
    projectId: input.projectId,
    taskId: input.taskId,
  })));
}

export async function notifyEmployees(input: Omit<Notice, "recipientUserIds"> & { employeeIds: string[] }) {
  const recipientEmployees = await userRecipientsForEmployees(input.organizationId, input.employeeIds);
  return createNotifications({ ...input, recipientUserIds: [...recipientEmployees.keys()], recipientEmployees });
}
