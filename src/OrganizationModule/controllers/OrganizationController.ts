import { NextFunction, Request, Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import UserModel from "../../AuthModule/models/User";
import { hashPassword } from "../../AuthModule/utils/password";
import RoleModel from "../../AccessModule/models/Role";
import RoleAssignmentModel from "../../AccessModule/models/RoleAssignment";
import { defaultRoles } from "../../AccessModule/utils/permissions";
import { writeAudit } from "../../AuditModule/utils/audit";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import {
  ConflictException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import DepartmentModel from "../models/Department";
import OfficeLocationModel from "../models/OfficeLocation";
import OrganizationModel from "../models/Organization";
import TeamModel from "../models/Team";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { validationRulesType } from "../../node-base/validator";
import { OrganizationClass } from "../models/Organization";
import { constants } from "../../node-base/constants";
import { ensureDefaultLeaveTypes } from "../../database/scripts/createDefaultLeaveTypesScript";

const timezoneValid = (value: string) => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export class OrganizationControllerClass extends BaseControllerClass<OrganizationClass> {
  _Model = OrganizationModel;
  _modelName = constants.fields.Organization.Organization;
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  public bootstrapController = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationCount = await this.dbCountDocs({
      readFilter: {},
      deletedRecords: true,
      baseFilter: false,
    });

    if (organizationCount)
      return next(new ConflictException("Bootstrap is already complete"));
    const { organization, admin } = req.body;
    if (
      !organization?.name ||
      !organization?.slug ||
      !organization?.timezone ||
      !admin?.employeeCode ||
      !admin?.email ||
      !admin?.password
    )
      return next(
        new ValidationException(
          "Organization and initial admin details are required",
        ),
      );
    if (!timezoneValid(organization.timezone))
      return next(new ValidationException("Invalid organization timezone"));
    const { isValid, errorMessages, postData } = await this.validateData({
      data: organization || {},
      validationRules: {
        name: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 128 },
        ],
        slug: [
          { rule: "required" },
          { rule: "format", type: "slug" },
          {
            rule: "unique",
            controller: this,
            field: "slug",
            baseFilter: false,
          },
        ],
        timezone: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const org = await this.dbInsertRecord({
      data: { ...postData, slug: postData.slug.toLowerCase() },
    });
    await ensureDefaultLeaveTypes(org.id);

    const roles = await this.dbInsertRecords({
      Collection: RoleModel,
      data: [
        {
          organizationId: org.id,
          name: "Organization Admin",
          permissions: defaultRoles.organizationAdmin,
          isSystemRole: true,
        },
        {
          organizationId: org.id,
          name: "Manager",
          permissions: defaultRoles.manager,
          isSystemRole: true,
        },
        {
          organizationId: org.id,
          name: "Employee",
          permissions: defaultRoles.employee,
          isSystemRole: true,
        },
      ],
    });

    const user = (await this.dbInsertRecord({
      Collection: UserModel,
      data: {
        organizationId: org.id,
        loginId: String(admin.employeeCode).trim().toLowerCase(),
        passwordHash: await hashPassword(admin.password),
        isActive: true,
      },
    })) as any;

    const employee = (await this.dbInsertRecord({
      Collection: EmployeeModel,
      data: {
        organizationId: org.id,
        userId: user.id,
        employeeCode: admin.employeeCode,
        firstName: admin.firstName || "Organization",
        lastName: admin.lastName || "Admin",
        workEmail: admin.email,
        jobTitle: admin.jobTitle || "Organization Admin",
        employmentStatus: "active",
        joinDate: new Date(),
      },
    })) as any;

    await this.dbInsertRecord({
      Collection: RoleAssignmentModel,
      data: {
        organizationId: org.id,
        employeeId: employee.id,
        roleId: roles[0].id,
        scopeType: "organization",
      },
    });
    await writeAudit({
      organizationId: org.id,
      actorUserId: user.id,
      action: "organization.created",
      entityType: "Organization",
      entityId: org.id,
      after: org.toObject(),
    });
    return sendResponseObject({
      res,
      code: 201,
      data: {
        [this._modelName]: await org.display({ detail: true }),
        [constants.fields.Employee.Employee]: await employee.display({
          detail: true,
        }),
      },
    });
  };
  public readController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organization = await this.dbReadRecord({
      readFilter: { _id: req.auth!.organizationId },
      baseFilter: false,
    });
    if (!organization) return next(new ObjectNotFoundException("Organization"));
    return sendResponseObject({
      res,
      data: { [this._modelName]: await organization.display({ detail: true }) },
    });
  };
  public updateController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (req.body.timezone && !timezoneValid(req.body.timezone))
      return next(new ValidationException("Invalid timezone"));
    const before = await this.dbReadRecord({
      readFilter: { _id: req.auth!.organizationId },
      baseFilter: false,
    });

    const organization = await this.dbUpdateRecord({
      readFilter: { _id: req.auth!.organizationId },
      data: req.body,
      baseFilter: false,
    });
    if (!organization) return next(new ObjectNotFoundException("Organization"));
    await writeAudit({
      organizationId: organization.id,
      actorUserId: req.auth!.userId,
      action: "organization.updated",
      entityType: "Organization",
      entityId: organization.id,
      before: before!.toObject(),
      after: organization.toObject(),
    });
    return sendResponseObject({
      res,
      data: { [this._modelName]: await organization.display({ detail: true }) },
    });
  };
}
export default new OrganizationControllerClass();

