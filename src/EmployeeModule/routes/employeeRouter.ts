import { Router } from "express";
import { authMiddleware } from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import EmployeeController from "../controllers/EmployeeController";
export const employeeRouter = Router({ mergeParams: true });
employeeRouter.get(
  "/me",
  authMiddleware(["employee.read.self"]),
  asyncWrapper(EmployeeController.selfController),
);
employeeRouter.patch(
  "/me",
  authMiddleware(["employee.update.self"]),
  asyncWrapper(EmployeeController.selfUpdateController),
);
employeeRouter.post(
  "/create",
  authMiddleware(["employee.create"]),
  asyncWrapper(EmployeeController.createController),
);
employeeRouter.get(
  "/view",
  authMiddleware(["employee.read.all"]),
  asyncWrapper(EmployeeController.viewController),
);
employeeRouter.get(
  "/:id",
  authMiddleware(["employee.read.all"]),
  asyncWrapper(EmployeeController.readController),
);
employeeRouter.patch(
  "/:id",
  authMiddleware(),
  asyncWrapper(EmployeeController.updateController),
);
employeeRouter.delete(
  "/:id",
  authMiddleware(["employee.update.employment"]),
  asyncWrapper(EmployeeController.deleteController),
);
