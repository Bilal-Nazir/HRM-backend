import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
class UnauthenticatedException extends Error {}
class ValidationException extends Error {}
function fixture() {
  const memory = new Map(),
    verified = [],
    environment = { GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com" };
  let claims,
    signatureFailure = false;
  class OAuth2Client {
    async verifyIdToken(options) {
      verified.push(options);
      if (signatureFailure) throw new Error("invalid signature");
      return { getPayload: () => claims };
    }
  }
  const scope = {
    exports: {},
    Buffer,
    process: { env: environment },
    require(path) {
      if (path === "google-auth-library") return { OAuth2Client };
      if (path.endsWith("/Redis"))
        return {
          Database: {
            client: {
              async set(key, value) {
                memory.set(key, value);
              },
              async getDel(key) {
                const result = memory.get(key);
                memory.delete(key);
                return result;
              },
            },
          },
        };
      if (path.endsWith("/config"))
        return {
          __esModule: true,
          default: { jwt: { sessionPrefix: "unit" } },
        };
      if (path.endsWith("/utils"))
        return { UnauthenticatedException, ValidationException };
      return require(path);
    },
  };
  runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL("../src/AuthModule/utils/googleIdentity.ts", import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText,
    scope,
  );
  return {
    ...scope.exports,
    verified,
    memory,
    environment,
    claims(value) {
      claims = value;
    },
    rejectSignature() {
      signatureFailure = true;
    },
  };
}
test("Google validates the configured audience and server-issued nonce, then consumes nonce once", async () => {
  const f = fixture();
  const { nonce, clientId } = await f.googleChallenge();
  assert.equal(nonce.length, 64);
  assert.equal(clientId, f.environment.GOOGLE_CLIENT_ID);
  f.claims({
    sub: "unique-google-id",
    email: "Owner@GMAIL.com",
    email_verified: true,
    nonce,
    name: "Owner",
  });
  const result = await f.verifyGoogleCredential("signed-google-token", nonce);
  assert.equal(result.email, "owner@gmail.com");
  assert.equal(result.subject, "unique-google-id");
  assert.equal(f.verified[0].audience, clientId);
  assert.equal(f.verified[0].idToken, "signed-google-token");
  await assert.rejects(
    f.verifyGoogleCredential("signed-google-token", nonce),
    /expired/,
  );
});
test("forged tokens, mismatched nonce, unverified emails and non-authoritative Google emails are rejected", async () => {
  for (const override of [
    { sub: "" },
    { email_verified: false },
    { nonce: "attacker-nonce" },
    { email: "unverified-owner@third-party.test" },
  ]) {
    const f = fixture();
    const { nonce } = await f.googleChallenge();
    f.claims({
      sub: "subject",
      email: "person@gmail.com",
      email_verified: true,
      nonce,
      ...override,
    });
    await assert.rejects(
      f.verifyGoogleCredential("signed-token", nonce),
      UnauthenticatedException,
    );
    assert.equal(f.memory.size, 1);
  }
  const f = fixture();
  const { nonce } = await f.googleChallenge();
  f.rejectSignature();
  await assert.rejects(
    f.verifyGoogleCredential("forged", nonce),
    UnauthenticatedException,
  );
});
test("verified Workspace email is accepted, expired nonce and missing configuration fail closed", async () => {
  const f = fixture();
  const { nonce } = await f.googleChallenge();
  f.claims({
    sub: "subject",
    email: "person@company.test",
    hd: "company.test",
    email_verified: true,
    nonce,
  });
  assert.equal(
    (await f.verifyGoogleCredential("signed-token", nonce)).email,
    "person@company.test",
  );
  const expired = fixture();
  const challenge = await expired.googleChallenge();
  expired.memory.clear();
  expired.claims({
    sub: "subject",
    email: "person@gmail.com",
    email_verified: true,
    nonce: challenge.nonce,
  });
  await assert.rejects(
    expired.verifyGoogleCredential("signed-token", challenge.nonce),
    /expired/,
  );
  delete f.environment.GOOGLE_CLIENT_ID;
  await assert.rejects(f.googleChallenge(), ValidationException);
  await assert.rejects(
    f.verifyGoogleCredential("token", nonce),
    ValidationException,
  );
});
