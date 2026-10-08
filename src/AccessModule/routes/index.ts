import { Router } from "express";
import { authMiddleware } from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import AccessController from "../controllers/AccessController";
const router = Router();
router.get(
  "/permissions",
  authMiddleware(["role.read"]),
  asyncWrapper(AccessController.permissionViewController),
);
router.get(
  "/roles",
  authMiddleware(["role.read"]),
  asyncWrapper(AccessController.roleViewController),
);
router.post(
  "/roles",
  authMiddleware(["role.manage"]),
  asyncWrapper(AccessController.roleCreateController),
);
router.get(
  "/assignments/:employeeId",
  authMiddleware(["role.read"]),
  asyncWrapper(AccessController.assignmentViewController),
);
router.post(
  "/assignments",
  authMiddleware(["role.assign"]),
  asyncWrapper(AccessController.assignmentCreateController),
);
router.delete(
  "/assignments/:id",
  authMiddleware(["role.assign"]),
  asyncWrapper(AccessController.assignmentDeleteController),
);
export default router;
