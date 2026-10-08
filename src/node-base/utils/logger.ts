import expressWinston from "express-winston";
import winston from "winston";
import config from "../../common/config";

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.prettyPrint(),
);

export const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  defaultMeta: config.logging.defaultMeta,
  transports: [
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
    }),
    new winston.transports.File({
      filename: "logs/combined.log",
      level: "info",
    }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  );
}

export const loggerMiddleware = expressWinston.logger({
  transports: [new winston.transports.File({ filename: "logs/server.log" })],
  format: logFormat,
  expressFormat: true,
});

export const errorLoggerMiddleware = expressWinston.errorLogger({
  transports: [
    new winston.transports.File({ filename: "logs/serverError.log" }),
  ],
  format: logFormat,
});
