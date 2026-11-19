import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { sendResponseObject } from "../../node-base/utils";
import NotificationModel from "../models/Notification";

const serialize = (row: any) => ({ id: String(row._id), type: row.type, title: row.title, message: row.message, href: row.href, projectId: row.projectId, taskId: row.taskId, readAt: row.readAt, createdAt: row.createdAt });

const recipientFilter = (req: AuthenticatedRequest) => ({
  organizationId: req.auth!.organizationId,
  recipientUserId: req.auth!.userId,
  isDeleted: { $ne: true },
  // Apply the current rule to old alerts too, including their unread badges.
  ...(!req.auth!.isCompanyOwner && {
    type: { $nin: ["leave.requested", "work_from_home.requested"] },
  }),
});

export const listNotifications = async (req: AuthenticatedRequest, res: Response) => {
  const size = Math.min(50, Math.max(1, Number(req.query.size) || 12));
  const filter = recipientFilter(req);
  const [rows, unreadCount] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1 }).limit(size).lean(),
    NotificationModel.countDocuments({ ...filter, readAt: { $exists: false } }),
  ]);
  return sendResponseObject({ res, data: { notifications: rows.map(serialize), unreadCount } });
};

export const markRead = async (req: AuthenticatedRequest, res: Response) => {
  await NotificationModel.updateOne({ ...recipientFilter(req), _id: req.params.id }, { $set: { readAt: new Date() } });
  return sendResponseObject({ res, data: { success: true } });
};

export const markAllRead = async (req: AuthenticatedRequest, res: Response) => {
  await NotificationModel.updateMany({ ...recipientFilter(req), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  return sendResponseObject({ res, data: { success: true } });
};