export class OrganizationUnitController extends BaseControllerClass<any> {
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  constructor(
    public _Model: any,
    public _modelName: string,
  ) {
    super();
  }
  list = async (req: AuthenticatedRequest, res: Response) =>
    sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          (
            await this.dbReadRecords({
              readFilter: { organizationId: req.auth!.organizationId },
              sort: { name: 1 },
              baseFilter: false,
            })
          ).map((obj) => obj.display()),
        ),
      },
    });
  create = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const { isValid, errorMessages, postData } = await this.validateData({
      data: { ...req.body, organizationId: req.auth!.organizationId },
      validationRules: {
        organizationId: [{ rule: "required" }, { rule: "format", type: "id" }],
        name: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 128 },
        ],
        code: [{ rule: "datatype", datatype: "String" }],
        departmentId: [{ rule: "format", type: "id" }],
        latitude: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -90 },
          { rule: "maxValue", value: 90 },
        ],
        longitude: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -180 },
          { rule: "maxValue", value: 180 },
        ],
        geofenceRadiusMeters: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 1 },
          { rule: "maxValue", value: 100000 },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const item = await this.dbInsertRecord({ data: postData });
    await writeAudit({
      organizationId: req.auth!.organizationId!,
      actorUserId: req.auth!.userId,
      action: `${this._modelName.toLowerCase()}.created`,
      entityType: this._modelName,
      entityId: item.id,
      after: item.toObject(),
    });
    return sendResponseObject({
      res,
      code: 201,
      data: { [this._modelName]: await item.display({ detail: true }) },
    });
  };
  update = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const item = await this.dbUpdateRecord({
      readFilter: {
        _id: req.params.id,
        organizationId: req.auth!.organizationId,
      },
      data: req.body,
      baseFilter: false,
    });
    if (!item) return next(new ObjectNotFoundException(this._modelName));
    return sendResponseObject({
      res,
      data: { [this._modelName]: await item.display({ detail: true }) },
    });
  };
  archive = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const item = await this.dbUpdateRecord({
      readFilter: {
        _id: req.params.id,
        organizationId: req.auth!.organizationId,
      },
      data: { status: "archived" },
      baseFilter: false,
    });
    if (!item) return next(new ObjectNotFoundException(this._modelName));
    return sendResponseObject({
      res,
      data: { [this._modelName]: await item.display({ detail: true }) },
    });
  };
}
export const OfficeController = new OrganizationUnitController(
  OfficeLocationModel,
  constants.fields.OfficeLocation.OfficeLocation,
);
export const DepartmentController = new OrganizationUnitController(
  DepartmentModel,
  constants.fields.Department.Department,
);
export const TeamController = new OrganizationUnitController(
  TeamModel,
  constants.fields.Team.Team,
);
