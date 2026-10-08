import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import TermsController from "../controllers/TermsController";

const TermsRouter = Router();
TermsRouter.use(authMiddleware(), requireOrganization);
TermsRouter.get("/", asyncWrapper(TermsController.readController));
TermsRouter.patch(
  "/",
  authMiddleware(["organization.update"]),
  asyncWrapper(TermsController.updateController),
);
export default TermsRouter;
