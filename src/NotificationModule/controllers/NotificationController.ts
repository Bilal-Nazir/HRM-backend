import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { sendResponseObject } from "../../node-base/utils";
import NotificationModel from "../models/Notification";

const serialize = (row: any) => ({ id: String(row._id), type: row.type, title: row.title, message: row.message, href: row.href, projectId: row.projectId, taskId: row.taskId, readAt: row.readAt, createdAt: row.createdAt });

export const listNotifications = async (req: AuthenticatedRequest, res: Response) => {
  const size = Math.min(50, Math.max(1, Number(req.query.size) || 12));
  const filter = { organizationId: req.auth!.organizationId, recipientUserId: req.auth!.userId, isDeleted: { $ne: true } };
  const [rows, unreadCount] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1 }).limit(size).lean(),
    NotificationModel.countDocuments({ ...filter, readAt: { $exists: false } }),
  ]);
  return sendResponseObject({ res, data: { notifications: rows.map(serialize), unreadCount } });
};

export const markRead = async (req: AuthenticatedRequest, res: Response) => {
  await NotificationModel.updateOne({ _id: req.params.id, organizationId: req.auth!.organizationId, recipientUserId: req.auth!.userId, isDeleted: { $ne: true } }, { $set: { readAt: new Date() } });
  return sendResponseObject({ res, data: { success: true } });
};

export const markAllRead = async (req: AuthenticatedRequest, res: Response) => {
  await NotificationModel.updateMany({ organizationId: req.auth!.organizationId, recipientUserId: req.auth!.userId, readAt: { $exists: false }, isDeleted: { $ne: true } }, { $set: { readAt: new Date() } });
  return sendResponseObject({ res, data: { success: true } });
};
