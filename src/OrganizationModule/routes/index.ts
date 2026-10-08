import { Router } from "express";
import { authMiddleware } from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import OrganizationController, {
  DepartmentController,
  OfficeController,
  TeamController,
} from "../controllers/OrganizationController";
const router = Router();
router.post(
  "/bootstrap",
  asyncWrapper(OrganizationController.bootstrapController),
);
router.get(
  "/",
  authMiddleware(["organization.read"]),
  asyncWrapper(OrganizationController.readController),
);
router.patch(
  "/",
  authMiddleware(["organization.update"]),
  asyncWrapper(OrganizationController.updateController),
);
for (const [path, controller, readPermission, managePermission] of [
  ["offices", OfficeController, "office.read", "office.manage"],
  ["departments", DepartmentController, "department.read", "department.manage"],
  ["teams", TeamController, "department.read", "department.manage"],
] as const) {
  router.get(
    `/${path}`,
    authMiddleware([readPermission]),
    asyncWrapper(controller.list),
  );
  router.post(
    `/${path}`,
    authMiddleware([managePermission]),
    asyncWrapper(controller.create),
  );
  router.patch(
    `/${path}/:id`,
    authMiddleware([managePermission]),
    asyncWrapper(controller.update),
  );
  router.post(
    `/${path}/:id/archive`,
    authMiddleware([managePermission]),
    asyncWrapper(controller.archive),
  );
}
export default router;
