import { Router } from "express";
import { asyncWrapper } from "../../node-base/utils";
import AuthController from "../controllers/AuthController";
import { authMiddleware } from "../utils/authMiddleware";

const AuthRouter = Router();
AuthRouter.post("/login", asyncWrapper(AuthController.loginController));
AuthRouter.post("/refresh", asyncWrapper(AuthController.refreshController));
AuthRouter.post("/logout", asyncWrapper(AuthController.logoutController));
AuthRouter.post(
  "/change-password",
  authMiddleware(),
  asyncWrapper(AuthController.changePasswordController),
);
export default AuthRouter;
