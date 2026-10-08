import { NextFunction, Response } from "express";
import {
  ForbiddenException,
  UnauthenticatedException,
} from "../../node-base/utils";
import UserModel from "../models/User";
import { verifyStoredToken } from "./session";
import { AuthenticatedRequest } from "./types";

export const authMiddleware =
  (requiredPermissions: string[] = []) =>
  async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      const accessToken = header?.startsWith("Bearer ")
        ? header.slice(7)
        : req.get("accessToken");
      if (!accessToken) throw new UnauthenticatedException();
      const payload = await verifyStoredToken(accessToken, "access");
      if (!payload) throw new UnauthenticatedException();
      const user = await UserModel.findOne({
        _id: payload.userId,
        isActive: true,
        isDeleted: { $ne: true },
      });
      if (
        !user ||
        (user.credentialVersion || 0) !== (payload.credentialVersion || 0)
      )
        throw new UnauthenticatedException(
          "Account is inactive or unavailable",
        );
      if (
        !payload.permissions.includes("*") &&
        requiredPermissions.some(
          (permission) => !payload.permissions.includes(permission),
        )
      ) {
        throw new ForbiddenException();
      }
      req.auth = payload;
      next();
    } catch (error) {
      if (
        error instanceof UnauthenticatedException ||
        error instanceof ForbiddenException
      )
        return next(error);
      return next(
        new UnauthenticatedException("Invalid or expired access token"),
      );
    }
  };

export const requireOrganization = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
) => {
  if (!req.auth?.organizationId)
    return next(new ForbiddenException("An organization is required"));
  next();
};
