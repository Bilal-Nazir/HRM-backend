import { NextFunction, Request, Response } from "express";

export * from "./logger";

export const asyncWrapper =
  (
    controller: (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => Promise<unknown>,
  ) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(controller(req, res, next)).catch(next);

export const sendResponseObject = ({
  res,
  code = 200,
  message = "OK",
  data = {},
  success = code >= 200 && code < 300,
}: {
  res: Response;
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
  success?: boolean;
}) => res.status(code).json({ success, code, message, data });

export class ObjectNotFoundException extends Error {
  statusCode = 404;

  constructor(resource = "Record") {
    super(`${resource} not found`);
  }
}

export class HttpException extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public data?: any,
  ) {
    super(message);
  }
}

export class ValidationException extends HttpException {
  constructor(data: string | Record<string, any>) {
    super(
      422,
      typeof data === "string" ? data : "Validation failed",
      typeof data === "string" ? undefined : data,
    );
  }
}

export class UnauthenticatedException extends HttpException {
  constructor(message = "Authentication required") {
    super(401, message);
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = "You do not have permission for this action") {
    super(403, message);
  }
}

export class ConflictException extends HttpException {
  constructor(message: string) {
    super(409, message);
  }
}
