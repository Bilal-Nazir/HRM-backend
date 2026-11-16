import UserModel from "../../AuthModule/models/User";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import RoleAssignmentModel from "../../AccessModule/models/RoleAssignment";
import RoleModel from "../../AccessModule/models/Role";
import MembershipModel from "../models/CompanyMembership";
import {
  defaultRoles,
  permissionCatalogue,
} from "../../AccessModule/utils/permissions";
import {
  ForbiddenException,
  UnauthenticatedException,
} from "../../node-base/utils";
import { AuthUser } from "../../AuthModule/utils/types";
import { isValidObjectId } from "mongoose";

export async function resolveCompanyContext(
  user: any,
  organizationId?: string,
): Promise<AuthUser> {
  const base: AuthUser = {
    userId: user.id,
    permissions: [],
    accountType: user.isPlatformAdmin ? "admin" : "employee",
    credentialVersion: user.credentialVersion || 0,
    isPlatformAdmin: !!user.isPlatformAdmin,
  };
  if (!organizationId)
    return { ...base, permissions: user.isPlatformAdmin ? ["*"] : [] };
  if (!isValidObjectId(organizationId))
    throw new ForbiddenException("Invalid company");
  const company = await OrganizationModel.findOne({
    _id: organizationId,
    isDeleted: { $ne: true },
  });
  if (!company || (company.status !== "active" && !user.isPlatformAdmin))
    throw new ForbiddenException("Company is suspended or unavailable");
  const owner = String(company.ownerUserId || "") === user.id;
  const membership = await MembershipModel.findOne({
    organizationId,
    userId: user.id,
    status: "active",
    isDeleted: { $ne: true },
  });
  if (!owner && !user.isPlatformAdmin && !membership)
    throw new ForbiddenException("You do not belong to this company");
  const employee = await EmployeeModel.findOne({
    organizationId,
    userId: user.id,
    employmentStatus: "active",
    isDeleted: { $ne: true },
  });
  const assignments = employee
    ? await RoleAssignmentModel.find({
        organizationId,
        employeeId: employee.id,
        isDeleted: { $ne: true },
        $and: [
          {
            $or: [
              { activeFrom: { $exists: false } },
              { activeFrom: { $lte: new Date() } },
            ],
          },
          {
            $or: [
              { activeTo: { $exists: false } },
              { activeTo: { $gt: new Date() } },
            ],
          },
        ],
      })
    : [];
  const roles = await RoleModel.find({
    _id: { $in: assignments.map((assignment) => assignment.roleId) },
    organizationId,
    status: "active",
    isDeleted: { $ne: true },
  });
  // No role name or client-supplied permission can create a second company admin.
  const permissions = user.isPlatformAdmin
    ? ["*"]
    : owner
      ? [...defaultRoles.organizationAdmin, "company.owner"]
      : [
          ...new Set(
            roles
              .filter((role) => role.name !== "Organization Admin")
              .flatMap((role) => role.permissions)
              .filter((permission) =>
                permissionCatalogue.includes(permission as any),
              ),
          ),
        ];
  if (!owner && !user.isPlatformAdmin && !employee)
    throw new ForbiddenException("Your employee membership is not active");
  return {
    ...base,
    organizationId: company.id,
    employeeId: employee?.id,
    permissions,
    companyName: company.name,
    companySlug: company.slug,
    isCompanyOwner: owner,
  };
}
export async function currentCompanyContext(
  payload: AuthUser,
  allowAccountOnly = false,
) {
  const user = await UserModel.findOne({
    _id: payload.userId,
    isActive: true,
    isDeleted: { $ne: true },
  });
  if (
    !user ||
    (user.credentialVersion || 0) !== (payload.credentialVersion || 0)
  )
    throw new UnauthenticatedException("Account is inactive or unavailable");
  try {
    return {
      user,
      auth: await resolveCompanyContext(user, payload.organizationId),
    };
  } catch (error) {
    if (!allowAccountOnly || !(error instanceof ForbiddenException))
      throw error;
    return { user, auth: await resolveCompanyContext(user) };
  }
}

// Revalidate remembered companies on every login; a saved preference is never
// evidence of membership or permission to enter a suspended/deleted company.
export async function defaultCompanyForLogin(
  user: any,
): Promise<string | undefined> {
  const memberships = user.isPlatformAdmin
    ? []
    : await MembershipModel.find({
        userId: user.id,
        status: "active",
        isDeleted: { $ne: true },
      }).select("organizationId");
  const companies = await OrganizationModel.find({
    status: "active",
    isDeleted: { $ne: true },
    ...(!user.isPlatformAdmin && {
      $or: [
        { ownerUserId: user.id },
        { _id: { $in: memberships.map((member) => member.organizationId) } },
      ],
    }),
  }).sort({ createdAt: 1, _id: 1 });
  const preferred = [user.lastOrganizationId, user.organizationId]
    .filter(Boolean)
    .map(String);
  const ordered = [
    ...preferred
      .map((id) => companies.find((company) => company.id === id))
      .filter(Boolean),
    ...companies,
  ];
  const seen = new Set<string>();
  for (const company of ordered) {
    if (!company || seen.has(company.id)) continue;
    seen.add(company.id);
    try {
      await resolveCompanyContext(user, company.id);
      return company.id;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
    }
  }
  return undefined;
}
export function sessionProfile(user: any, auth: AuthUser) {
  const {
    userId,
    employeeId,
    organizationId,
    permissions,
    accountType,
    isPlatformAdmin,
    isCompanyOwner,
    companyName,
    companySlug,
  } = auth;
  return {
    userId,
    employeeId,
    organizationId,
    permissions,
    accountType,
    isPlatformAdmin,
    isCompanyOwner,
    companyName,
    companySlug,
    loginId: user.loginId,
    email: user.email,
    name: user.name,
    photoVersion: user.photoVersion,
  };
}
export function requireCompanyOwner(auth: AuthUser) {
  if (!auth.isCompanyOwner && !auth.isPlatformAdmin)
    throw new ForbiddenException(
      "Only the company admin or Super Admin can do this",
    );
}
