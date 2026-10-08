import mongoose from "mongoose";
import config from "../../../common/config";
import { logger } from "../../utils";

export class Database {
  public static async initialize() {
    if (mongoose.connection.readyState === 1) return mongoose.connection;

    await mongoose.connect(config.database.mongodb.uri, {
      dbName: config.database.mongodb.dbName,
    });

    logger.info("Typegoose Database connected");
    return mongoose.connection;
  }

  public static async close() {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}
