import { Router } from "express";
import { authMiddleware } from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import AuditController from "../controllers/AuditController";
const router = Router();
router.get(
  "/",
  authMiddleware(["audit.read"]),
  asyncWrapper(AuditController.viewController),
);
export default router;
