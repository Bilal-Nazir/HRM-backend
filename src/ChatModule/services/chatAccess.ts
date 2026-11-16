import { AuthUser } from "../../AuthModule/utils/types";
import User from "../../AuthModule/models/User";
import Employee from "../../EmployeeModule/models/Employee";
import Organization from "../../OrganizationModule/models/Organization";
import Membership from "../../TenantModule/models/CompanyMembership";
import Project from "../../ProjectModule/models/Project";
import ProjectMember from "../../ProjectModule/models/ProjectMember";
import Conversation from "../models/Conversation";
import { isValidObjectId } from "mongoose";
import {
  ObjectNotFoundException,
  ValidationException,
} from "../../node-base/utils";

export type ChatPerson = {
  userId: string;
  employeeId?: string;
  name: string;
  employeeCode?: string;
  jobTitle?: string;
  photoVersion?: string;
};
export const chatId = (value: unknown, name = "ID") => {
  if (typeof value !== "string" || !isValidObjectId(value))
    throw new ValidationException(`Invalid ${name}`);
  return value;
};
export const canReadAllProjectChats = (auth: AuthUser) =>
  !!(
    auth.isCompanyOwner ||
    auth.isPlatformAdmin ||
    auth.permissions.includes("project.manage")
  );

export async function companyChatPeople(auth: AuthUser): Promise<ChatPerson[]> {
  const organizationId = auth.organizationId!;
  const [company, memberships, employees] = await Promise.all([
    Organization.findById(organizationId).select("ownerUserId"),
    Membership.find({
      organizationId,
      status: "active",
      isDeleted: { $ne: true },
    })
      .select("userId")
      .lean(),
    Employee.find({
      organizationId,
      employmentStatus: "active",
      isDeleted: { $ne: true },
    })
      .select("userId firstName lastName employeeCode jobTitle")
      .lean(),
  ]);
  const staff = new Map(
    employees
      .filter((employee) => employee.userId)
      .map((employee) => [String(employee.userId), employee]),
  );
  const eligible = memberships
    .map((member) => String(member.userId))
    .filter((userId) => staff.has(userId));
  if (company?.ownerUserId) eligible.push(company.ownerUserId);
  // A Super Admin inspecting this company may participate, but other companies'
  // global accounts are never exposed in its directory.
  eligible.push(auth.userId);
  // A Super Admin may initiate a DM without being an employee. Keep that
  // participant available to the recipient so the employee can reply.
  const directPeers = await Conversation.find({
    organizationId,
    kind: "direct",
    participantUserIds: auth.userId,
    isDeleted: { $ne: true },
  }).distinct("participantUserIds");
  const platformPeers = await User.find({
    _id: { $in: directPeers },
    isPlatformAdmin: true,
    isActive: true,
    isDeleted: { $ne: true },
  }).distinct("_id");
  eligible.push(...platformPeers.map(String));
  const users = await User.find({
    _id: { $in: eligible },
    isActive: true,
    isDeleted: { $ne: true },
  })
    .select("name loginId photoVersion")
    .lean();
  return users
    .map((user) => {
      const userId = String(user._id),
        employee = staff.get(userId);
      return {
        userId,
        employeeId: employee ? String(employee._id) : undefined,
        name: employee
          ? `${employee.firstName} ${employee.lastName}`.trim()
          : user.name ||
            (user.loginId.includes("@") ? "Company admin" : user.loginId),
        employeeCode: employee?.employeeCode,
        jobTitle: employee?.jobTitle,
        photoVersion: user.photoVersion,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function accessibleChatProjects(auth: AuthUser) {
  const projectIds = canReadAllProjectChats(auth)
    ? null
    : auth.employeeId
      ? await ProjectMember.find({
          organizationId: auth.organizationId,
          employeeId: auth.employeeId,
          status: "active",
          isDeleted: { $ne: true },
        }).distinct("projectId")
      : [];
  return Project.find({
    organizationId: auth.organizationId,
    isDeleted: { $ne: true },
    ...(projectIds && { _id: { $in: projectIds } }),
  })
    .select("name key status")
    .lean();
}

export async function chatAccess(auth: AuthUser, value: unknown) {
  const id = chatId(value, "conversation ID");
  const conversation = await Conversation.findOne({
    _id: id,
    organizationId: auth.organizationId,
    isDeleted: { $ne: true },
  });
  if (!conversation) throw new ObjectNotFoundException("Conversation");
  let project: any = null;
  let readOnly = false;
  if (conversation.kind === "direct") {
    if (!conversation.participantUserIds.includes(auth.userId))
      throw new ObjectNotFoundException("Conversation");
  } else {
    project = (await accessibleChatProjects(auth)).find(
      (row) => String(row._id) === conversation.projectId,
    );
    if (!project) throw new ObjectNotFoundException("Conversation");
    const member = !canReadAllProjectChats(auth)
      ? await ProjectMember.findOne({
          organizationId: auth.organizationId,
          projectId: conversation.projectId,
          employeeId: auth.employeeId,
          status: "active",
          isDeleted: { $ne: true },
        }).select("role")
      : null;
    readOnly = project.status === "archived" || member?.role === "viewer";
  }
  return { conversation, project, readOnly };
}

export async function conversationPeople(auth: AuthUser, conversation: any) {
  const all = await companyChatPeople(auth);
  if (conversation.kind === "direct")
    return all.filter((person) =>
      conversation.participantUserIds.includes(person.userId),
    );
  const [members, company] = await Promise.all([
    ProjectMember.find({
      organizationId: auth.organizationId,
      projectId: conversation.projectId,
      status: "active",
      isDeleted: { $ne: true },
    }).distinct("employeeId"),
    Organization.findById(auth.organizationId).select("ownerUserId"),
  ]);
  const memberIds = new Set(members.map(String));
  return all.filter(
    (person) =>
      person.userId === String(company?.ownerUserId) ||
      person.userId === auth.userId ||
      (person.employeeId && memberIds.has(person.employeeId)),
  );
}
