import { Router } from "express";
import { employeeRouter } from "./employeeRouter";

const EmployeeRouter = Router();
EmployeeRouter.use("", employeeRouter);

export default EmployeeRouter;
