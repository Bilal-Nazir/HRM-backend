import { createClient, RedisClientType } from "redis";
import config from "../../../common/config";
import { logger } from "../../utils";

export class Database {
  public static client: RedisClientType;

  public static async initialize() {
    if (Database.client?.isOpen) return Database.client;

    const client = createClient({
      url: config.database.redis.url,
      password: config.database.redis.password,
    });

    client.on("error", (error) => {
      logger.error("Redis client error", { error });
    });

    await client.connect();
    Database.client = client as RedisClientType;
    logger.info("Redis Database Initialized");
    return Database.client;
  }

  public static async close() {
    if (Database.client?.isOpen) await Database.client.quit();
  }
}
