import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import LeaveController from "../controllers/LeaveController";
const router = Router();
router.use(authMiddleware(), requireOrganization);
router.get(
  "/requests/manage",
  authMiddleware(["leave.manage"]),
  asyncWrapper(LeaveController.manageController),
);
router.get(
  "/types",
  authMiddleware(["leave.read.self"]),
  asyncWrapper(LeaveController.viewLeaveTypesController),
);
router.get(
  "/balances",
  authMiddleware(["leave.read.self"]),
  asyncWrapper(LeaveController.balancesController),
);
router.post(
  "/types",
  authMiddleware(["leave.manage"]),
  asyncWrapper(LeaveController.createLeaveTypeController),
);
router.patch(
  "/types/:id",
  authMiddleware(["leave.manage"]),
  asyncWrapper(LeaveController.updateLeaveTypeController),
);
router.post(
  "/requests",
  authMiddleware(["leave.request"]),
  asyncWrapper(LeaveController.createController),
);
router.get(
  "/requests/history",
  authMiddleware(["leave.read.self"]),
  asyncWrapper(LeaveController.viewController),
);
router.get(
  "/requests/pending",
  authMiddleware(["leave.approve"]),
  asyncWrapper(LeaveController.pendingController),
);
router.patch(
  "/requests/:id/review",
  authMiddleware(["leave.approve"]),
  asyncWrapper(LeaveController.reviewController),
);
router.patch(
  "/requests/:id/cancel",
  authMiddleware(["leave.request"]),
  asyncWrapper(LeaveController.cancelController),
);
export default router;
