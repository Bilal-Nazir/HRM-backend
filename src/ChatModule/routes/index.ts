import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import * as controller from "../controllers/ChatController";
const router = Router();
router.use(authMiddleware(), requireOrganization);
router.get("/directory", asyncWrapper(controller.directory));
router.get("/inbox", asyncWrapper(controller.inbox));
router.post("/direct", asyncWrapper(controller.startDirect));
router.post("/projects/:projectId", asyncWrapper(controller.startProject));
router.get("/conversations/:id", asyncWrapper(controller.conversationDetails));
router.get("/conversations/:id/messages", asyncWrapper(controller.messages));
router.post(
  "/conversations/:id/messages",
  asyncWrapper(controller.sendMessage),
);
router.patch("/conversations/:id/read", asyncWrapper(controller.markRead));
router.patch(
  "/conversations/:id/read-all",
  asyncWrapper(controller.markConversationRead),
);
export default router;
