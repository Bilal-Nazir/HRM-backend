import type { Response } from "express";
import { isValidObjectId } from "mongoose";
import type { AuthenticatedRequest } from "../../AuthModule/utils/types";
import AttendanceModel from "../models/Attendance";
import LocationReviewModel from "../models/LocationReviewRequest";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import OfficeModel from "../../OrganizationModule/models/OfficeLocation";
import {
  ConflictException,
  ForbiddenException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import { writeAudit } from "../../AuditModule/utils/audit";
import { attendanceDeviceInfo } from "../utils/deviceInfo";
import { distanceMeters } from "../utils/geofence";
import { pauseEmployeeTimersAtCheckout } from "../../ProjectModule/services/checkoutTimerService";
import {
  createNotifications,
  organizationAdminUserIds,
} from "../../NotificationModule/services/notificationService";

const isAdmin = (req: AuthenticatedRequest) =>
  req.auth!.permissions.some(
    (permission) => permission === "*" || permission === "organization.update",
  );
const requireAdmin = (req: AuthenticatedRequest) => {
  if (!isAdmin(req))
    throw new ForbiddenException(
      "Only an administrator can confirm attendance locations",
    );
};
const id = (value: unknown) => {
  if (typeof value !== "string" || !isValidObjectId(value))
    throw new ValidationException("Invalid attendance request ID");
  return value;
};
const reason = (value: unknown) => {
  if (
    typeof value !== "string" ||
    value.trim().length < 5 ||
    value.trim().length > 1000
  )
    throw new ValidationException(
      "Enter a reason between 5 and 1000 characters",
    );
  return value.trim();
};
export function manualCoordinates(data: Record<string, unknown> | undefined) {
  if (!data || typeof data !== "object")
    throw new ValidationException("A valid location pin is required");
  const { latitude, longitude } = data;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new ValidationException("A valid location pin is required");
  return { latitude, longitude };
}
const serialize = (doc: any) => {
  const value = doc.toObject ? doc.toObject() : doc;
  const { _id, __v, device, ...rest } = value;
  return { ...rest, id: String(_id) };
};
const scope = (req: AuthenticatedRequest) => ({
  organizationId: req.auth!.organizationId!,
  isDeleted: { $ne: true },
});
const notice = (
  req: AuthenticatedRequest,
  users: string[],
  title: string,
  message: string,
  _admin = false,
) =>
  createNotifications({
    organizationId: req.auth!.organizationId!,
    actorUserId: req.auth!.userId,
    actorEmployeeId: req.auth!.employeeId,
    recipientUserIds: users,
    type: "attendance.location_review",
    title,
    message,
    href: "/attendance#location-review",
  });
const fence = async (
  organizationId: string,
  officeId: string | undefined,
  point: { latitude: number; longitude: number },
) => {
  const office = officeId
    ? await OfficeModel.findOne({
        _id: officeId,
        organizationId,
        status: "active",
        isDeleted: { $ne: true },
      })
    : null;
  if (
    !office ||
    office.latitude === undefined ||
    office.longitude === undefined
  )
    return { distance: undefined, within: undefined };
  const distance = distanceMeters(
    point.latitude,
    point.longitude,
    office.latitude,
    office.longitude,
  );
  return { distance, within: distance <= (office.geofenceRadiusMeters || 200) };
};

export const listLocationRequests = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  const admin = req.query.scope === "organization";
  if (admin) requireAdmin(req);
  else if (!req.auth!.employeeId)
    throw new ForbiddenException("An employee account is required");
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const filter = {
    ...scope(req),
    ...(!admin ? { employeeId: req.auth!.employeeId } : {}),
    ...(req.query.status === "pending" ? { active: true } : {}),
  };
  const [rows, count] = await Promise.all([
    LocationReviewModel.find(filter)
      .sort({ requestedAt: -1 })
      .skip((page - 1) * 20)
      .limit(20)
      .lean(),
    LocationReviewModel.countDocuments(filter),
  ]);
  const employees = admin
    ? await EmployeeModel.find({
        organizationId: req.auth!.organizationId,
        _id: { $in: rows.map((row) => row.employeeId) },
      })
        .select("firstName lastName employeeCode")
        .lean()
    : [];
  const names = new Map(
    employees.map((employee) => [
      String(employee._id),
      `${employee.firstName} ${employee.lastName} · ${employee.employeeCode}`,
    ]),
  );
  return sendResponseObject({
    res,
    data: {
      requests: rows.map((row) => ({
        ...serialize(row),
        employeeName: names.get(row.employeeId),
      })),
      totalCount: count,
      page,
      lastPage: Math.ceil(count / 20),
    },
  });
};

