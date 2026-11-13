import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { Database as Redis } from "../../node-base/baseClasses/Redis";
import config from "../../common/config";
export async function authRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const identity = createHash("sha256")
      .update(req.ip || req.socket.remoteAddress || "unknown")
      .digest("hex");
    const key = `${config.jwt.sessionPrefix}:auth-limit:${identity}:${Math.floor(Date.now() / 900000)}`;
    const count = await Redis.client.incr(key);
    if (count === 1) await Redis.client.expire(key, 901);
    if (count > 60) {
      res.status(429).json({
        success: false,
        code: 429,
        message: "Too many sign-in attempts. Try again later",
        data: {},
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
