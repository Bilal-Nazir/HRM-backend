import { AuthUser } from "../../AuthModule/utils/types";
import Employee from "../../EmployeeModule/models/Employee";
import Team from "../../OrganizationModule/models/Team";
import Project from "../../ProjectModule/models/Project";
import ProjectMember from "../../ProjectModule/models/ProjectMember";

export const isRequestAdmin = (auth: AuthUser) =>
  !!(auth.isCompanyOwner || auth.isPlatformAdmin);

export async function managedRequestEmployeeIds(
  auth: AuthUser,
): Promise<string[]> {
  if (!auth.employeeId) return [];
  const organizationId = auth.organizationId!;
  const [teams, managerMemberships, managedProjects] = await Promise.all([
    Team.find({
      organizationId,
      leadEmployeeId: auth.employeeId,
      status: "active",
      isDeleted: { $ne: true },
    }).distinct("_id"),
    ProjectMember.find({
      organizationId,
      employeeId: auth.employeeId,
      role: "project_manager",
      status: "active",
      isDeleted: { $ne: true },
    }).distinct("projectId"),
    Project.find({
      organizationId,
      managerEmployeeId: auth.employeeId,
      status: { $ne: "archived" },
      isDeleted: { $ne: true },
    }).distinct("_id"),
  ]);
  const projectIds = await Project.find({
    organizationId,
    _id: { $in: [...managerMemberships, ...managedProjects] },
    status: { $ne: "archived" },
    isDeleted: { $ne: true },
  }).distinct("_id");
  const projectEmployees = projectIds.length
    ? await ProjectMember.find({
        organizationId,
        projectId: { $in: projectIds },
        status: "active",
        isDeleted: { $ne: true },
      }).distinct("employeeId")
    : [];
  const employees = await Employee.find({
    organizationId,
    isDeleted: { $ne: true },
    $or: [
      { managerEmployeeId: auth.employeeId },
      { teamId: { $in: teams } },
      { _id: { $in: projectEmployees } },
    ],
  }).distinct("_id");
  return employees.map(String).filter((id) => id !== auth.employeeId);
}

export async function requestReviewerEmployeeIds(
  organizationId: string,
  employeeId: string,
): Promise<string[]> {
  const employee = await Employee.findOne({
    _id: employeeId,
    organizationId,
  }).select("managerEmployeeId teamId");
  if (!employee) return [];
  const [team, memberships] = await Promise.all([
    employee.teamId
      ? Team.findOne({
          _id: employee.teamId,
          organizationId,
          status: "active",
          isDeleted: { $ne: true },
        }).select("leadEmployeeId")
      : null,
    ProjectMember.find({
      organizationId,
      employeeId,
      status: "active",
      isDeleted: { $ne: true },
    }).distinct("projectId"),
  ]);
  const projects = await Project.find({
    organizationId,
    _id: { $in: memberships },
    status: { $ne: "archived" },
    isDeleted: { $ne: true },
  }).select("managerEmployeeId");
  const leads = await ProjectMember.find({
    organizationId,
    projectId: { $in: projects.map((project) => project.id) },
    role: "project_manager",
    status: "active",
    isDeleted: { $ne: true },
  }).distinct("employeeId");
  return [
    ...new Set(
      [
        employee.managerEmployeeId,
        team?.leadEmployeeId,
        ...projects.map((project) => project.managerEmployeeId),
        ...leads,
      ]
        .filter(Boolean)
        .map(String),
    ),
  ].filter((id) => id !== employeeId);
}