export const createLocationRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  if (!req.auth!.employeeId)
    throw new ForbiddenException("An employee account is required");
  const employee = await EmployeeModel.findOne({
    _id: req.auth!.employeeId,
    ...scope(req),
    employmentStatus: "active",
  });
  if (!employee) throw new ObjectNotFoundException("Active employee");
  const point = manualCoordinates(req.body),
    note = reason(req.body.reason);
  if (!["check_in", "check_out"].includes(req.body.action))
    throw new ValidationException("Choose check-in or check-out");
  const open = await AttendanceModel.findOne({
    ...scope(req),
    employeeId: employee.id,
    checkOutAt: { $exists: false },
  }).sort({ checkInAt: -1 });
  if (req.body.action === "check_in" && open)
    throw new ConflictException("You already have an open attendance session");
  if (req.body.action === "check_out" && !open)
    throw new ConflictException("No open attendance session was found");
  let request;
  try {
    request = await LocationReviewModel.create({
      organizationId: req.auth!.organizationId,
      employeeId: employee.id,
      requestedByUserId: req.auth!.userId,
      action: req.body.action,
      attendanceId: open?.id,
      ...point,
      reason: note,
      requestedAt: new Date(),
      device: attendanceDeviceInfo(req),
    });
  } catch (error: any) {
    if (error?.code === 11000)
      throw new ConflictException(
        "You already have a location request awaiting admin review",
      );
    throw error;
  }
  await writeAudit({
    organizationId: req.auth!.organizationId!,
    actorUserId: req.auth!.userId,
    action: "attendance.location_requested",
    entityType: "LocationReviewRequest",
    entityId: request.id,
    after: serialize(request),
  });
  await notice(
    req,
    await organizationAdminUserIds(req.auth!.organizationId!),
    "Attendance location needs review",
    `${employee.firstName} ${employee.lastName} sent a location pin for ${request.action.replace("_", " ")}.`,
    true,
  );
  return sendResponseObject({
    res,
    code: 201,
    data: { request: serialize(request) },
  });
};

export const cancelLocationRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  const request = await LocationReviewModel.findOneAndUpdate(
    {
      _id: id(req.params.requestId),
      ...scope(req),
      employeeId: req.auth!.employeeId,
      status: "pending",
    },
    { $set: { status: "cancelled", active: false } },
    { new: true },
  );
  if (!request)
    throw new ConflictException("This request is no longer pending");
  await writeAudit({
    organizationId: req.auth!.organizationId!,
    actorUserId: req.auth!.userId,
    action: "attendance.location_request_cancelled",
    entityType: "LocationReviewRequest",
    entityId: request.id,
  });
  return sendResponseObject({ res, data: { request: serialize(request) } });
};

