import { authRateLimit } from "../utils/authRateLimit";
import { Router } from "express";
import { asyncWrapper } from "../../node-base/utils";
import AuthController from "../controllers/AuthController";
import { authMiddleware } from "../utils/authMiddleware";

const AuthRouter = Router();
AuthRouter.get(
  "/session",
  authMiddleware([], true),
  asyncWrapper(AuthController.sessionController),
);
AuthRouter.get(
  "/google/config",
  asyncWrapper(AuthController.googleConfigurationController),
);
AuthRouter.get(
  "/google/challenge",
  authRateLimit,
  asyncWrapper(AuthController.googleChallengeController),
);
AuthRouter.post(
  "/google",
  authRateLimit,
  asyncWrapper(AuthController.googleLoginController),
);
AuthRouter.patch(
  "/profile",
  authMiddleware([], true),
  asyncWrapper(AuthController.updateProfileController),
);
AuthRouter.post(
  "/login",
  authRateLimit,
  asyncWrapper(AuthController.loginController),
);
AuthRouter.post("/refresh", asyncWrapper(AuthController.refreshController));
AuthRouter.post("/logout", asyncWrapper(AuthController.logoutController));
AuthRouter.post(
  "/change-password",
  authMiddleware(),
  asyncWrapper(AuthController.changePasswordController),
);
export default AuthRouter;
