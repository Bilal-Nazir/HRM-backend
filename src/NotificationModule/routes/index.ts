import { Router } from "express";
import { authMiddleware, requireOrganization } from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import * as controller from "../controllers/NotificationController";

const router = Router();
router.use(authMiddleware(), requireOrganization);
router.get("/", asyncWrapper(controller.listNotifications));
router.patch("/read-all", asyncWrapper(controller.markAllRead));
router.patch("/:id/read", asyncWrapper(controller.markRead));
export default router;
