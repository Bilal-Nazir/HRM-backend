import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import LeaveController from "../controllers/LeaveController";
import { requestDetails, addRequestComment } from "../controllers/RequestDetailsController";
const router = Router();
router.use(authMiddleware(), requireOrganization);
router.get(
  "/requests/manage",
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
  asyncWrapper(LeaveController.pendingController),
);
router.patch(
  "/requests/:id/review",
  asyncWrapper(LeaveController.reviewController),
);
router.patch(
  "/requests/:id/manager-comment",
  asyncWrapper(addRequestComment),
);
router.get("/requests/:id", asyncWrapper(requestDetails));
router.post("/requests/:id/comments", asyncWrapper(addRequestComment));
router.patch(
  "/requests/:id/cancel",
  authMiddleware(["leave.request"]),
  asyncWrapper(LeaveController.cancelController),
);
export default router;
