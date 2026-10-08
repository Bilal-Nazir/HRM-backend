import { NextFunction, Response } from "express";
import { writeAudit } from "../../AuditModule/utils/audit";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import OfficeLocationModel from "../../OrganizationModule/models/OfficeLocation";
import {
  ConflictException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import AttendanceModel from "../models/Attendance";
import { distanceMeters } from "../utils/geofence";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { validationRulesType } from "../../node-base/validator";
import { AttendanceClass } from "../models/Attendance";
import { constants } from "../../node-base/constants";

export class AttendanceControllerClass extends BaseControllerClass<AttendanceClass> {
  _Model = AttendanceModel;
  _modelName = constants.fields.Attendance.Attendance;
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
    const scope = { organizationId, isDeleted: { $ne: true } };
    const openFilter = {
      ...scope,
      status: { $in: ["open", "flagged"] },
      checkOutAt: { $exists: false },
    };
    const readFilter = req.query.open === "true" ? openFilter : scope;
    const [objs, totalCount, presentNow, activeEmployees, attendanceFlags] =
      await Promise.all([
        this.dbReadRecords({
          readFilter,
          page,
          limit,
          paginate: true,
          sort: { checkInAt: -1 },
          baseFilter: false,
        }),
        this.dbCountDocs({ readFilter, baseFilter: false }),
        this.dbCountDocs({ readFilter: openFilter, baseFilter: false }),
        EmployeeModel.countDocuments({ ...scope, employmentStatus: "active" }),
        this.dbCountDocs({
          readFilter: { ...openFilter, checkInWithinGeofence: false },
          baseFilter: false,
        }),
      ]);
    const people = await EmployeeModel.find({
      ...scope,
      _id: { $in: objs.map((obj) => obj.employeeId) },
    }).select("firstName lastName employeeCode");
    const names = new Map(
      people.map((person) => [
        person.id,
        {
          name: `${person.firstName} ${person.lastName}`,
          employeeCode: person.employeeCode,
        },
      ]),
    );
    return sendResponseObject({
      res,
      data: {
        attendances: await Promise.all(
          objs.map(async (obj) => ({
            ...(await obj.display()),
            employee: names.get(obj.employeeId) || null,
          })),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
        summary: { presentNow, activeEmployees, attendanceFlags },
      },
    });
  };

  private getLocationData = (data: Record<string, any>) => {
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);

    const invalidLatitude =
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90;
    const invalidLongitude =
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180;

    if (invalidLatitude || invalidLongitude) {
      throw new ValidationException(
        "Valid latitude and longitude are required",
      );
    }

    return {
      latitude,
      longitude,
      accuracyMeters: data.accuracyMeters,
      address: data.address,
      capturedAt: new Date(),
    };
  };

  private getOfficeDistance = async ({
    organizationId,
    officeLocationId,
    latitude,
    longitude,
  }: {
    organizationId: string;
    officeLocationId?: string;
    latitude: number;
    longitude: number;
  }) => {
    if (!officeLocationId) {
      return {
        office: null,
        distance: undefined,
        withinGeofence: undefined,
      };
    }

    const office = await this.dbReadRecord({
      Collection: OfficeLocationModel,
      readFilter: {
        _id: officeLocationId,
        organizationId,
        status: "active",
      },
      baseFilter: false,
    });

    if (
      !office ||
      office.latitude === undefined ||
      office.longitude === undefined
    ) {
      return {
        office,
        distance: undefined,
        withinGeofence: undefined,
      };
    }

    const distance = distanceMeters(
      latitude,
      longitude,
      office.latitude,
      office.longitude,
    );

    return {
      office,
      distance,
      withinGeofence: distance <= (office.geofenceRadiusMeters || 200),
    };
  };

  public checkInController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = req.auth!.employeeId!;
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        [constants.fields.OfficeLocation.latitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -90 },
          { rule: "maxValue", value: 90 },
        ],
        [constants.fields.OfficeLocation.longitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -180 },
          { rule: "maxValue", value: 180 },
        ],
        accuracyMeters: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0 },
        ],
        address: [{ rule: "datatype", datatype: "String" }],
        [constants.fields.Attendance.officeLocationId]: [
          { rule: "format", type: "id" },
        ],
        [constants.fields.Attendance.notes]: [
          { rule: "datatype", datatype: "String" },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const location = this.getLocationData(postData);

    const openAttendance = await this.dbReadRecord({
      readFilter: {
        organizationId,
        employeeId,
        status: { $in: ["open", "flagged"] },
        checkOutAt: { $exists: false },
      },
      baseFilter: false,
    });

    if (openAttendance) {
      return next(
        new ConflictException("You already have an open attendance session"),
      );
    }

    const employee = await this.dbReadRecord({
      Collection: EmployeeModel,
      readFilter: {
        _id: employeeId,
        organizationId,
        employmentStatus: "active",
      },
      baseFilter: false,
    });

    if (!employee) {
      return next(new ObjectNotFoundException("Active employee"));
    }

    const officeLocationId =
      postData.officeLocationId || employee.primaryOfficeLocationId;

    const officeData = await this.getOfficeDistance({
      organizationId,
      officeLocationId,
      latitude: location.latitude,
      longitude: location.longitude,
    });

    const obj = await this.dbInsertRecord({
      data: {
        organizationId,
        employeeId,
        officeLocationId: officeData.office?.id,
        workDate: new Date().toISOString().slice(0, 10),
        checkInAt: new Date(),
        checkInLocation: location,
        checkInDistanceMeters: officeData.distance,
        checkInWithinGeofence: officeData.withinGeofence,
        status: officeData.withinGeofence === false ? "flagged" : "open",
        notes: postData.notes,
      },
    });

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "attendance.checked_in",
      entityType: "Attendance",
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

  public checkOutController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = req.auth!.employeeId!;
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        [constants.fields.OfficeLocation.latitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -90 },
          { rule: "maxValue", value: 90 },
        ],
        [constants.fields.OfficeLocation.longitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -180 },
          { rule: "maxValue", value: 180 },
        ],
        accuracyMeters: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0 },
        ],
        address: [{ rule: "datatype", datatype: "String" }],
      },
    });

    if (!isValid) return next(errorMessages);

    const location = this.getLocationData(postData);

    const obj = await this.dbReadRecord({
      readFilter: {
        organizationId,
        employeeId,
        status: { $in: ["open", "flagged"] },
        checkOutAt: { $exists: false },
      },
      options: { sort: { checkInAt: -1 } },
      baseFilter: false,
    });

    if (!obj) {
      return next(
        new ConflictException("No open attendance session was found"),
      );
    }

    const officeData = await this.getOfficeDistance({
      organizationId,
      officeLocationId: obj.officeLocationId,
      latitude: location.latitude,
      longitude: location.longitude,
    });

    const updatedObj = await this.dbUpdateRecord({
      obj,
      filterObj: false,
      data: {
        checkOutAt: new Date(),
        checkOutLocation: location,
        checkOutDistanceMeters: officeData.distance,
        checkOutWithinGeofence: officeData.withinGeofence,
        status:
          obj.checkInWithinGeofence === false ||
          officeData.withinGeofence === false
            ? "flagged"
            : "completed",
      },
    });

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "attendance.checked_out",
      entityType: "Attendance",
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

  public viewController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);

    const readFilter: Record<string, any> = {
      organizationId: req.auth!.organizationId,
      employeeId: req.auth!.employeeId,
    };

    if (req.query.from || req.query.to) {
      readFilter.workDate = {
        ...(req.query.from && { $gte: req.query.from }),
        ...(req.query.to && { $lte: req.query.to }),
      };
    }

    const objs = await this.dbReadRecords({
      readFilter,
      page,
      limit,
      sort: { checkInAt: -1 },
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
}

const AttendanceController = new AttendanceControllerClass();
export default AttendanceController;
