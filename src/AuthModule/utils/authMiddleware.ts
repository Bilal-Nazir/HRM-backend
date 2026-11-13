import { NextFunction, Response } from "express";
import {
  ForbiddenException,
  UnauthenticatedException,
} from "../../node-base/utils";
import { currentCompanyContext } from "../../TenantModule/services/companyContext";
import { verifyStoredToken } from "./session";
import { AuthenticatedRequest } from "./types";

const verifiedRequests = new WeakMap<
  AuthenticatedRequest,
  { auth: import("./types").AuthUser; accountOnly: boolean }
>();

export const authMiddleware =
  (requiredPermissions: string[] = [], allowAccountOnly = false) =>
  async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const cached = verifiedRequests.get(req);
      if (cached && (allowAccountOnly || !cached.accountOnly)) {
        if (
          !cached.auth.permissions.includes("*") &&
          requiredPermissions.some(
            (permission) => !cached.auth.permissions.includes(permission),
          )
        )
          throw new ForbiddenException();
        req.auth = cached.auth;
        next();
        return;
      }
      const header = req.headers.authorization;
      const accessToken = header?.startsWith("Bearer ")
        ? header.slice(7)
        : req.get("accessToken");
      if (!accessToken) throw new UnauthenticatedException();
      const payload = await verifyStoredToken(accessToken, "access");
      if (!payload) throw new UnauthenticatedException();
      const { auth } = await currentCompanyContext(payload, allowAccountOnly);
      if (
        !auth.permissions.includes("*") &&
        requiredPermissions.some(
          (permission) => !auth.permissions.includes(permission),
        )
      ) {
        throw new ForbiddenException();
      }
      req.auth = { ...auth, sessionId: payload.sessionId };
      verifiedRequests.set(req, {
        auth: req.auth,
        accountOnly: allowAccountOnly,
      });
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
