import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, mocks) {
  const context = {
    exports: {},
    require: (path) => mocks[path] || require(path),
  };
  runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL(`../src/AuthModule/${file}`, import.meta.url),
        "utf8",
      ),
      {
        fileName: file,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText,
    context,
  );
  return context.exports;
}
class UnauthenticatedException extends Error {}
class ForbiddenException extends Error {}
const utils = {
  UnauthenticatedException,
  ForbiddenException,
  asyncWrapper: (handler) => handler,
  sendResponseObject: ({ data }) => data,
};
const auth = {
  userId: "user-1",
  employeeId: "employee-1",
  organizationId: "org-1",
  permissions: ["employee.read.self"],
  accountType: "employee",
  credentialVersion: 2,
  tokenId: "private-token",
  sessionId: "private-session",
};
function fixture({
  account = { loginId: "E-1", isActive: true, credentialVersion: 2 },
  payload = auth,
} = {}) {
  const queries = [],
    tokens = [];
  const UserModel = {
    async findOne(filter) {
      queries.push(filter);
      return account;
    },
  };
  const mocks = {
    "../../node-base/utils": utils,
    "../../node-base/baseClasses": { BaseControllerClass: class {} },
    "../../node-base/constants": {
      constants: { fields: { User: { User: "user" } } },
    },
    "../models/User": { __esModule: true, default: UserModel },
    "../../TenantModule/services/companyContext": {
      async currentCompanyContext(payload) {
        const user = await UserModel.findOne({
          _id: payload.userId,
          isActive: true,
          isDeleted: { $ne: true },
        });
        if (
          !user ||
          (user.credentialVersion || 0) !== (payload.credentialVersion || 0)
        )
          throw new UnauthenticatedException();
        return { user, auth: payload };
      },
      sessionProfile: (user, auth) => ({
        userId: auth.userId,
        employeeId: auth.employeeId,
        organizationId: auth.organizationId,
        loginId: user.loginId,
        permissions: auth.permissions,
        accountType: auth.accountType,
      }),
    },
    "../utils/loginPortal": {},
    "../utils/googleIdentity": {},
    "../../TenantModule/models/CompanyMembership": {},
    "../../TenantModule/controllers/CompanyController": {},
    "../utils/authRateLimit": { authRateLimit() {} },
    "../../EmployeeModule/models/Employee": {},
    "../../AccessModule/models/RoleAssignment": {},
    "../../OrganizationModule/models/Organization": {},
    "../../node-base/validator": {},
    "../utils/password": {},
    "../utils/session": {},
    "./session": {
      async verifyStoredToken(token, type) {
        tokens.push([token, type]);
        return payload;
      },
    },
  };
  const middleware = load("utils/authMiddleware.ts", mocks);
  const controller = load("controllers/AuthController.ts", mocks).default;
  const registrations = [];
  const router = {
    get(...args) {
      registrations.push(args);
    },
    post() {},
    patch() {},
  };
  load("routes/index.ts", {
    ...mocks,
    express: { Router: () => router },
    "../controllers/AuthController": { __esModule: true, default: controller },
    "../utils/authMiddleware": middleware,
  });
  const route = registrations.find(([path]) => path === "/session");
  const req = { headers: {}, get() {} };
  return { controller, route, req, queries, tokens };
}

test("session endpoint requires a live access token before returning any user information", async () => {
  for (const token of [undefined, "Bearer revoked"]) {
    const f = fixture({ payload: null });
    f.req.headers.authorization = token;
    let failure;
    await f.route[1](f.req, {}, (error) => {
      failure = error;
    });
    assert.ok(failure instanceof UnauthenticatedException);
    assert.equal(f.req.auth, undefined);
    assert.equal(f.queries.length, 0);
  }
});

test("session endpoint verifies account activity and password version", async () => {
  for (const account of [null, { isActive: true, credentialVersion: 3 }]) {
    const f = fixture({ account });
    f.req.headers.authorization = "Bearer token";
    let failure;
    await f.route[1](f.req, {}, (error) => {
      failure = error;
    });
    assert.ok(failure instanceof UnauthenticatedException);
    assert.equal(f.queries[0]._id, auth.userId);
    assert.equal(f.queries[0].isActive, true);
    assert.deepEqual(f.tokens, [["token", "access"]]);
  }
});

test("valid admin and employee sessions return only their verified identity with no-store caching", async () => {
  for (const accountType of ["employee", "admin"]) {
    const f = fixture({
      payload: {
        ...auth,
        accountType,
        permissions: accountType === "admin" ? ["*"] : auth.permissions,
      },
    });
    f.req.headers.authorization = "Bearer valid-token";
    let error;
    await f.route[1](f.req, {}, (value) => {
      error = value;
    });
    assert.equal(error, undefined);
    const headers = {};
    const data = await f.route[2](f.req, {
      set(key, value) {
        headers[key] = value;
      },
    });
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(data.user.userId, auth.userId);
    assert.equal(data.user.loginId, "E-1");
    assert.equal(data.user.accountType, accountType);
    assert.equal(data.user.tokenId, undefined);
    assert.equal(data.user.sessionId, undefined);
    assert.equal(data.user.credentialVersion, undefined);
    assert.equal(data.user.passwordHash, undefined);
  }
});
