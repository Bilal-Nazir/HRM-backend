import TeamModel from "../../OrganizationModule/models/Team";
import { requireCompanyOwner } from "../../TenantModule/services/companyContext";
import { NextFunction, Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { writeAudit } from "../../AuditModule/utils/audit";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import { BaseControllerClass } from "../../node-base/baseClasses";
import {
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import { validationRulesType } from "../../node-base/validator";
import RoleModel from "../models/Role";
import RoleAssignmentModel, {
  RoleAssignmentClass,
} from "../models/RoleAssignment";
import { permissionCatalogue } from "../utils/permissions";
import { constants } from "../../node-base/constants";

export class AccessControllerClass extends BaseControllerClass<RoleAssignmentClass> {
  _Model = RoleAssignmentModel;
  _modelName = constants.fields.RoleAssignment.RoleAssignment;
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  public permissionViewController = async (
    _req: AuthenticatedRequest,
    res: Response,
  ) => {
    return sendResponseObject({
      res,
      data: { permissions: permissionCatalogue },
    });
  };

  public roleViewController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const roles = await this.dbReadRecords({
      Collection: RoleModel,
      readFilter: {
        organizationId: req.auth!.organizationId,
        status: "active",
      },
      baseFilter: false,
    });

    return sendResponseObject({
      res,
      data: {
        roles: await Promise.all(roles.map((obj) => obj.display())),
      },
    });
  };

  public roleCreateController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    requireCompanyOwner(req.auth!);
    if (
      /^(organization admin|company admin|owner|super admin)$/i.test(
        String(req.body.name || "").trim(),
      )
    )
      throw new ValidationException(
        "This role name is reserved for the single company admin",
      );
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        name: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 64 },
        ],
        description: [{ rule: "datatype", datatype: "String" }],
        permissions: [
          { rule: "required" },
          { rule: "datatype", datatype: "Array" },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const hasInvalidPermission = !postData.permissions.every(
      (permission: string) => permissionCatalogue.includes(permission as any),
    );

    if (hasInvalidPermission) {
      return next(
        new ValidationException({
          permissions: "Role contains an unknown permission",
        }),
      );
    }

    const role = await this.dbInsertRecord({
      Collection: RoleModel,
      data: {
        ...postData,
        organizationId: req.auth!.organizationId,
      },
    });

    return sendResponseObject({
      res,
      code: 201,
      data: {
        [constants.fields.Role.Role]: await role.display({ detail: true }),
      },
    });
  };

  public assignmentViewController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const assignments = await this.dbReadRecords({
      readFilter: {
        organizationId: req.auth!.organizationId,
        employeeId: req.params.employeeId,
      },
      baseFilter: false,
    });

    await RoleAssignmentModel.populate(assignments, { path: "roleId" });

    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          assignments.map((obj) => obj.display({ detail: true })),
        ),
      },
    });
  };

  public assignmentCreateController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    requireCompanyOwner(req.auth!);
    const organizationId = req.auth!.organizationId!;

    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        employeeId: [{ rule: "required" }, { rule: "format", type: "id" }],
        roleId: [{ rule: "required" }, { rule: "format", type: "id" }],
        scopeType: [
          { rule: "required" },
          { rule: "choices", options: ["organization", "team", "self"] },
        ],
        scopeId: [{ rule: "format", type: "id" }],
        activeFrom: [{ rule: "format", type: "datetime" }],
        activeTo: [{ rule: "format", type: "datetime" }],
      },
    });

    if (!isValid) return next(errorMessages);

    const employee = await this.dbReadRecord({
      Collection: EmployeeModel,
      readFilter: { _id: postData.employeeId, organizationId },
      baseFilter: false,
    });

    const role = await this.dbReadRecord({
      Collection: RoleModel,
      readFilter: {
        _id: postData.roleId,
        organizationId,
        status: "active",
      },
      baseFilter: false,
    });

    if (role?.name === "Organization Admin")
      throw new ValidationException(
        "Use ownership transfer to change the company admin",
      );
    if (!employee || !role) {
      return next(
        new ValidationException({
          roleId: "Employee or role is invalid for this organization",
        }),
      );
    }

    if (postData.scopeType === "team" && !postData.scopeId) {
      return next(
        new ValidationException({ scopeId: "Required for team scope" }),
      );
    }

    if (
      postData.scopeType === "team" &&
      !(await TeamModel.exists({
        _id: postData.scopeId,
        organizationId,
        status: "active",
        isDeleted: { $ne: true },
      }))
    )
      throw new ValidationException("Choose a team in this company");
    if (
      postData.scopeId &&
      postData.scopeType === "organization" &&
      postData.scopeId !== organizationId
    )
      throw new ValidationException("Invalid company scope");
    if (
      postData.scopeId &&
      postData.scopeType === "self" &&
      postData.scopeId !== employee.id
    )
      throw new ValidationException("Invalid employee scope");

    const assignment = await this.dbUpsertRecord({
      readFilter: {
        organizationId,
        employeeId: employee.id,
        roleId: role.id,
        scopeType: postData.scopeType,
        scopeId: postData.scopeId,
      },
      data: { ...postData, organizationId },
      baseFilter: false,
    });

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "role.assigned",
      entityType: "RoleAssignment",
      entityId: assignment.id,
      after: assignment.toObject(),
    });

    return sendResponseObject({
      res,
      code: 201,
      data: {
        [this._modelName]: await assignment.display({ detail: true }),
      },
    });
  };

  public assignmentDeleteController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    requireCompanyOwner(req.auth!);
    const assignment = await this.dbUpdateRecord({
      readFilter: {
        _id: req.params.id,
        organizationId: req.auth!.organizationId,
      },
      data: { isDeleted: true },
      baseFilter: false,
    });

    if (!assignment) {
      return next(new ObjectNotFoundException("Role assignment"));
    }

    return sendResponseObject({
      res,
      data: {
        [this._modelName]: await assignment.display({ detail: true }),
      },
    });
  };
}

const AccessController = new AccessControllerClass();
export default AccessController;
