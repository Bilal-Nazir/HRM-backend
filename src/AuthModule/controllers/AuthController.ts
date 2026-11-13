import { assertLoginPortal } from "../utils/loginPortal";
import {
  googleChallenge,
  verifyGoogleCredential,
} from "../utils/googleIdentity";
import MembershipModel from "../../TenantModule/models/CompanyMembership";
import {
  resolveCompanyContext,
  sessionProfile,
} from "../../TenantModule/services/companyContext";
import { sendCompanySession } from "../../TenantModule/controllers/CompanyController";
import { NextFunction, Request, Response } from "express";
import {
  UnauthenticatedException,
  ValidationException,
  sendResponseObject,
  logger,
  ConflictException,
} from "../../node-base/utils";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import RoleAssignmentModel from "../../AccessModule/models/RoleAssignment";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import UserModel, { UserClass } from "../models/User";
import { hashPassword, verifyPassword } from "../utils/password";
import { AuthenticatedRequest } from "../utils/types";
import { dataValidator } from "../../node-base/validator";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
import {
  generateSessionTokens,
  refreshAccessToken,
  revokeSession,
  revokeUserSessions,
} from "../utils/session";

const companyOwner = (company: any, user: any) =>
  String(company.ownerUserId || "") === user.id;

export class AuthControllerClass extends BaseControllerClass<UserClass> {
  _Model = UserModel;
  _modelName = constants.fields.User.User;

