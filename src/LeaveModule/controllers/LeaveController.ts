import { NextFunction, Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { writeAudit } from "../../AuditModule/utils/audit";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import {
  ConflictException,
  ForbiddenException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import LeaveRequestModel from "../models/LeaveRequest";
import LeaveTypeModel, { LeaveTypeClass } from "../models/LeaveType";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { validationRulesType } from "../../node-base/validator";
import { LeaveRequestClass } from "../models/LeaveRequest";
import { constants } from "../../node-base/constants";

const dayCount = (start: Date, end: Date) =>
  Math.floor(
    (Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) -
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      )) /
      86400000,
  ) + 1;

class LeaveTypeControllerClass extends BaseControllerClass<LeaveTypeClass> {
  _Model = LeaveTypeModel;
  _modelName = constants.fields.LeaveType.LeaveType;
}

const LeaveTypeController = new LeaveTypeControllerClass();

export class LeaveControllerClass extends BaseControllerClass<LeaveRequestClass> {
  _Model = LeaveRequestModel;
  _modelName = constants.fields.LeaveRequest.LeaveRequest;
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  public manageController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(req.query.size) || 20)),
    );
    const status = req.query.status;
    if (
      status &&
      !["pending", "approved", "rejected", "cancelled"].includes(String(status))
    )
      throw new ValidationException("Invalid leave status");
    const readFilter = {
      organizationId,
      ...(status && { status }),
      isDeleted: { $ne: true },
    };
    const [objs, totalCount] = await Promise.all([
      this.dbReadRecords({
        readFilter,
        page,
        limit,
        paginate: true,
        sort: { createdAt: -1 },
        baseFilter: false,
      }),
      this.dbCountDocs({ readFilter, baseFilter: false }),
    ]);
    const [people, types] = await Promise.all([
      EmployeeModel.find({
        organizationId,
        _id: { $in: objs.map((obj) => obj.employeeId) },
      }).select("firstName lastName employeeCode"),
      LeaveTypeModel.find({
        organizationId,
        _id: { $in: objs.map((obj) => obj.leaveTypeId) },
      }).select("name"),
    ]);
    const names = new Map(
      people.map((person) => [
        person.id,
        {
          name: `${person.firstName} ${person.lastName}`,
          employeeCode: person.employeeCode,
        },
      ]),
    );
    const typeNames = new Map(types.map((type) => [type.id, type.name]));
    return sendResponseObject({
      res,
      data: {
        leaveRequests: await Promise.all(
          objs.map(async (obj) => ({
            ...(await obj.display({ detail: true })),
            employee: names.get(obj.employeeId) || null,
            leaveTypeName: obj.requestKind === "work_from_home" ? "Work from Home" : typeNames.get(obj.leaveTypeId || "") || "Leave",
          })),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
      },
    });
  };

  public viewLeaveTypesController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const leaveTypes = await this.dbReadRecords({
      Collection: LeaveTypeModel,
      readFilter: {
        organizationId: req.auth!.organizationId,
        status: "active",
      },
      sort: { name: 1 },
      baseFilter: false,
    });

    return sendResponseObject({
      res,
      data: {
        leaveTypes: await Promise.all(leaveTypes.map((obj) => obj.display())),
      },
    });
  };

  public createLeaveTypeController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const { isValid, errorMessages, postData } = await this.validateData({
      data: { ...req.body, organizationId },
      validationRules: {
        organizationId: [{ rule: "required" }, { rule: "format", type: "id" }],
        name: [
          { rule: "required" },
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 64 },
          {
            rule: "unique",
            controller: LeaveTypeController,
            field: ({ keyData, data }) => ({
              organizationId: data.organizationId,
              name: keyData,
            }),
            baseFilter: false,
          },
        ],
        code: [{ rule: "datatype", datatype: "String" }],
        isPaid: [{ rule: "datatype", datatype: "Boolean" }],
        annualAllowanceDays: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0 },
        ],
        requiresAttachment: [{ rule: "datatype", datatype: "Boolean" }],
      },
    });

    if (!isValid) throw errorMessages;

    const obj = await this.dbInsertRecord({
      Collection: LeaveTypeModel,
      data: postData,
    });

    return sendResponseObject({
      res,
      code: 201,
      data: {
        [constants.fields.LeaveType.LeaveType]: await obj.display({
          detail: true,
        }),
      },
    });
  };

  public updateLeaveTypeController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const { isValid, errorMessages, postData } = await this.validateData({
      data: { ...req.body, id: req.params.id },
      operationType: "UPDATE",
      validationRules: {
        id: [
          { rule: "required" },
          { rule: "format", type: "id" },
          {
            operate: "fetchObj",
            controller: LeaveTypeController,
            field: ({ keyData }) => ({ _id: keyData, organizationId }),
            objField: "leaveType",
            baseFilter: false,
          },
        ],
        name: [{ rule: "datatype", datatype: "String" }],
        code: [{ rule: "datatype", datatype: "String" }],
        isPaid: [{ rule: "datatype", datatype: "Boolean" }],
        annualAllowanceDays: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0 },
        ],
        requiresAttachment: [{ rule: "datatype", datatype: "Boolean" }],
        status: [{ rule: "choices", options: ["active", "archived"] }],
      },
    });

    if (!isValid) return next(errorMessages);

    const existingObj = postData.leaveType;
    delete postData.id;
    delete postData.leaveType;

    const obj = await this.dbUpdateRecord({
      Collection: LeaveTypeModel,
      data: postData,
      obj: existingObj,
      filterObj: false,
    });
    if (!obj) return next(new ObjectNotFoundException("Leave type"));

    return sendResponseObject({
      res,
      data: {
        [constants.fields.LeaveType.LeaveType]: await obj.display({
          detail: true,
        }),
      },
    });
  };

  public createController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = req.auth!.employeeId!;
    const requestKind = req.body.requestKind === "work_from_home" ? "work_from_home" : "leave";
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        leaveTypeId: [
          ...(requestKind === "leave" ? [{ rule: "required" as const }] : []),
          { rule: "format", type: "id" },
          {
            rule: "exists",
            controller: LeaveTypeController,
            field: ({ keyData }) => ({
              _id: keyData,
              organizationId,
              status: "active",
            }),
            baseFilter: false,
          },
        ],
        requestKind: [{ rule: "choices", options: ["leave", "work_from_home"] }],
        startDate: [{ rule: "required" }, { rule: "format", type: "datetime" }],
        endDate: [{ rule: "required" }, { rule: "format", type: "datetime" }],
        totalDays: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0.5 },
        ],
        reason: [
          { rule: "datatype", datatype: "String" },
          { rule: "maxLength", length: 1024 },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const startDate = new Date(postData.startDate);
    const endDate = new Date(postData.endDate);

    if (endDate < startDate) {
      return next(
        new ValidationException({
          endDate: "End date must be after start date",
        }),
      );
    }

    const overlappingRequest = await this.dbReadRecord({
      readFilter: {
        organizationId,
        employeeId,
        status: { $in: ["pending", "approved"] },
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      },
      baseFilter: false,
    });

    if (overlappingRequest) {
      return next(
        new ConflictException("Leave dates overlap an existing request"),
      );
    }

    const obj = await this.dbInsertRecord({
      data: {
        organizationId,
        employeeId,
        leaveTypeId: postData.leaveTypeId,
        requestKind,
        startDate,
        endDate,
        totalDays: dayCount(startDate, endDate),
        reason: postData.reason,
      },
    });
    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "leave.requested",
      entityType: "LeaveRequest",
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

  public balancesController = async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = req.auth!.employeeId!;
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ValidationException("Invalid year");
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const [types, requests] = await Promise.all([
      LeaveTypeModel.find({ organizationId, status: "active", isDeleted: { $ne: true } }),
      LeaveRequestModel.find({ organizationId, employeeId, requestKind: { $ne: "work_from_home" }, status: { $in: ["approved", "pending"] }, startDate: { $lte: end }, endDate: { $gte: start }, isDeleted: { $ne: true } }),
    ]);
    const leaveBalances = types.map((type) => {
      const matching = requests.filter((request) => request.leaveTypeId === type.id);
      const daysInYear = (request: LeaveRequestClass) => dayCount(new Date(Math.max(new Date(request.startDate).getTime(), start.getTime())), new Date(Math.min(new Date(request.endDate).getTime(), end.getTime())));
      const usedDays = matching.filter((request) => request.status === "approved").reduce((sum, request) => sum + daysInYear(request), 0);
      const pendingDays = matching.filter((request) => request.status === "pending").reduce((sum, request) => sum + daysInYear(request), 0);
      return { leaveTypeId: type.id, name: type.name, allowanceDays: type.annualAllowanceDays || 0, usedDays, pendingDays, remainingDays: Math.max(0, (type.annualAllowanceDays || 0) - usedDays) };
    });
    return sendResponseObject({ res, data: { year, leaveBalances } });
  };

  public viewController = async (req: AuthenticatedRequest, res: Response) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);

    const readFilter: Record<string, any> = {
      organizationId: req.auth!.organizationId,
      employeeId: req.auth!.employeeId,
    };

    if (req.query.status) readFilter.status = req.query.status;

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
          objs.map((obj) => obj.display({ detail: true })),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
      },
    });
  };

  public pendingController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const directReports = await this.dbReadRecords({
      Collection: EmployeeModel,
      readFilter: {
        organizationId: req.auth!.organizationId,
        managerEmployeeId: req.auth!.employeeId,
      },
      selectFields: ["_id"],
      baseFilter: false,
    });
    const employeeIds = directReports.map((employee) => employee.id);
    const canManageAll = req.auth!.permissions.some((permission) =>
      ["*", "leave.manage"].includes(permission),
    );
    const objs = await this.dbReadRecords({
      readFilter: {
        organizationId: req.auth!.organizationId,
        ...(!canManageAll && { employeeId: { $in: employeeIds } }),
        status: "pending",
      },
      sort: { createdAt: 1 },
      baseFilter: false,
    });
    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          objs.map((obj) => obj.display({ detail: true })),
        ),
      },
    });
  };

  public reviewController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    if (!["approved", "rejected"].includes(req.body.status)) {
      return next(
        new ValidationException("status must be approved or rejected"),
      );
    }

    const obj = await this.dbReadRecord({
      readFilter: {
        _id: req.params.id,
        organizationId: req.auth!.organizationId,
        status: "pending",
      },
      baseFilter: false,
    });
    if (!obj) {
      return next(new ObjectNotFoundException("Pending leave request"));
    }

    const employee = await this.dbReadRecord({
      Collection: EmployeeModel,
      readFilter: {
        _id: obj.employeeId,
        organizationId: req.auth!.organizationId,
      },
      baseFilter: false,
    });
    const canManageAll =
      req.auth!.permissions.includes("*") ||
      req.auth!.permissions.includes("leave.manage");
    if (!canManageAll && employee?.managerEmployeeId !== req.auth!.employeeId) {
      return next(
        new ForbiddenException(
          "Only the employee's manager or leave admin can review this request",
        ),
      );
    }

    const updatedObj = await this.dbUpdateRecord({
      data: {
        status: req.body.status,
        reviewedByEmployeeId: req.auth!.employeeId,
        reviewedAt: new Date(),
        reviewComment: req.body.comment,
      },
      readFilter: {
        _id: obj.id,
        organizationId: req.auth!.organizationId,
        status: "pending",
      },
      baseFilter: false,
    });
    if (!updatedObj)
      return next(
        new ConflictException("This leave request has already been reviewed"),
      );

    await writeAudit({
      organizationId: req.auth!.organizationId!,
      actorUserId: req.auth!.userId,
      action: `leave.${req.body.status}`,
      entityType: "LeaveRequest",
      entityId: obj.id,
      after: updatedObj.toObject(),
    });

    return sendResponseObject({
      res,
      data: {
        [this._modelName]: await updatedObj.display({ detail: true }),
      },
    });
  };

  public cancelController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const obj = await this.dbUpdateRecord({
      readFilter: {
        _id: req.params.id,
        organizationId: req.auth!.organizationId,
        employeeId: req.auth!.employeeId,
        status: "pending",
      },
      data: { status: "cancelled" },
      baseFilter: false,
    });
    if (!obj) {
      return next(new ObjectNotFoundException("Pending leave request"));
    }

    return sendResponseObject({
      res,
      data: {
        [this._modelName]: await obj.display({ detail: true }),
      },
    });
  };
}

const LeaveController = new LeaveControllerClass();
export default LeaveController;