export const reviewLocationRequest = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  requireAdmin(req);
  const requestId = id(req.params.requestId),
    reviewComment = reason(req.body.reviewComment);
  if (!["approve", "reject"].includes(req.body.decision))
    throw new ValidationException("Choose approve or reject");
  const point =
    req.body.decision === "approve" ? manualCoordinates(req.body) : null;
  let request = await LocationReviewModel.findOne({
    _id: requestId,
    ...scope(req),
  });
  if (!request) throw new ObjectNotFoundException("Location request");
  // Recover an approval interrupted after attendance was saved, without duplicating it.
  const existing = await AttendanceModel.findOne({
    ...scope(req),
    $or: [
      { locationRequestId: requestId },
      { "checkInLocation.reviewRequestId": requestId },
      { "checkOutLocation.reviewRequestId": requestId },
    ],
  });
  if (existing && ["approved", "processing"].includes(request.status)) {
    const savedPin =
      request.action === "check_in"
        ? existing.checkInLocation
        : existing.checkOutLocation;
    await LocationReviewModel.updateOne(
      { _id: requestId, ...scope(req) },
      {
        $set: {
          status: "approved",
          active: false,
          resultAttendanceId: existing.id,
          reviewedByUserId: savedPin?.enteredByUserId,
          reviewedAt: savedPin?.capturedAt,
          reviewComment: savedPin?.reason,
          approvedLatitude: savedPin?.latitude,
          approvedLongitude: savedPin?.longitude,
        },
      },
    );
    return sendResponseObject({
      res,
      data: {
        attendance: await existing.display({ detail: true }),
        alreadyRecorded: true,
      },
    });
  }
  request = await LocationReviewModel.findOneAndUpdate(
    {
      _id: requestId,
      ...scope(req),
      $or: [
        { status: "pending" },
        {
          status: "processing",
          updatedAt: { $lt: new Date(Date.now() - 300000) },
        },
      ],
    },
    { $set: { status: "processing" } },
    { new: true },
  );
  if (!request)
    throw new ConflictException(
      "This request was already reviewed or is being processed",
    );
  let recorded = false;
  try {
    const at = new Date();
    if (!point) {
      Object.assign(request, {
        status: "rejected",
        active: false,
        reviewedByUserId: req.auth!.userId,
        reviewedAt: at,
        reviewComment,
      });
      await request.save();
      await writeAudit({
        organizationId: req.auth!.organizationId!,
        actorUserId: req.auth!.userId,
        action: "attendance.location_request_rejected",
        entityType: "LocationReviewRequest",
        entityId: request.id,
        after: serialize(request),
      });
      await notice(
        req,
        [request.requestedByUserId],
        "Attendance location request rejected",
        reviewComment,
      );
      return sendResponseObject({ res, data: { request: serialize(request) } });
    }
    const employee = await EmployeeModel.findOne({
      _id: request.employeeId,
      ...scope(req),
      employmentStatus: "active",
    });
    if (!employee) throw new ObjectNotFoundException("Active employee");
    const open = await AttendanceModel.findOne({
      ...scope(req),
      employeeId: request.employeeId,
      checkOutAt: { $exists: false },
    }).sort({ checkInAt: -1 });
    if (request.action === "check_in" && open)
      throw new ConflictException(
        "Employee has already checked in. Cancel this request.",
      );
    if (
      request.action === "check_out" &&
      (!open || open.id !== request.attendanceId)
    )
      throw new ConflictException(
        "The original session has already changed. Submit a new request.",
      );
    const manualPoint = {
      ...point,
      source: "admin",
      capturedAt: at,
      enteredByUserId: req.auth!.userId,
      reason: reviewComment,
      reviewRequestId: requestId,
    };
    const officeId = open?.officeLocationId || employee.primaryOfficeLocationId;
    const area = await fence(req.auth!.organizationId!, officeId, point);
    let attendance;
    if (request.action === "check_in") {
      attendance = await AttendanceModel.create({
        organizationId: req.auth!.organizationId,
        employeeId: request.employeeId,
        locationRequestId: requestId,
        officeLocationId: officeId,
        workDate: at.toISOString().slice(0, 10),
        checkInAt: at,
        checkInLocation: manualPoint,
        checkInDevice: request.device,
        checkInDistanceMeters: area.distance,
        checkInWithinGeofence: area.within,
        status: area.within === false ? "flagged" : "open",
      });
    } else {
      await pauseEmployeeTimersAtCheckout({
        organizationId: req.auth!.organizationId!,
        employeeId: request.employeeId,
        userId: req.auth!.userId,
        at,
      });
      Object.assign(open!, {
        locationRequestId: requestId,
        checkOutAt: at,
        checkOutLocation: manualPoint,
        checkOutLocationFailure: undefined,
        checkOutDevice: request.device,
        checkOutDistanceMeters: area.distance,
        checkOutWithinGeofence: area.within,
        status:
          !open!.checkInLocation ||
          open!.checkInWithinGeofence === false ||
          area.within === false
            ? "flagged"
            : "completed",
      });
      attendance = await open!.save();
    }
    recorded = true;
    Object.assign(request, {
      status: "approved",
      active: false,
      reviewedByUserId: req.auth!.userId,
      reviewedAt: at,
      reviewComment,
      approvedLatitude: point.latitude,
      approvedLongitude: point.longitude,
      resultAttendanceId: attendance.id,
    });
    await request.save();
    await writeAudit({
      organizationId: req.auth!.organizationId!,
      actorUserId: req.auth!.userId,
      action: "attendance.location_request_approved",
      entityType: "Attendance",
      entityId: attendance.id,
      after: attendance.toObject(),
      metadata: { requestId },
    });
    await notice(
      req,
      [request.requestedByUserId],
      "Attendance location confirmed",
      `Your ${request.action.replace("_", " ")} was recorded with an admin-confirmed location.`,
    );
    return sendResponseObject({
      res,
      data: {
        request: serialize(request),
        attendance: await attendance.display({ detail: true }),
      },
    });
  } catch (error) {
    if (!recorded)
      await LocationReviewModel.updateOne(
        { _id: requestId, ...scope(req), status: "processing" },
        { $set: { status: "pending" } },
      );
    throw error;
  }
};