  public sessionController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const auth = req.auth!;
    const user = await UserModel.findOne({
      _id: auth.userId,
      isActive: true,
      isDeleted: { $ne: true },
    });
    if (
      !user ||
      (user.credentialVersion || 0) !== (auth.credentialVersion || 0) ||
      !["admin", "employee"].includes(auth.accountType || "")
    ) {
      throw new UnauthenticatedException("Account is inactive or unavailable");
    }
    res.set("Cache-Control", "no-store");
    return sendResponseObject({
      res,
      data: {
        user: sessionProfile(user, auth),
      },
    });
  };

  public updateProfileController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 128)
      throw new ValidationException("Enter a name up to 128 characters");
    const user = await UserModel.findOneAndUpdate(
      { _id: req.auth!.userId, isActive: true, isDeleted: { $ne: true } },
      { $set: { name } },
      { new: true },
    );
    if (!user) throw new UnauthenticatedException();
    return sendResponseObject({
      res,
      data: { user: sessionProfile(user, req.auth!) },
    });
  };

  public loginController = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const loginId = String(req.body.loginId || req.body.userId || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const organizationSlug = String(req.body.organizationSlug || "")
      .trim()
      .toLowerCase();
    const portal = String(req.body.portal || "")
      .trim()
      .toLowerCase();
    const validation = await dataValidator.validate(
      {
        loginId,
        password,
        organizationSlug,
        portal,
      },
      {
        loginId: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
        ],
        password: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
        ],
        organizationSlug: [{ rule: "format", type: "slug" }],
        portal: [
          { rule: "required" },
          { rule: "choices", options: ["admin", "employee"] },
        ],
      },
    );

    if (!validation.isValid) {
      return next(new ValidationException(validation.errorMessages));
    }

    const organization = organizationSlug
      ? await OrganizationModel.findOne({
          slug: organizationSlug,
          status: "active",
          isDeleted: { $ne: true },
        })
      : null;
    if (organizationSlug && !organization)
      throw new UnauthenticatedException("Invalid organization or credentials");
    let candidates = await UserModel.find({
      $or: [{ loginId }, { email: loginId }, { legacyLoginIds: loginId }],
      isActive: true,
      isDeleted: { $ne: true },
    })
      .select("+passwordHash")
      .limit(20);
    if (organization) {
      const profiles = await EmployeeModel.find({
        organizationId: organization.id,
        userId: { $in: candidates.map((user) => user.id) },
        isDeleted: { $ne: true },
      }).select("userId");
      const allowed = new Set(
        profiles.map((profile) => String(profile.userId)),
      );
      candidates = candidates.filter(
        (user) =>
          user.isPlatformAdmin ||
          companyOwner(organization, user) ||
          allowed.has(user.id),
      );
    }
    // Ambiguous legacy IDs require a company; never pick a user arbitrarily.
    const user = candidates.length === 1 ? candidates[0] : null;
    if (
      !user?.passwordHash ||
      !(await verifyPassword(password, user.passwordHash))
    )
      throw new UnauthenticatedException(
        "Invalid credentials. If your employee ID is shared, enter your company ID",
      );
    const organizationId =
      organization?.id || (await this.defaultCompany(user));
    const auth = await resolveCompanyContext(user, organizationId);
    assertLoginPortal(portal, !!user.isPlatformAdmin);
    return sendCompanySession(req, res, user, organizationId);
  };

  private defaultCompany = async (user: any): Promise<string | undefined> => {
    // Super Admin starts in the platform company manager.
    if (user.isPlatformAdmin) return undefined;
    const memberships = await MembershipModel.find({
      userId: user.id,
      status: "active",
      isDeleted: { $ne: true },
    });
    const companies = await OrganizationModel.find({
      status: "active",
      isDeleted: { $ne: true },
      $or: [
        { ownerUserId: user.id },
        {
          _id: {
            $in: memberships.map((membership) => membership.organizationId),
          },
        },
      ],
    }).limit(2);
    return companies.length === 1 ? companies[0].id : undefined;
  };

  public googleConfigurationController = async (_req: Request, res: Response) =>
    sendResponseObject({
      res,
      data: { enabled: !!process.env.GOOGLE_CLIENT_ID },
    });
  public googleChallengeController = async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    return sendResponseObject({ res, data: await googleChallenge() });
  };
  public googleLoginController = async (req: Request, res: Response) => {
    const portal = req.body.portal === undefined ? "employee" : req.body.portal;
    if (!["admin", "employee"].includes(portal))
      throw new ValidationException("Invalid login portal");
    const identity = await verifyGoogleCredential(
      req.body.credential,
      req.body.nonce,
    );
    let user: any = await UserModel.findOne({
      googleSubject: identity.subject,
      isDeleted: { $ne: true },
    }).select("+passwordHash +googleSubject");
    if (!user) {
      user = await UserModel.findOne({
        email: identity.email,
        isDeleted: { $ne: true },
      }).select("+passwordHash +googleSubject");
      assertLoginPortal(portal, !!user?.isPlatformAdmin);
      if (user) {
        if (user.googleSubject && user.googleSubject !== identity.subject)
          throw new UnauthenticatedException(
            "This email is connected to another Google identity",
          );
        if (
          user.passwordHash &&
          !(
            typeof req.body.existingPassword === "string" &&
            (await verifyPassword(req.body.existingPassword, user.passwordHash))
          )
        )
          throw new ConflictException(
            "An account already uses this email. Enter its existing password to connect Google",
          );
        const linked = await UserModel.findOneAndUpdate(
          {
            _id: user.id,
            googleSubject: { $exists: false },
            isActive: true,
            isDeleted: { $ne: true },
          },
          { $set: { googleSubject: identity.subject } },
          { new: true },
        );
        if (!linked)
          throw new ConflictException("Account changed. Please sign in again");
        user = linked as any;
      } else {
        try {
          user = await UserModel.create({
            loginId: identity.email,
            email: identity.email,
            googleSubject: identity.subject,
            name: identity.name,
            isActive: true,
          });
        } catch (error: any) {
          if (error.code === 11000)
            throw new ConflictException(
              "Account already exists. Sign in again",
            );
          throw error;
        }
      }
    }
    assertLoginPortal(portal, !!user?.isPlatformAdmin);
    if (!user || !user.isActive)
      throw new UnauthenticatedException("Account is inactive");
    return sendCompanySession(req, res, user, await this.defaultCompany(user));
  };

  public refreshController = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const refreshToken = String(req.body.refreshToken || "");
    const validation = await dataValidator.validate(
      { refreshToken },
      {
        refreshToken: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
        ],
      },
    );

    if (!validation.isValid) {
      return next(new ValidationException(validation.errorMessages));
    }

    const session = await refreshAccessToken(refreshToken);
    if (!session) {
      return next(
        new UnauthenticatedException("Invalid or expired refresh token"),
      );
    }

    const user = await this.dbReadRecord({
      readFilter: {
        _id: session.payload.userId,
        isActive: true,
        isDeleted: { $ne: true },
      },
      baseFilter: false,
    });
    if (
      !user ||
      (user.credentialVersion || 0) !== (session.payload.credentialVersion || 0)
    ) {
      await revokeSession(undefined, refreshToken);
      return next(
        new UnauthenticatedException("Account is inactive or unavailable"),
      );
    }

    return sendResponseObject({
      res,
      data: { accessToken: session.accessToken },
    });
  };

  public logoutController = async (req: Request, res: Response) => {
    const authorization = req.headers.authorization;
    const accessToken = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : req.get("accessToken") || undefined;
    const refreshToken = req.body.refreshToken
      ? String(req.body.refreshToken)
      : req.get("refreshToken") || undefined;

    await revokeSession(accessToken, refreshToken);
    return sendResponseObject({ res, data: {} });
  };

  public changePasswordController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const fields = constants.fields.User;
    const { isValid, errorMessages } = await this.validateData({
      data: req.body,
      validationRules: {
        [fields.currentPassword]: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
        ],
        [fields.newPassword]: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          {
            rule: "custom",
            custom: async () => ({
              isValid:
                typeof req.body.newPassword === "string" &&
                req.body.newPassword.length >= 8 &&
                Buffer.byteLength(req.body.newPassword, "utf8") <= 72,
              errorMessages:
                "Use at least 8 characters and no more than 72 UTF-8 bytes",
            }),
          },
        ],
        [fields.confirmPassword]: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          {
            rule: "custom",
            custom: async () => ({
              isValid: req.body.confirmPassword === req.body.newPassword,
              errorMessages: "Passwords do not match",
            }),
          },
        ],
      },
    });
    if (!isValid) return next(errorMessages);

    const user = await this.dbReadRecord({
      readFilter: {
        [constants.fields._id]: req.auth!.userId,
        [fields.isActive]: true,
      },
      selectFields: ["+passwordHash"],
      baseFilter: false,
    });
    if (!user) return next(new UnauthenticatedException());
    if (!(await verifyPassword(req.body.currentPassword, user.passwordHash)))
      return next(
        new ValidationException({
          [fields.currentPassword]: "Current password is incorrect",
        }),
      );
    if (await verifyPassword(req.body.newPassword, user.passwordHash))
      return next(
        new ValidationException({
          [fields.newPassword]: "Choose a different password",
        }),
      );

    // Preserve password whitespace; validator trimming must never change a secret.
    // Compare-and-set prevents simultaneous password changes from overwriting one another.
    const updated = await this.dbUpdateRecord({
      readFilter: {
        [constants.fields._id]: user.id,
        [fields.passwordHash]: user.passwordHash,
        [fields.isActive]: true,
      },
      data: {
        $set: {
          [fields.passwordHash]: await hashPassword(req.body.newPassword),
        },
        $inc: { [fields.credentialVersion]: 1 },
      },
      baseFilter: false,
    });
    if (!updated)
      return next(
        new ConflictException("Your account changed. Sign in again and retry."),
      );
    // Version checks invalidate old access AND refresh tokens even if Redis cleanup fails.
    try {
      await revokeUserSessions(user.id);
    } catch {
      logger.warn(
        "Password changed; expired session cleanup could not be completed",
      );
    }
    return sendResponseObject({
      res,
      message: "Password updated. Please sign in again.",
      data: {},
    });
  };
}

export default new AuthControllerClass();
