import { Router } from "express";
import {
  authMiddleware,
  requireOrganization,
} from "../../AuthModule/utils/authMiddleware";
import { asyncWrapper } from "../../node-base/utils";
import * as controller from "../controllers/CompanyController";
const router = Router();
router.use(authMiddleware([], true));
router.get("/", asyncWrapper(controller.listCompanies));
router.post("/", asyncWrapper(controller.createCompany));
router.post("/platform", asyncWrapper(controller.platformHome));
router.post("/invitations/accept", asyncWrapper(controller.acceptInvitation));
router.get(
  "/members",
  requireOrganization,
  asyncWrapper(controller.companyMembers),
);
router.post(
  "/invitations",
  requireOrganization,
  asyncWrapper(controller.createInvitation),
);
router.post(
  "/transfer-ownership",
  requireOrganization,
  asyncWrapper(controller.transferOwnership),
);
router.post("/:id/switch", asyncWrapper(controller.switchCompany));
router.patch("/:id/status", asyncWrapper(controller.updateCompanyStatus));
export default router;
