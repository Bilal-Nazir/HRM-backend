import { randomUUID } from "crypto";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import config from "../../common/config";
import { Database as RedisDatabase } from "../../node-base/baseClasses/Redis";
import { AuthUser } from "./types";

type SessionTokenPayload = AuthUser &
  JwtPayload & {
    sessionId: string;
    tokenId: string;
    tokenType: "access" | "refresh";
  };

const tokenKey = (type: "access" | "refresh", tokenId: string) =>
  `${config.jwt.sessionPrefix}:session:${type}:${tokenId}`;

const userSessionsKey = (userId: string) =>
  `${config.jwt.sessionPrefix}:user-sessions:${userId}`;

const sessionTokensKey = (sessionId: string) =>
  `${config.jwt.sessionPrefix}:session-tokens:${sessionId}`;

const signToken = (
  payload: AuthUser,
  tokenType: "access" | "refresh",
  sessionId: string,
  tokenId: string,
  expiresIn: number,
) =>
  jwt.sign({ ...payload, tokenType, sessionId, tokenId }, config.jwt.secret, {
    expiresIn,
  } as SignOptions);

const storeToken = async (
  payload: AuthUser,
  tokenType: "access" | "refresh",
  sessionId: string,
  tokenId: string,
  expiresIn: number,
) => {
  const key = tokenKey(tokenType, tokenId);
  await RedisDatabase.client.set(
    key,
    JSON.stringify({ userId: payload.userId, sessionId }),
    { EX: expiresIn },
  );
  const sessionKey = sessionTokensKey(sessionId);
  const userKey = userSessionsKey(payload.userId);
  await Promise.all([
    RedisDatabase.client.sAdd(sessionKey, key),
    RedisDatabase.client.expire(sessionKey, config.jwt.refreshTokenTtlSeconds),
    RedisDatabase.client.sAdd(userKey, [key, sessionKey]),
    RedisDatabase.client.expire(userKey, config.jwt.refreshTokenTtlSeconds),
  ]);
};

export const generateSessionTokens = async (payload: AuthUser) => {
  const sessionId = randomUUID();
  const accessTokenId = randomUUID();
  const refreshTokenId = randomUUID();

  const accessToken = signToken(
    payload,
    "access",
    sessionId,
    accessTokenId,
    config.jwt.accessTokenTtlSeconds,
  );
  const refreshToken = signToken(
    payload,
    "refresh",
    sessionId,
    refreshTokenId,
    config.jwt.refreshTokenTtlSeconds,
  );

  await Promise.all([
    storeToken(
      payload,
      "access",
      sessionId,
      accessTokenId,
      config.jwt.accessTokenTtlSeconds,
    ),
    storeToken(
      payload,
      "refresh",
      sessionId,
      refreshTokenId,
      config.jwt.refreshTokenTtlSeconds,
    ),
  ]);

  return { accessToken, refreshToken };
};

export const verifyStoredToken = async (
  token: string,
  expectedType: "access" | "refresh",
) => {
  let payload: SessionTokenPayload;
  try {
    payload = jwt.verify(token, config.jwt.secret) as SessionTokenPayload;
  } catch {
    return null;
  }

  if (payload.tokenType !== expectedType || !payload.tokenId) return null;

  const stored = await RedisDatabase.client.get(
    tokenKey(expectedType, payload.tokenId),
  );
  if (!stored) return null;

  return payload;
};

export const refreshAccessToken = async (refreshToken: string) => {
  const payload = await verifyStoredToken(refreshToken, "refresh");
  if (!payload) return null;

  const accessTokenId = randomUUID();
  const sessionPayload: AuthUser = {
    userId: payload.userId,
    employeeId: payload.employeeId,
    organizationId: payload.organizationId,
    permissions: payload.permissions,
    accountType: payload.accountType,
    credentialVersion: payload.credentialVersion || 0,
  };

  const accessToken = signToken(
    sessionPayload,
    "access",
    payload.sessionId,
    accessTokenId,
    config.jwt.accessTokenTtlSeconds,
  );

  await storeToken(
    sessionPayload,
    "access",
    payload.sessionId,
    accessTokenId,
    config.jwt.accessTokenTtlSeconds,
  );

  return { accessToken, payload: sessionPayload };
};

export const revokeToken = async (token: string) => {
  const decoded = jwt.decode(token) as SessionTokenPayload | null;
  if (!decoded?.tokenId || !decoded.tokenType) return;
  await RedisDatabase.client.del(tokenKey(decoded.tokenType, decoded.tokenId));
};

export const revokeSession = async (
  accessToken?: string,
  refreshToken?: string,
) => {
  const tokens = [accessToken, refreshToken].filter((token): token is string =>
    Boolean(token),
  );
  const sessionIds = new Set(
    tokens
      .map((token) => jwt.decode(token) as SessionTokenPayload | null)
      .map((payload) => payload?.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  await Promise.all(
    [...sessionIds].map(async (sessionId) => {
      const sessionKey = sessionTokensKey(sessionId);
      const keys = await RedisDatabase.client.sMembers(sessionKey);
      if (keys.length) await RedisDatabase.client.del(keys);
      await RedisDatabase.client.del(sessionKey);
    }),
  );

  if (!sessionIds.size) await Promise.all(tokens.map(revokeToken));
};

export const revokeUserSessions = async (userId: string) => {
  const setKey = userSessionsKey(userId);
  const keys = await RedisDatabase.client.sMembers(setKey);
  if (keys.length) await RedisDatabase.client.del(keys);
  await RedisDatabase.client.del(setKey);
};
