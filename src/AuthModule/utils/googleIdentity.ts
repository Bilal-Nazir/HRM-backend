import { randomBytes } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { Database as Redis } from "../../node-base/baseClasses/Redis";
import config from "../../common/config";
import {
  UnauthenticatedException,
  ValidationException,
} from "../../node-base/utils";
const key = (nonce: string) =>
  `${config.jwt.sessionPrefix}:google-nonce:${nonce}`;
export async function googleChallenge() {
  if (!process.env.GOOGLE_CLIENT_ID)
    throw new ValidationException("Google sign-in has not been configured yet");
  const nonce = randomBytes(32).toString("hex");
  await Redis.client.set(key(nonce), "1", { EX: 300 });
  return { nonce, clientId: process.env.GOOGLE_CLIENT_ID };
}
export async function verifyGoogleCredential(
  credential: unknown,
  nonce: unknown,
) {
  if (!process.env.GOOGLE_CLIENT_ID)
    throw new ValidationException("Google sign-in has not been configured yet");
  if (
    typeof nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    typeof credential !== "string" ||
    credential.length > 12000
  )
    throw new UnauthenticatedException("Invalid Google sign-in");
  let identity;
  try {
    const ticket = await new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
    ).verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    identity = ticket.getPayload();
  } catch {
    throw new UnauthenticatedException("Google sign-in could not be verified");
  }
  if (
    !identity?.sub ||
    !identity.email ||
    !identity.email_verified ||
    (!identity.email.toLowerCase().endsWith("@gmail.com") && !identity.hd) ||
    identity.nonce !== nonce
  )
    throw new UnauthenticatedException("Google sign-in could not be verified");
  if (!(await Redis.client.getDel(key(nonce))))
    throw new UnauthenticatedException(
      "Google sign-in expired. Please try again",
    );
  return {
    subject: identity.sub,
    email: identity.email.toLowerCase().trim(),
    name: identity.name || identity.email,
  };
}
