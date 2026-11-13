import { createHash, randomBytes } from "crypto";
import { Response } from "express";
import { isValidObjectId } from "mongoose";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import {
  generateSessionTokens,
  revokeSession,
} from "../../AuthModule/utils/session";
import UserModel from "../../AuthModule/models/User";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import RoleModel from "../../AccessModule/models/Role";
import RoleAssignmentModel from "../../AccessModule/models/RoleAssignment";
import { defaultRoles } from "../../AccessModule/utils/permissions";
import { ensureDefaultLeaveTypes } from "../../database/scripts/createDefaultLeaveTypesScript";
import LeaveTypeModel from "../../LeaveModule/models/LeaveType";
import { writeAudit } from "../../AuditModule/utils/audit";
import {
  ConflictException,
  ForbiddenException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import MembershipModel from "../models/CompanyMembership";
import InvitationModel from "../models/CompanyInvitation";
import {
  requireCompanyOwner,
  resolveCompanyContext,
  sessionProfile,
} from "../services/companyContext";

export async function sendCompanySession(
  req: AuthenticatedRequest,
  res: Response,
  user: any,
  organizationId?: string,
  code = 200,
) {
  const auth = await resolveCompanyContext(user, organizationId);
  const tokens = await generateSessionTokens(auth);
  await revokeSession(
    req.headers.authorization?.replace(/^Bearer /, ""),
    req.body.refreshToken,
  );
  res.set("Cache-Control", "no-store");
  return sendResponseObject({
    res,
    code,
    data: { ...tokens, user: sessionProfile(user, auth) },
  });
}
export async function listCompanies(req: AuthenticatedRequest, res: Response) {
  const memberships = await MembershipModel.find({
    userId: req.auth!.userId,
    status: "active",
    isDeleted: { $ne: true },
  });
  const companies = await OrganizationModel.find({
    isDeleted: { $ne: true },
    ...(req.auth!.isPlatformAdmin
      ? {}
      : {
          $or: [
            { ownerUserId: req.auth!.userId },
            {
              _id: {
                $in: memberships.map((membership) => membership.organizationId),
              },
            },
          ],
        }),
  }).sort({ name: 1 });
  return sendResponseObject({
    res,
    data: {
      companies: await Promise.all(
        companies.map(async (company) => ({
          ...(await company.display()),
          isOwner: company.ownerUserId === req.auth!.userId,
          canEnter: company.status === "active" || !!req.auth!.isPlatformAdmin,
        })),
      ),
    },
  });
}
export async function createCompany(req: AuthenticatedRequest, res: Response) {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const slug =
    typeof req.body.slug === "string" ? req.body.slug.trim().toLowerCase() : "";
  const timezone =
    typeof req.body.timezone === "string" ? req.body.timezone : "UTC";
  if (
    !name ||
    name.length > 128 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    slug.length > 64
  )
    throw new ValidationException(
      "Enter a company name and a valid unique company ID",
    );
  try {
    Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new ValidationException("Invalid time zone");
  }
  const user = await UserModel.findById(req.auth!.userId);
  if (!user?.email && !user?.isPlatformAdmin)
    throw new ValidationException(
      "Connect a Google account before creating a company",
    );
  if (await OrganizationModel.exists({ slug }))
    throw new ConflictException("This company ID is already in use");
  let company;
  try {
    company = await OrganizationModel.create({
      name,
      slug,
      timezone,
      ownerUserId: user!.id,
      status: "provisioning",
    });
    await RoleModel.insertMany([
      {
        organizationId: company.id,
        name: "Employee",
        permissions: defaultRoles.employee,
        isSystemRole: true,
      },
      {
        organizationId: company.id,
        name: "Manager",
        permissions: defaultRoles.manager,
        isSystemRole: true,
      },
    ]);
    await MembershipModel.create({
      organizationId: company.id,
      userId: user!.id,
    });
    await ensureDefaultLeaveTypes(company.id);
    company.status = "active";
    await company.save();
  } catch (error: any) {
    if (company)
      await Promise.all([
        RoleModel.deleteMany({ organizationId: company.id }),
        MembershipModel.deleteMany({ organizationId: company.id }),
        LeaveTypeModel.deleteMany({ organizationId: company.id }),
        OrganizationModel.deleteOne({ _id: company.id }),
      ]);
    if (error.code === 11000)
      throw new ConflictException("This company ID is already in use");
    throw error;
  }
  await writeAudit({
    organizationId: company.id,
    actorUserId: user!.id,
    action: "company.created",
    entityType: "Organization",
    entityId: company.id,
    after: { name, slug },
  });
  return sendCompanySession(req, res, user, company.id, 201);
}
export async function switchCompany(req: AuthenticatedRequest, res: Response) {
  if (!isValidObjectId(req.params.id))
    throw new ValidationException("Invalid company");
  const user = await UserModel.findById(req.auth!.userId);
  return sendCompanySession(req, res, user, String(req.params.id));
}
export async function platformHome(req: AuthenticatedRequest, res: Response) {
  if (!req.auth!.isPlatformAdmin) throw new ForbiddenException();
  const user = await UserModel.findById(req.auth!.userId);
  return sendCompanySession(req, res, user);
}
export async function updateCompanyStatus(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (!req.auth!.isPlatformAdmin) throw new ForbiddenException();
  if (
    !isValidObjectId(req.params.id) ||
    !["active", "suspended"].includes(req.body.status)
  )
    throw new ValidationException(
      "Select an active or suspended company status",
    );
  const company = await OrganizationModel.findOneAndUpdate(
    { _id: req.params.id, isDeleted: { $ne: true } },
    { $set: { status: req.body.status } },
    { new: true },
  );
  if (!company) throw new ObjectNotFoundException("Company");
  await writeAudit({
    organizationId: company.id,
    actorUserId: req.auth!.userId,
    action: "company.status_changed",
    entityType: "Organization",
    entityId: company.id,
    after: { status: company.status },
  });
  return sendResponseObject({
    res,
    data: { company: await company.display() },
  });
}
export async function companyMembers(req: AuthenticatedRequest, res: Response) {
  requireCompanyOwner(req.auth!);
  const employees = await EmployeeModel.find({
    organizationId: req.auth!.organizationId,
    employmentStatus: { $in: ["active", "invited"] },
    isDeleted: { $ne: true },
  })
    .select("firstName lastName workEmail employeeCode userId")
    .lean();
  return sendResponseObject({
    res,
    data: {
      members: employees.map((employee) => ({
        id: String(employee._id),
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.workEmail,
        employeeCode: employee.employeeCode,
        userId: employee.userId,
      })),
    },
  });
}
export async function transferOwnership(
  req: AuthenticatedRequest,
  res: Response,
) {
  requireCompanyOwner(req.auth!);
  const { userId, confirmation } = req.body;
  const organizationId = req.auth!.organizationId;
  const company = await OrganizationModel.findById(organizationId);
  if (!company || confirmation !== company.slug || !isValidObjectId(userId))
    throw new ValidationException(
      "Select an active company member and confirm the company ID",
    );
  if (userId === company.ownerUserId)
    throw new ValidationException("This account already owns the company");
  const [target, membership, employee] = await Promise.all([
    UserModel.findOne({
      _id: userId,
      isActive: true,
      isDeleted: { $ne: true },
    }),
    MembershipModel.findOne({
      organizationId,
      userId,
      status: "active",
      isDeleted: { $ne: true },
    }),
    EmployeeModel.findOne({
      organizationId,
      userId,
      employmentStatus: "active",
      isDeleted: { $ne: true },
    }),
  ]);
  if (!target || !membership || !employee)
    throw new ValidationException(
      "The new admin must be an active member of this company",
    );
  const updated = await OrganizationModel.findOneAndUpdate(
    {
      _id: company.id,
      ownerUserId: company.ownerUserId,
      membershipVersion: company.membershipVersion || 0,
    },
    { $set: { ownerUserId: userId }, $inc: { membershipVersion: 1 } },
    { new: true },
  );
  if (!updated)
    throw new ConflictException(
      "Company ownership changed. Reload and try again",
    );
  await writeAudit({
    organizationId: company.id,
    actorUserId: req.auth!.userId,
    action: "company.ownership_transferred",
    entityType: "Organization",
    entityId: company.id,
    before: { ownerUserId: company.ownerUserId },
    after: { ownerUserId: userId },
  });
  const outgoingEmployee = await EmployeeModel.exists({
    organizationId,
    userId: company.ownerUserId,
    employmentStatus: "active",
    isDeleted: { $ne: true },
  });
  if (!outgoingEmployee)
    await MembershipModel.updateOne(
      { organizationId, userId: company.ownerUserId },
      { $set: { status: "suspended" } },
    );
  // Return to company selection: the outgoing owner may have no employee profile.
  const user = await UserModel.findById(req.auth!.userId);
  return sendCompanySession(req, res, user);
}
export async function createInvitation(
  req: AuthenticatedRequest,
  res: Response,
) {
  requireCompanyOwner(req.auth!);
  const organizationId = req.auth!.organizationId!;
  if (!isValidObjectId(req.body.employeeId))
    throw new ValidationException("Choose an employee");
  const employee = await EmployeeModel.findOne({
    _id: req.body.employeeId,
    organizationId,
    employmentStatus: { $in: ["invited", "active"] },
    isDeleted: { $ne: true },
  });
  if (!employee) throw new ObjectNotFoundException("Employee");
  const token = randomBytes(32).toString("hex");
  await InvitationModel.updateMany(
    { organizationId, employeeId: employee.id, status: "pending" },
    { $set: { status: "revoked" } },
  );
  const invitation = await InvitationModel.create({
    organizationId,
    employeeId: employee.id,
    email: employee.workEmail,
    invitedByUserId: req.auth!.userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  await writeAudit({
    organizationId,
    actorUserId: req.auth!.userId,
    action: "company.invitation_created",
    entityType: "CompanyInvitation",
    entityId: invitation.id,
    after: { employeeId: employee.id, email: employee.workEmail },
  });
  // Explicitly return a shareable link; sending email is a separate integration.
  return sendResponseObject({
    res,
    code: 201,
    data: { token, email: employee.workEmail, expiresAt: invitation.expiresAt },
  });
}
export async function acceptInvitation(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (
    typeof req.body.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(req.body.token)
  )
    throw new ValidationException("Invalid invitation");
  const user = await UserModel.findById(req.auth!.userId);
  const invitation = await InvitationModel.findOne({
    tokenHash: createHash("sha256").update(req.body.token).digest("hex"),
    status: "pending",
    expiresAt: { $gt: new Date() },
    isDeleted: { $ne: true },
  });
  if (!invitation || !user?.email || invitation.email !== user.email)
    throw new ForbiddenException(
      "Sign in with the email address on a valid invitation",
    );
  const company = await OrganizationModel.findOne({
    _id: invitation.organizationId,
    status: "active",
    isDeleted: { $ne: true },
  });
  if (!company) throw new ForbiddenException("Company is unavailable");
  // An invitation never detaches a profile from a different account.
  const employee = await EmployeeModel.findOneAndUpdate(
    {
      _id: invitation.employeeId,
      organizationId: invitation.organizationId,
      workEmail: user.email,
      isDeleted: { $ne: true },
      employmentStatus: { $in: ["invited", "active"] },
      $or: [{ userId: user.id }, { userId: { $exists: false } }],
    },
    { $set: { userId: user.id, employmentStatus: "active" } },
    { new: true },
  );
  if (!employee)
    throw new ConflictException(
      "Employee account changed. Ask your company admin for a new invitation",
    );
  await MembershipModel.findOneAndUpdate(
    { organizationId: company.id, userId: user.id },
    { $set: { employeeId: employee.id, status: "active", isDeleted: false } },
    { upsert: true },
  );
  await InvitationModel.updateOne(
    { _id: invitation.id, status: "pending" },
    { $set: { status: "accepted", acceptedAt: new Date() } },
  );
  return sendCompanySession(req, res, user, company.id);
}
