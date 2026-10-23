import cors from "cors";
import express, { Express, NextFunction, Request, Response } from "express";
import config from "../common/config";
import { Database as RedisDatabase } from "../node-base/baseClasses/Redis";
import { Database as MongoDatabase } from "../node-base/baseClasses/Typegoose";
import registerRoutes from "../routes";
import {
  createFirstAdminScript,
  syncUniqueIndexesScript,
} from "../database/scripts";
import { createDefaultLeaveTypesScript } from "../database/scripts/createDefaultLeaveTypesScript";
import { logger, sendResponseObject } from "../node-base/utils";

const startServer = async () => {
  const app: Express = express();
  app.set("trust proxy", true);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "12mb" }));

  registerRoutes(app);

  app.use(
    (
      error: Error & { statusCode?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      return sendResponseObject({
        res,
        code: error.statusCode || 500,
        message: error.message || "Internal server error",
        data: (error as Error & { data?: Record<string, unknown> }).data || {},
        success: false,
      });
    },
  );

  // Do not report healthy or accept requests before storage and bootstrap are ready.
  await Promise.all([MongoDatabase.initialize(), RedisDatabase.initialize()]);
  await syncUniqueIndexesScript();
  await createFirstAdminScript();
  await createDefaultLeaveTypesScript();
  const server = app.listen(config.server.port, "0.0.0.0", () => {
    logger.info(`HRM backend listening on port ${config.server.port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await Promise.all([MongoDatabase.close(), RedisDatabase.close()]);
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

export default startServer;
