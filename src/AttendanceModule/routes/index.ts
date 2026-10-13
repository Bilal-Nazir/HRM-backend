import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import AttendanceController from "../controllers/AttendanceController";
const router = Router();
router.get(
  "/schedule",
  authMiddleware(["organization.read"]),
  asyncWrapper(AttendanceController.getScheduleController),
);
router.patch(
  "/schedule",
  authMiddleware(["organization.update"]),
  asyncWrapper(AttendanceController.updateScheduleController),
);
router.get(
  "/summary",
  authMiddleware(["attendance.read.self"]),
  asyncWrapper(AttendanceController.summaryController),
);
router.get(
  "/manage",
  authMiddleware(["attendance.read.team", "employee.read.all"]),
  requireOrganization,
  asyncWrapper(AttendanceController.manageController),
);
router.post(
  "/check-in",
  authMiddleware(["attendance.checkin"]),
  asyncWrapper(AttendanceController.checkInController),
);
router.post(
  "/check-out",
  authMiddleware(["attendance.checkin"]),
  asyncWrapper(AttendanceController.checkOutController),
);
router.get(
  "/history",
  authMiddleware(["attendance.read.self"]),
  asyncWrapper(AttendanceController.viewController),
);
export default router;
