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

export class AuthControllerClass extends BaseControllerClass<UserClass> {
  _Model = UserModel;
  _modelName = constants.fields.User.User;

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
    const portal = String(req.body.portal || "").trim().toLowerCase();
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
      ? await this.dbReadRecord({
          Collection: OrganizationModel,
          readFilter: {
            slug: organizationSlug,
            status: "active",
          },
          baseFilter: false,
        })
      : null;
    if (organizationSlug && !organization)
      return next(
        new UnauthenticatedException("Invalid organization or credentials"),
      );
    const user = await this.dbReadRecord({
      readFilter: {
        loginId,
        ...(organization && { organizationId: organization._id }),
        isActive: true,
      },
      selectFields: ["+passwordHash"],
      baseFilter: false,
    });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return next(new UnauthenticatedException("Invalid user ID or password"));
    }

    const employee = await this.dbReadRecord({
      Collection: EmployeeModel,
      readFilter: {
        userId: user._id,
        employmentStatus: "active",
      },
      baseFilter: false,
    });
    if (!user.isPlatformAdmin && !employee)
      return next(
        new UnauthenticatedException("Employee account is not active"),
      );

    const assignments = employee
      ? await this.dbReadRecords({
          Collection: RoleAssignmentModel,
          readFilter: { employeeId: employee._id },
          baseFilter: false,
        })
      : [];

    await RoleAssignmentModel.populate(assignments, { path: "roleId" });
    const permissions = user.isPlatformAdmin
      ? ["*"]
      : [
          ...new Set(
            assignments.flatMap(
              (assignment: any) => assignment.roleId?.permissions || [],
            ),
          ),
        ];

    const isAdmin =
      user.isPlatformAdmin ||
      assignments.some(
        (assignment: any) => assignment.roleId?.name === "Organization Admin",
      );
    const accountType: "admin" | "employee" = isAdmin ? "admin" : "employee";
    if (portal !== accountType) {
      return next(
        new UnauthenticatedException(
          portal === "admin"
            ? "This account cannot sign in to the admin portal"
            : "Administrator accounts must use the admin portal",
        ),
      );
    }

    const payload = {
      userId: user.id,
      employeeId: employee?.id,
      organizationId:
        employee?.organizationId?.toString() || user.organizationId?.toString(),
      permissions,
      accountType,
      credentialVersion: user.credentialVersion || 0,
    };
    const { accessToken, refreshToken } = await generateSessionTokens(payload);
    res.set("Access-Control-Expose-Headers", "accessToken, refreshToken");
    res.set("accessToken", accessToken);
    res.set("refreshToken", refreshToken);
    return sendResponseObject({
      res,
      data: {
        accessToken,
        refreshToken,
        [this._modelName]: await user.display({ baseData: payload }),
      },
    });
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
