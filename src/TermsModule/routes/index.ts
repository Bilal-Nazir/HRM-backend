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
TermsRouter.get("/files/:id", asyncWrapper(TermsController.downloadController));
TermsRouter.patch(
  "/",
  authMiddleware(["organization.update"]),
  asyncWrapper(TermsController.updateController),
);
TermsRouter.delete("/", authMiddleware(["organization.update"]), asyncWrapper(TermsController.deleteController));
export default TermsRouter;