export const correctAttendanceLocation = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  requireAdmin(req);
  const stage = req.body.stage;
  if (!["check_in", "check_out"].includes(stage))
    throw new ValidationException("Choose a check-in or check-out location");
  const point = manualCoordinates(req.body),
    note = reason(req.body.reason);
  const attendance = await AttendanceModel.findOne({
    _id: id(req.params.attendanceId),
    ...scope(req),
  });
  if (!attendance) throw new ObjectNotFoundException("Attendance");
  if (stage === "check_out" && !attendance.checkOutAt)
    throw new ValidationException("This session has not checked out yet");
  const before = attendance.toObject(),
    area = await fence(
      req.auth!.organizationId!,
      attendance.officeLocationId,
      point,
    );
  const prefix = stage === "check_in" ? "checkIn" : "checkOut";
  attendance.set({
    [`${prefix}Location`]: {
      ...point,
      source: "admin",
      capturedAt: new Date(),
      enteredByUserId: req.auth!.userId,
      reason: note,
    },
    [`${prefix}LocationFailure`]: undefined,
    [`${prefix}DistanceMeters`]: area.distance,
    [`${prefix}WithinGeofence`]: area.within,
  });
  attendance.status =
    !attendance.checkInLocation ||
    (attendance.checkOutAt && !attendance.checkOutLocation) ||
    attendance.checkInWithinGeofence === false ||
    attendance.checkOutWithinGeofence === false
      ? "flagged"
      : attendance.checkOutAt
        ? "completed"
        : "open";
  await attendance.save();
  await writeAudit({
    organizationId: req.auth!.organizationId!,
    actorUserId: req.auth!.userId,
    action: "attendance.location_corrected",
    entityType: "Attendance",
    entityId: attendance.id,
    before,
    after: attendance.toObject(),
    metadata: { reason: note, stage },
  });
  return sendResponseObject({
    res,
    data: {
      attendance: await attendance.display({
        detail: true,
        includeDevice: true,
      }),
    },
  });
};
