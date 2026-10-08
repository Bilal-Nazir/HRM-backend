import { NextFunction, Response } from "express";
import { DocumentType } from "@typegoose/typegoose";
import RoleAssignmentModel from "../../AccessModule/models/RoleAssignment";
import RoleModel from "../../AccessModule/models/Role";
import { writeAudit } from "../../AuditModule/utils/audit";
import UserModel from "../../AuthModule/models/User";
import { revokeUserSessions } from "../../AuthModule/utils/session";
import { hashPassword } from "../../AuthModule/utils/password";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import DepartmentModel from "../../OrganizationModule/models/Department";
import OfficeLocationModel from "../../OrganizationModule/models/OfficeLocation";
import TeamModel from "../../OrganizationModule/models/Team";
import {
  ConflictException,
  ForbiddenException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { validationRulesType } from "../../node-base/validator";
import EmployeeModel, { EmployeeClass } from "../models/Employee";
import { constants } from "../../node-base/constants";

const selfEditableFields = ["phone", "personalEmail", "timezone"];
const employeeFields = constants.fields.Employee;

export class EmployeeControllerClass extends BaseControllerClass<EmployeeClass> {
  _Model = EmployeeModel;
  _modelName = constants.fields.Employee.Employee;
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  private validateOrganizationReferences = async ({
    organizationId,
    data,
    employeeId,
  }: {
    organizationId: string;
    data: Record<string, any>;
    employeeId?: string;
  }) => {
    const referenceChecks = [
      { field: employeeFields.departmentId, Model: DepartmentModel },
      { field: employeeFields.teamId, Model: TeamModel },
      {
        field: employeeFields.primaryOfficeLocationId,
        Model: OfficeLocationModel,
      },
    ] as const;

    for (const reference of referenceChecks) {
      const referenceId = data[reference.field];
      if (!referenceId) continue;

      const exists = await this.dbReadRecord({
        Collection: reference.Model,
        readFilter: {
          _id: referenceId,
          organizationId,
          status: "active",
        },
        baseFilter: false,
      });

      if (!exists) {
        throw new ValidationException(
          `${reference.field} is invalid for this organization`,
        );
      }
    }

    if (!data[employeeFields.managerEmployeeId]) return;

    if (data[employeeFields.managerEmployeeId] === employeeId) {
      throw new ValidationException("Employee cannot manage themselves");
    }

    let manager = await this.dbReadRecord({
      readFilter: {
        [constants.fields._id]: data[employeeFields.managerEmployeeId],
        organizationId,
        [employeeFields.employmentStatus]:
          constants.statics.enums.Employment.status.active,
      },
      baseFilter: false,
    });

    if (!manager) {
      throw new ValidationException(
        "managerEmployeeId is invalid for this organization",
      );
    }

    const visitedManagers = new Set<string>();

    while (manager?.[employeeFields.managerEmployeeId]) {
      if (manager[employeeFields.managerEmployeeId] === employeeId) {
        throw new ValidationException(
          "Manager assignment would create a reporting cycle",
        );
      }

      if (visitedManagers.has(manager.id)) break;
      visitedManagers.add(manager.id);

      manager = await this.dbReadRecord({
        readFilter: {
          [constants.fields._id]: manager[employeeFields.managerEmployeeId],
          organizationId,
        },
        baseFilter: false,
      });
    }
  };

  public createController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const postData = { ...req.body, organizationId };

    const {
      isValid,
      errorMessages,
      postData: validatedData,
    } = await this.validateData({
      data: postData,
      validationRules: {
        [employeeFields.organizationId]: [
          { rule: "required" },
          { rule: "format", type: "id" },
        ],
        [employeeFields.employeeCode]: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 64 },
          {
            rule: "unique",
            controller: this,
            field: ({ keyData, data }) => ({
              organizationId: data.organizationId,
              employeeCode: keyData,
            }),
            baseFilter: false,
          },
        ],
        [employeeFields.firstName]: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 64 },
        ],
        [employeeFields.lastName]: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 64 },
        ],
        [employeeFields.workEmail]: [
          { rule: "required" },
          { rule: "format", type: "email" },
          {
            rule: "unique",
            controller: this,
            field: ({ keyData, data }) => ({
              organizationId: data.organizationId,
              workEmail: String(keyData).toLowerCase(),
            }),
            baseFilter: false,
          },
        ],
        password: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "minLength", length: 8 },
        ],
        [employeeFields.phone]: [{ rule: "datatype", datatype: "String" }],
        [employeeFields.jobTitle]: [{ rule: "datatype", datatype: "String" }],
        [employeeFields.departmentId]: [{ rule: "format", type: "id" }],
        [employeeFields.teamId]: [{ rule: "format", type: "id" }],
        [employeeFields.managerEmployeeId]: [{ rule: "format", type: "id" }],
        [employeeFields.primaryOfficeLocationId]: [
          { rule: "format", type: "id" },
        ],
        [employeeFields.employmentStatus]: [
          {
            rule: "choices",
            options: [
              "invited",
              "active",
              "suspended",
              "terminated",
              "archived",
            ],
          },
        ],
        [employeeFields.employmentType]: [
          {
            rule: "choices",
            options: ["full-time", "part-time", "contract", "intern"],
          },
        ],
        [employeeFields.joinDate]: [{ rule: "format", type: "datetime" }],
      },
    });

    if (!isValid) return next(errorMessages);

    await this.validateOrganizationReferences({
      organizationId,
      data: validatedData,
    });

    const user = (await this.dbInsertRecord({
      Collection: UserModel,
      data: {
        organizationId,
        loginId: String(validatedData.employeeCode).trim().toLowerCase(),
        passwordHash: await hashPassword(validatedData.password),
        isActive: true,
      },
    })) as any;

    delete validatedData.password;

    const obj = await this.dbInsertRecord({
      data: {
        ...validatedData,
        userId: user.id,
        employmentStatus: validatedData.employmentStatus || "active",
      },
    });

    const employeeRole = await this.dbReadRecord({
      Collection: RoleModel,
      readFilter: {
        [constants.fields.Role.organizationId]: organizationId,
        [constants.fields.Role.name]: req.body.roleName || "Employee",
        [constants.fields.Role.status]:
          constants.statics.enums.General.status.active,
      },
      baseFilter: false,
    });

    if (employeeRole) {
      await this.dbInsertRecord({
        Collection: RoleAssignmentModel,
        data: {
          organizationId,
          employeeId: obj.id,
          roleId: employeeRole.id,
          scopeType: "self",
        },
      });
    }

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "employee.created",
      entityType: "Employee",
      entityId: obj.id,
      after: obj.toObject(),
    });

    return sendResponseObject({
      res,
      code: 201,
      data: {
        [this._modelName]: await obj.display({ detail: true }),
      },
    });
  };

  public viewController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);

    const readFilter: Record<string, any> = {
      organizationId,
      isDeleted: { $ne: true },
    };

    const filterFields = [
      employeeFields.employmentStatus,
      employeeFields.departmentId,
      employeeFields.teamId,
      employeeFields.managerEmployeeId,
      employeeFields.primaryOfficeLocationId,
      employeeFields.employmentType,
    ];

    filterFields.forEach((field) => {
      if (req.query[field]) readFilter[field] = req.query[field];
    });

    if (req.query.search) {
      readFilter.$text = { $search: String(req.query.search) };
    }

    const objs = await this.dbReadRecords({
      readFilter,
      page,
      limit,
      paginate: true,
      baseFilter: false,
    });

    const totalCount = await this.dbCountDocs({
      readFilter,
      baseFilter: false,
    });

    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          objs.map((obj) => obj.display()),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
      },
    });
  };

  public readController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;

    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.params,
      validationRules: {
        id: [
          { rule: "required" },
          ...this.idValidationExtended({ organizationId }, false),
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const obj = postData[this._modelName] as DocumentType<EmployeeClass>;

    return sendResponseObject({
      res,
      data: {
        [this._modelName]: await obj.display({ detail: true }),
      },
    });
  };

  public selfController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    req.params.id = req.auth!.employeeId!;
    return this.readController(req, res, next);
  };

  public updateController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = String(req.params.id);
    const isSelfUpdate = employeeId === req.auth!.employeeId;
    const canUpdateEmployment =
      req.auth!.permissions.includes("*") ||
      req.auth!.permissions.includes("employee.update.employment");

    let requestData = { ...req.body, id: employeeId };

    if (isSelfUpdate && !canUpdateEmployment) {
      requestData = Object.fromEntries(
        Object.entries(requestData).filter(
          ([field]) => field === "id" || selfEditableFields.includes(field),
        ),
      );
    } else if (!canUpdateEmployment) {
      return next(new ForbiddenException());
    }

    const { isValid, errorMessages, postData } = await this.validateData({
      data: requestData,
      operationType: "UPDATE",
      validationRules: {
        id: [
          { rule: "required" },
          ...this.idValidationExtended({ organizationId }, false),
        ],
        [employeeFields.phone]: [{ rule: "datatype", datatype: "String" }],
        [employeeFields.personalEmail]: [{ rule: "format", type: "email" }],
        [employeeFields.timezone]: [{ rule: "datatype", datatype: "String" }],
        [employeeFields.jobTitle]: [{ rule: "datatype", datatype: "String" }],
        [employeeFields.departmentId]: [{ rule: "format", type: "id" }],
        [employeeFields.teamId]: [{ rule: "format", type: "id" }],
        [employeeFields.managerEmployeeId]: [{ rule: "format", type: "id" }],
        [employeeFields.primaryOfficeLocationId]: [
          { rule: "format", type: "id" },
        ],
        [employeeFields.employmentStatus]: [
          {
            rule: "choices",
            options: [
              "invited",
              "active",
              "suspended",
              "terminated",
              "archived",
            ],
          },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    await this.validateOrganizationReferences({
      organizationId,
      data: postData,
      employeeId,
    });

    const existingObj = postData[
      this._modelName
    ] as DocumentType<EmployeeClass>;
    delete postData.id;
    delete postData[this._modelName];

    const obj = await this.dbUpdateRecord({
      data: postData,
      obj: existingObj,
      filterObj: false,
    });

    const accessDisabledStatuses = ["suspended", "terminated", "archived"];

    if (obj?.userId && accessDisabledStatuses.includes(obj.employmentStatus)) {
      await this.dbUpdateRecord({
        Collection: UserModel,
        readFilter: { _id: obj.userId },
        data: { isActive: false },
        baseFilter: false,
      });
      await revokeUserSessions(String(obj.userId));
    }

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: isSelfUpdate
        ? "employee.profile.updated"
        : "employee.employment.updated",
      entityType: "Employee",
      entityId: obj!.id,
      before: existingObj.toObject(),
      after: obj!.toObject(),
    });

    return sendResponseObject({
      res,
      data: {
        [this._modelName]: await obj!.display({ detail: true }),
      },
    });
  };
}

const EmployeeController = new EmployeeControllerClass();
export default EmployeeController;
