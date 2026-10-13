import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import AnnouncementController from "../controllers/AnnouncementController";

const AnnouncementRouter = Router();
AnnouncementRouter.use(authMiddleware(), requireOrganization);
AnnouncementRouter.get(
  "/",
  asyncWrapper(AnnouncementController.viewController),
);
AnnouncementRouter.get(
  "/manage",
  authMiddleware(["organization.update"]),
  asyncWrapper(AnnouncementController.manageController),
);
AnnouncementRouter.post(
  "/",
  authMiddleware(["organization.update"]),
  asyncWrapper(AnnouncementController.createController),
);
AnnouncementRouter.patch(
  "/:id",
  authMiddleware(["organization.update"]),
  asyncWrapper(AnnouncementController.updateController),
);
AnnouncementRouter.delete(
  "/:id",
  authMiddleware(["organization.update"]),
  asyncWrapper(AnnouncementController.deleteController),
);
export default AnnouncementRouter;
