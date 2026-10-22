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
import WorkScheduleModel from "../../OrganizationModule/models/WorkSchedule";
import OrganizationModel from "../../OrganizationModule/models/Organization";

const attendanceMetrics = (record: AttendanceClass, schedule?: { timezone: string; weeklyPattern: { day: number; startTime: string; endTime: string; working: boolean }[] }) => {
  const hours = record.checkOutAt ? Math.max(0, (new Date(record.checkOutAt).getTime() - new Date(record.checkInAt).getTime()) / 3600000) : 0;
  const flags: string[] = [];
  if (record.checkInWithinGeofence === false || record.checkOutWithinGeofence === false) flags.push("outside_office_area");
  if (schedule) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(record.checkInAt));
    const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
    const workDay = schedule.weeklyPattern.find((item) => item.day === day && item.working);
    if (workDay?.startTime && `${part("hour")}:${part("minute")}` > workDay.startTime) flags.push("late_check_in");
    if (workDay?.endTime && record.checkOutAt) {
      const outParts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(record.checkOutAt));
      const out = (type: string) => outParts.find((item) => item.type === type)?.value || "";
      if (`${out("hour")}:${out("minute")}` < workDay.endTime) flags.push("early_check_out");
    }
  }
  return { workedHours: Math.round(hours * 100) / 100, flags };
};

export class AttendanceControllerClass extends BaseControllerClass<AttendanceClass> {
  _Model = AttendanceModel;
  _modelName = constants.fields.Attendance.Attendance;
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  private scheduleLookup = async (organizationId: string, employeeIds: string[]) => {
    const [employees, fallback] = await Promise.all([
      EmployeeModel.find({ organizationId, _id: { $in: employeeIds } }).select("workScheduleId"),
      WorkScheduleModel.findOne({ organizationId, name: "Organization default", status: "active", isDeleted: { $ne: true } }),
    ]);
    const schedules = await WorkScheduleModel.find({ organizationId, _id: { $in: employees.map((employee) => employee.workScheduleId).filter(Boolean) }, status: "active", isDeleted: { $ne: true } });
    const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
    return new Map(employees.map((employee) => [employee.id, employee.workScheduleId ? byId.get(employee.workScheduleId) || fallback || undefined : fallback || undefined]));
  };

  public getScheduleController = async (req: AuthenticatedRequest, res: Response) => {
    const schedule = await WorkScheduleModel.findOne({ organizationId: req.auth!.organizationId, name: "Organization default", isDeleted: { $ne: true } });
    return sendResponseObject({ res, data: { schedule: schedule ? await schedule.display() : null } });
  };

  public updateScheduleController = async (req: AuthenticatedRequest, res: Response) => {
    const { startTime, endTime, workingDays } = req.body;
    const validTime = (value: unknown) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(startTime) || !validTime(endTime) || startTime >= endTime || !Array.isArray(workingDays) || !workingDays.length || workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new ValidationException("Choose valid working days and start/end times");
    const organizationId = req.auth!.organizationId!;
    const organization = await OrganizationModel.findById(organizationId);
    if (!organization) throw new ObjectNotFoundException("Organization");
    const schedule = await WorkScheduleModel.findOneAndUpdate({ organizationId, name: "Organization default" }, { $set: { timezone: organization.timezone, weeklyPattern: [...new Set(workingDays)].map((day) => ({ day, startTime, endTime, working: true })), expectedHours: (Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3)) - Number(startTime.slice(0, 2)) * 60 - Number(startTime.slice(3))) / 60, status: "active", isDeleted: false } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    return sendResponseObject({ res, data: { schedule: await schedule!.display() } });
  };

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
    const filterFlags = req.query.flags === "true";
    const readFilter = req.query.open === "true" && !filterFlags ? openFilter : scope;
    let [objs, totalCount, presentNow, activeEmployees, attendanceFlags] =
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
    if (filterFlags) {
      const all = await AttendanceModel.find(scope).sort({ checkInAt: -1 }).limit(5000);
      const lookup = await this.scheduleLookup(organizationId, [...new Set(all.map((record) => record.employeeId))]);
      const flagged = all.filter((record) => attendanceMetrics(record, lookup.get(record.employeeId)).flags.length > 0);
      totalCount = flagged.length;
      objs = flagged.slice((page - 1) * limit, page * limit);
    }
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
    const schedules = await this.scheduleLookup(organizationId, objs.map((obj) => obj.employeeId));
    return sendResponseObject({
      res,
      data: {
        attendances: await Promise.all(
          objs.map(async (obj) => ({
            ...(await obj.display({ detail: true })),
            ...attendanceMetrics(obj, schedules.get(obj.employeeId)),
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

  public summaryController = async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = req.auth!.organizationId!;
    const isAdmin = req.query.scope === "organization" && req.auth!.permissions.some((permission) => ["*", "attendance.read.team"].includes(permission));
    const requestedEmployeeId = typeof req.query.employeeId === "string" && /^[a-f\d]{24}$/i.test(req.query.employeeId) ? req.query.employeeId : undefined;
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : `${new Date().getUTCFullYear()}-01-01`;
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
    const records = await AttendanceModel.find({ organizationId, ...(!isAdmin ? { employeeId: req.auth!.employeeId } : requestedEmployeeId ? { employeeId: requestedEmployeeId } : {}), isDeleted: { $ne: true }, workDate: { $gte: from, $lte: to } }).sort({ workDate: -1 }).limit(5000);
    const employeeSchedule = await this.scheduleLookup(organizationId, [...new Set(records.map((record) => record.employeeId))]);
    const buckets = { atLeastEightHours: 0, fiveToUnderEightHours: 0, underFiveHours: 0 };
    const flagCounts = { lateCheckIns: 0, earlyCheckOuts: 0, outsideOfficeArea: 0 };
    let totalWorkedHours = 0;
    const daily = records.map((record) => {
      const metrics = attendanceMetrics(record, employeeSchedule.get(record.employeeId));
      if (record.checkOutAt) {
        totalWorkedHours += metrics.workedHours;
        if (metrics.workedHours >= 8) buckets.atLeastEightHours++;
        else if (metrics.workedHours >= 5) buckets.fiveToUnderEightHours++;
        else buckets.underFiveHours++;
      }
      if (metrics.flags.includes("late_check_in")) flagCounts.lateCheckIns++;
      if (metrics.flags.includes("early_check_out")) flagCounts.earlyCheckOuts++;
      if (metrics.flags.includes("outside_office_area")) flagCounts.outsideOfficeArea++;
      return { id: record.id, employeeId: record.employeeId, workDate: record.workDate, checkInAt: record.checkInAt, checkOutAt: record.checkOutAt, ...metrics };
    });
    return sendResponseObject({ res, data: { totalWorkingDays: new Set(records.map((record) => `${record.employeeId}:${record.workDate}`)).size, totalWorkedHours: Math.round(totalWorkedHours * 100) / 100, buckets, flags: flagCounts, daily: daily.slice(0, 2000) } });
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

    const schedules = await this.scheduleLookup(req.auth!.organizationId!, [req.auth!.employeeId!]);
    const schedule = schedules.get(req.auth!.employeeId!);

    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          objs.map(async (obj) => ({ ...(await obj.display({ detail: true })), ...attendanceMetrics(obj, schedule || undefined) })),
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
