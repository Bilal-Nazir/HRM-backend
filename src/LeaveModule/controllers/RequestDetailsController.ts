import { Response } from "express";
import { isValidObjectId } from "mongoose";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import User from "../../AuthModule/models/User";
import Employee from "../../EmployeeModule/models/Employee";
import Organization from "../../OrganizationModule/models/Organization";
import LeaveRequest from "../models/LeaveRequest";
import LeaveType from "../models/LeaveType";
import Comment from "../models/LeaveRequestComment";
import {
  isRequestAdmin,
  managedRequestEmployeeIds,
  requestReviewerEmployeeIds,
} from "../services/requestAccess";
import {
  ObjectNotFoundException,
  ValidationException,
  ForbiddenException,
  sendResponseObject,
} from "../../node-base/utils";
import {
  createNotifications,
  userRecipientsForEmployees,
} from "../../NotificationModule/services/notificationService";

async function access(req: AuthenticatedRequest) {
  const id = String(req.params.id);
  if (!isValidObjectId(id)) throw new ValidationException("Invalid request ID");
  const request = await LeaveRequest.findOne({
    _id: id,
    organizationId: req.auth!.organizationId,
    isDeleted: { $ne: true },
  });
  if (!request) throw new ObjectNotFoundException("Request");
  const admin = isRequestAdmin(req.auth!);
  const own = request.employeeId === req.auth!.employeeId;
  const manager =
    !admin &&
    !own &&
    (await managedRequestEmployeeIds(req.auth!)).includes(request.employeeId);
  if (!admin && !own && !manager) throw new ObjectNotFoundException("Request");
  return { request, admin, own, manager };
}

async function person(
  organizationId: string,
  employeeId?: string,
  userId?: string,
) {
  const employee = employeeId
    ? await Employee.findOne({ _id: employeeId, organizationId }).select(
        "firstName lastName employeeCode jobTitle userId",
      )
    : null;
  if (employee)
    return {
      name: `${employee.firstName} ${employee.lastName}`.trim(),
      employeeCode: employee.employeeCode,
      jobTitle: employee.jobTitle,
    };
  const user = userId
    ? await User.findById(userId).select("name loginId")
    : null;
  return {
    name:
      user?.name ||
      (user?.loginId && !user.loginId.includes("@")
        ? user.loginId
        : employeeId
          ? "Former employee"
          : "Company admin"),
  };
}

export async function requestDetails(req: AuthenticatedRequest, res: Response) {
  const { request, admin, own, manager } = await access(req);
  const organizationId = req.auth!.organizationId!;
  const [employee, type, rows, reviewerIds, finalReviewer] = await Promise.all([
    person(organizationId, request.employeeId),
    request.leaveTypeId
      ? LeaveType.findOne({ _id: request.leaveTypeId, organizationId }).select(
          "name",
        )
      : null,
    Comment.find({
      organizationId,
      requestId: request.id,
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(500)
      .lean(),
    requestReviewerEmployeeIds(organizationId, request.employeeId),
    request.reviewedAt
      ? person(
          organizationId,
          request.reviewedByEmployeeId,
          request.reviewedByUserId,
        )
      : null,
  ]);
  const reviewers = await Employee.find({
    _id: { $in: reviewerIds },
    organizationId,
    employmentStatus: "active",
    isDeleted: { $ne: true },
  }).select("firstName lastName employeeCode jobTitle");
  const comments: any[] = rows.map((row: any) => ({
    id: String(row._id),
    body: row.body,
    authorName: row.authorName,
    authorRole: row.authorRole,
    createdAt: row.createdAt,
  }));
  if (
    request.managerComment &&
    !rows.some(
      (row) =>
        row.body === request.managerComment &&
        String(row.authorEmployeeId) === request.managerCommentedByEmployeeId,
    )
  ) {
    const author = await person(
      organizationId,
      request.managerCommentedByEmployeeId,
    );
    comments.push({
      id: "legacy-manager-remark",
      body: request.managerComment,
      authorName: author.name,
      authorRole: "manager",
      createdAt: request.managerCommentedAt || request.createdAt,
    });
  }
  comments.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const history = [
    {
      id: "created",
      action: "submitted",
      authorName: employee.name,
      createdAt: request.createdAt,
    },
    ...(request.reviewedAt
      ? [
          {
            id: "reviewed",
            action: request.status,
            authorName: finalReviewer?.name || "Administrator",
            body: request.reviewComment,
            createdAt: request.reviewedAt,
          },
        ]
      : []),
    ...(request.status === "cancelled"
      ? [
          {
            id: "cancelled",
            action: "cancelled",
            authorName: employee.name,
            createdAt: request.cancelledAt || request.updatedAt,
          },
        ]
      : []),
  ];
  return sendResponseObject({
    res,
    data: {
      request: {
        ...(await request.display({ detail: true })),
        employee,
        leaveTypeName:
          request.requestKind === "work_from_home"
            ? "Work from Home"
            : type?.name || "Leave",
        reviewedBy: finalReviewer,
      },
      reviewers: reviewers.map((reviewer) => ({
        id: reviewer.id,
        name: `${reviewer.firstName} ${reviewer.lastName}`.trim(),
        employeeCode: reviewer.employeeCode,
        jobTitle: reviewer.jobTitle,
      })),
      comments,
      history,
      permissions: {
        canComment: admin || own || manager,
        canReview: admin && request.status === "pending",
        canCancel: own && request.status === "pending",
        role: admin ? "admin" : manager ? "manager" : "employee",
      },
    },
  });
}

export async function addRequestComment(
  req: AuthenticatedRequest,
  res: Response,
) {
  const { request, admin, own, manager } = await access(req);
  if (!admin && !own && !manager) throw new ForbiddenException();
  const body =
    typeof (req.body.body ?? req.body.comment) === "string"
      ? (req.body.body ?? req.body.comment).trim()
      : "";
  if (!body || body.length > 4000)
    throw new ValidationException(
      "Write a comment between 1 and 4000 characters",
    );
  const author = await person(
    req.auth!.organizationId!,
    req.auth!.employeeId,
    req.auth!.userId,
  );
  const comment = await Comment.create({
    organizationId: req.auth!.organizationId,
    requestId: request.id,
    authorUserId: req.auth!.userId,
    authorEmployeeId: req.auth!.employeeId,
    authorName: author.name,
    authorRole: admin ? "admin" : manager ? "manager" : "employee",
    body,
  });
  const reviewerIds = await requestReviewerEmployeeIds(
    req.auth!.organizationId!,
    request.employeeId,
  );
  const employees = await userRecipientsForEmployees(
    req.auth!.organizationId!,
    [request.employeeId, ...reviewerIds],
  );
  const company = await Organization.findById(req.auth!.organizationId).select(
    "ownerUserId",
  );
  await createNotifications({
    organizationId: req.auth!.organizationId!,
    recipientUserIds: [
      ...employees.keys(),
      ...(company?.ownerUserId ? [company.ownerUserId] : []),
    ],
    recipientEmployees: employees,
    actorUserId: req.auth!.userId,
    actorEmployeeId: req.auth!.employeeId,
    type: "leave.comment",
    title: "New request comment",
    message: `${author.name}: ${body.slice(0, 200)}`,
    href: `/leave/${request.id}`,
  });
  return sendResponseObject({
    res,
    code: 201,
    data: {
      comment: {
        id: comment.id,
        body,
        authorName: comment.authorName,
        authorRole: comment.authorRole,
        createdAt: comment.createdAt,
      },
    },
  });
}
