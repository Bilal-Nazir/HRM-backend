if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || ["development-only-secret-change-me", "replace-with-a-long-random-secret"].includes(process.env.JWT_SECRET))) {
  throw new Error("Set a unique JWT_SECRET of at least 32 characters in production.");
}

const config = {
  pagination: {
    page: 1,
    limit: 10,
  },
  server: {
    port: Number(process.env.SERVER_PORT) || 8080,
  },
  logging: {
    level: process.env.LOG_LEVEL || "debug",
    defaultMeta: { service: "hrm-backend" },
  },
  database: {
    mongodb: {
      uri: process.env.DB_MONGO_URI || "mongodb://127.0.0.1:27017/hrm",
      dbName: process.env.DB_MONGO_DB_NAME || "hrm",
    },
    redis: {
      url: process.env.DB_REDIS_URL || "redis://127.0.0.1:6379",
      password: process.env.DB_REDIS_PASS || undefined,
    },
  },
  jwt: {
    secret: process.env.JWT_SECRET || "development-only-secret-change-me",
    accessTokenTtlSeconds: Number(
      process.env.JWT_ACCESS_TOKEN_TTL_SECONDS || 900,
    ),
    refreshTokenTtlSeconds: Number(
      process.env.JWT_REFRESH_TOKEN_TTL_SECONDS || 2592000,
    ),
    sessionPrefix: process.env.JWT_SESSION_PREFIX || "hrm",
  },
};

export default config;
