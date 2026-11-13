import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import express from "express";
const databaseName = "hrm_tenant_test_" + randomUUID().replaceAll("-", "");
process.env.JWT_SESSION_PREFIX = databaseName;
process.env.DB_REDIS_URL =
  process.env.HRM_TEST_REDIS_URL || "redis://127.0.0.1:6383";
process.env.DB_REDIS_PASS = "";
const root = "../tmp/tenant-test-build/src/";
const { default: registerRoutes } = await import(root + "routes/index.js");
const { Database: Redis } = await import(
  root + "node-base/baseClasses/Redis/index.js"
);
const { sendResponseObject } = await import(root + "node-base/utils/index.js");
const { generateSessionTokens } = await import(
  root + "AuthModule/utils/session.js"
);
const { hashPassword } = await import(root + "AuthModule/utils/password.js");
const { migrateTenants } = await import("../scripts/migrate-tenants.mjs");
const M = mongoose.models;
const User = M.UserClass,
  Org = M.OrganizationClass,
  Employee = M.EmployeeClass,
  Membership = M.CompanyMembershipClass;

test("multi-company membership, isolation, ownership, invitations, BSON refs and migration", async (t) => {
  let server;
  try {
    await mongoose.connect(
      process.env.HRM_TEST_MONGO_URI || "mongodb://127.0.0.1:28073",
      { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
    );
    await Redis.initialize();
    await Promise.all(Object.values(M).map((model) => model.init()));
    const app = express();
    app.use(express.json());
    registerRoutes(app);
    app.use((error, _req, res, _next) =>
      sendResponseObject({
        res,
        code: error.statusCode || 500,
        message: error.message,
        data: error.data || {},
        success: false,
      }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const password = "Tenant-test-password-42";
    async function account(email, platform = false) {
      const user = await User.create({
        loginId: email,
        email,
        passwordHash: await hashPassword(password),
        isActive: true,
        isPlatformAdmin: platform,
      });
      return {
        account: user,
        ...(await generateSessionTokens({
          userId: user.id,
          permissions: [],
          accountType: "admin",
          credentialVersion: 0,
        })),
      };
    }
    async function request(path, session, method = "GET", data) {
      const response = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(session && { Authorization: `Bearer ${session.accessToken}` }),
        },
        ...(data && { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() };
    }
    const owner = await account("owner@gmail.com"),
      other = await account("other@gmail.com"),
      platform = await account("platform@gmail.com", true);
    let companyA, companyB, companyOther, employee, employeeAccount, invitation;
    await t.test(
      "account without company cannot read tenant data or forge platform privileges",
      async () => {
        for (const path of [
          "/employee/view",
          "/attendance?scope=organization",
          "/projects",
          "/organization",
          "/access/roles",
          "/announcements",
          "/terms",
        ])
          assert.equal((await request(path, owner)).status, 403, path);
        assert.equal(
          (
            await request(
              "/companies/000000000000000000000001/status",
              owner,
              "PATCH",
              { status: "suspended" },
            )
          ).status,
          403,
        );
        const forged = {
          ...owner,
          ...(await generateSessionTokens({
            userId: owner.account.id,
            permissions: ["*"],
            accountType: "admin",
            isPlatformAdmin: true,
          })),
        };
        assert.equal(
          (
            await request(
              "/companies/000000000000000000000001/status",
              forged,
              "PATCH",
              { status: "suspended" },
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "owner creates multiple active companies without an employee profile",
      async () => {
        const a = await request("/companies", owner, "POST", {
          name: "Company A",
          slug: "company-a",
          timezone: "Asia/Karachi",
          ownerUserId: other.account.id,
        });
        assert.equal(a.status, 201, JSON.stringify(a.body));
        Object.assign(owner, a.body.data);
        companyA = a.body.data.user.organizationId;
        assert.equal(a.body.data.user.isCompanyOwner, true);
        assert.equal(a.body.data.user.accountType, "employee");
        assert.equal(a.body.data.user.isPlatformAdmin, false);
        assert.equal(a.body.data.user.employeeId, undefined);
        assert.equal(
          (await Org.findById(companyA)).ownerUserId,
          owner.account.id,
        );
        const b = await request("/companies", owner, "POST", {
          name: "Company B",
          slug: "company-b",
          timezone: "UTC",
        });
        assert.equal(b.status, 201, JSON.stringify(b.body));
        Object.assign(owner, b.body.data);
        companyB = b.body.data.user.organizationId;
        assert.equal(
          (await request("/companies", owner)).body.data.companies.length,
          2,
        );
        const c = await request("/companies", other, "POST", {
          name: "Other company",
          slug: "company-other",
          timezone: "UTC",
        });
        assert.equal(c.status, 201);
        Object.assign(other, c.body.data);
        companyOther = c.body.data.user.organizationId;
      },
    );
    await t.test("company admins use the user login and Super Admin alone uses the admin login", async () => {
      for (const organizationSlug of [undefined, "company-a"]) {
        const credentials = { loginId: owner.account.loginId, password, ...(organizationSlug && { organizationSlug }) };
        assert.equal((await request("/auth/login", null, "POST", { ...credentials, portal: "admin" })).status, 401);
        const allowed = await request("/auth/login", null, "POST", { ...credentials, portal: "employee" });
        assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
        assert.equal(allowed.body.data.user.accountType, "employee");
      }
      assert.equal((await request("/auth/login", null, "POST", { loginId: platform.account.loginId, password, portal: "employee" })).status, 401);
      const allowed = await request("/auth/login", null, "POST", { loginId: platform.account.loginId, password, portal: "admin" });
      assert.equal(allowed.status, 200); assert.equal(allowed.body.data.user.isPlatformAdmin, true);
      assert.equal(allowed.body.data.user.accountType, "admin");
      const forged = await generateSessionTokens({ userId: owner.account.id, organizationId: companyA, permissions: ["*"], accountType: "admin", isPlatformAdmin: true });
      const checked = await request("/auth/session", forged);
      assert.equal(checked.body.data.user.accountType, "employee");
      assert.equal(checked.body.data.user.isCompanyOwner, true);
      assert.equal(checked.body.data.user.isPlatformAdmin, false);
    });
    await t.test(
      "company switch rotates sessions and denies cross-company entry",
      async () => {
        const old = { ...owner };
        const a = await request(`/companies/${companyA}/switch`, owner, "POST");
        assert.equal(a.status, 200);
        Object.assign(owner, a.body.data);
        assert.equal((await request("/auth/session", old)).status, 401);
        assert.equal(
          (await request(`/companies/${companyOther}/switch`, owner, "POST"))
            .status,
          403,
        );
        const before = await request("/organization", owner);
        assert.equal(before.body.data.organization.id, companyA);
        await request("/organization", owner, "PATCH", {
          ownerUserId: other.account.id,
          status: "suspended",
          employeeSequence: 999,
          name: "Updated A",
        });
        assert.equal(
          (await Org.findById(companyA)).ownerUserId,
          owner.account.id,
        );
        assert.equal((await Org.findById(companyA)).status, "active");
      },
    );
    await t.test(
      "organization units cannot be moved across companies or reference foreign leads",
      async () => {
        const foreign = await Employee.create({
          organizationId: companyOther,
          employeeCode: "foreign",
          firstName: "Foreign",
          lastName: "Employee",
          workEmail: "foreign@example.test",
          employmentStatus: "active",
        });
        assert.equal(
          (
            await request("/organization/teams", owner, "POST", {
              name: "Invalid team",
              leadEmployeeId: foreign.id,
            })
          ).status,
          422,
        );
        const created = await request("/organization/teams", owner, "POST", {
          name: "Valid team",
        });
        assert.equal(created.status, 201);
        const team = created.body.data.team;
        assert.equal(
          (
            await request(`/organization/teams/${team.id}`, owner, "PATCH", {
              leadEmployeeId: foreign.id,
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await request(`/organization/teams/${team.id}`, owner, "PATCH", {
              name: "Updated team",
              organizationId: companyOther,
            })
          ).status,
          200,
        );
        assert.equal(
          String(
            (
              await M.TeamClass.collection.findOne({
                _id: new mongoose.Types.ObjectId(team.id),
              })
            ).organizationId,
          ),
          companyA,
        );
        const visible = await request("/organization/teams", other);
        assert.equal(visible.body.data.teams.length, 0);
      },
    );
    await t.test(
      "employee creation uses BSON references, membership and unique global identity",
      async () => {
        const created = await request("/employee/create", owner, "POST", {
          firstName: "Sam",
          lastName: "Employee",
          workEmail: "sam@gmail.com",
          password,
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        employee = created.body.data.employee;
        const row = await Employee.collection.findOne({
          _id: new mongoose.Types.ObjectId(employee.id),
        });
        assert.ok(row.organizationId instanceof mongoose.Types.ObjectId);
        assert.ok(row.userId instanceof mongoose.Types.ObjectId);
        assert.equal(row.organizationId.toString(), companyA);
        const login = await request("/auth/login", null, "POST", {
          loginId: employee.employeeCode,
          password,
          portal: "employee",
        });
        assert.equal(login.status, 200, JSON.stringify(login.body));
        employeeAccount = login.body.data;
        assert.equal(employeeAccount.user.organizationId, companyA);
        assert.equal(employeeAccount.user.isCompanyOwner, false);
        assert.equal(
          (
            await request(
              "/companies/transfer-ownership",
              employeeAccount,
              "POST",
              { userId: other.account.id, confirmation: "company-a" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/access/roles", employeeAccount, "POST", {
              name: "Admin",
              permissions: ["*"],
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "tasks and aggregation totals are scoped and native refs preserve worklogs",
      async () => {
        const projectResult = await request("/projects", owner, "POST", {
          name: "Test project",
          key: "TST",
          managerEmployeeId: employee.id,
          memberEmployeeIds: [employee.id],
          taskDurationOptionsMinutes: [30],
        });
        assert.equal(
          projectResult.status,
          201,
          JSON.stringify(projectResult.body),
        );
        const project = projectResult.body.data.project;
        assert.equal(
          (
            await request(
              `/projects/${project.id}/workflow/durations`,
              owner,
              "PATCH",
              { taskDurationOptionsMinutes: [30] },
            )
          ).status,
          200,
        );
        const taskResult = await request(
          `/projects/${project.id}/tasks`,
          owner,
          "POST",
          {
            title: "Scoped task",
            assigneeEmployeeIds: [employee.id],
            durationMinutes: 30,
          },
        );
        assert.equal(taskResult.status, 201, JSON.stringify(taskResult.body));
        const task = taskResult.body.data.task;
        const row = await M.ProjectTaskClass.collection.findOne({
          _id: new mongoose.Types.ObjectId(task.id),
        });
        assert.ok(row.projectId instanceof mongoose.Types.ObjectId);
        assert.ok(
          row.assigneeEmployeeIds[0] instanceof mongoose.Types.ObjectId,
        );
        const list = await request("/projects", owner);
        assert.equal(list.body.data.projects[0].totalTasks, 1);
        assert.equal(
          (await request(`/projects/${project.id}/tasks/${task.id}`, other))
            .status,
          404,
        );
        assert.equal(
          (
            await request(
              `/projects/${project.id}/tasks/${task.id}`,
              employeeAccount,
            )
          ).status,
          200,
        );
        assert.equal(
          (await request(`/employee/${employee.id}`, other)).status,
          422,
        );
      },
    );
    await t.test(
      "owner can create delegated roles but reserved admin and wildcard grants are rejected",
      async () => {
        for (const name of [
          "Organization Admin",
          "Company Admin",
          "Owner",
          "Super Admin",
        ])
          assert.equal(
            (
              await request("/access/roles", owner, "POST", {
                name,
                permissions: ["project.read"],
              })
            ).status,
            422,
          );
        assert.equal(
          (
            await request("/access/roles", owner, "POST", {
              name: "Bad",
              permissions: ["*"],
            })
          ).status,
          422,
        );
        const role = await request("/access/roles", owner, "POST", {
          name: "Task reviewer",
          permissions: ["employee.read.all", "project.read"],
        });
        assert.equal(role.status, 201, JSON.stringify(role.body));
        const assigned = await request("/access/assignments", owner, "POST", {
          employeeId: employee.id,
          roleId: role.body.data.role.id,
          scopeType: "organization",
        });
        assert.equal(assigned.status, 201);
        await Employee.updateOne(
          { _id: employee.id },
          {
            $set: {
              personalEmail: "private@example.com",
              phone: "private",
              metadata: { emergencyContact: "private" },
            },
          },
        );
        const self = await request("/employee/me", employeeAccount);
        assert.equal(self.status, 200);
        const ownerView = await request(`/employee/${employee.id}`, owner);
        assert.equal(
          ownerView.body.data.employee.personalEmail,
          "private@example.com",
        );
        const another = await request("/employee/create", owner, "POST", {
          firstName: "Other",
          lastName: "Employee",
          workEmail: "second@gmail.com",
          password,
        });
        await Employee.updateOne(
          { _id: another.body.data.employee.id },
          {
            $set: {
              phone: "hidden",
              personalEmail: "hidden@example.com",
              metadata: { emergencyContact: "hidden" },
            },
          },
        );
        const delegated = await request(
          `/employee/${another.body.data.employee.id}`,
          employeeAccount,
        );
        assert.equal(delegated.status, 200);
        assert.equal(delegated.body.data.employee.phone, undefined);
        assert.equal(delegated.body.data.employee.personalEmail, undefined);
        assert.equal(delegated.body.data.employee.metadata, undefined);
      },
    );
    await t.test(
      "existing account is invited into another company, not silently activated",
      async () => {
        const result = await request("/employee/create", owner, "POST", {
          firstName: "Other",
          lastName: "Owner",
          workEmail: "other@gmail.com",
          password: "Cannot-reset-global-password-42",
        });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.data.employee.employmentStatus, "invited");
        assert.equal(
          (await request(`/companies/${companyA}/switch`, other, "POST"))
            .status,
          403,
        );
        invitation = await request("/companies/invitations", owner, "POST", {
          employeeId: result.body.data.employee.id,
        });
        assert.equal(invitation.status, 201);
        const token = invitation.body.data.token;
        assert.equal(
          (
            await request(
              "/companies/invitations/accept",
              employeeAccount,
              "POST",
              { token },
            )
          ).status,
          403,
        );
        const accepted = await request(
          "/companies/invitations/accept",
          other,
          "POST",
          { token },
        );
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        Object.assign(other, accepted.body.data);
        assert.equal(accepted.body.data.user.organizationId, companyA);
        assert.equal(accepted.body.data.user.isCompanyOwner, false);
        assert.equal(
          (
            await request("/companies/invitations/accept", other, "POST", {
              token,
            })
          ).status,
          403,
        );
        assert.equal(
          (await User.find({ email: "other@gmail.com", isDeleted: false }))
            .length,
          1,
        );
      },
    );
    await t.test(
      "ownership transfer is exclusive, immediately revokes old privileges and checks target membership",
      async () => {
        assert.equal(
          (
            await request("/companies/transfer-ownership", owner, "POST", {
              userId: platform.account.id,
              confirmation: "company-a",
            })
          ).status,
          422,
        );
        const oldOwner = { ...owner };
        const transfer = await request(
          "/companies/transfer-ownership",
          owner,
          "POST",
          { userId: other.account.id, confirmation: "company-a" },
        );
        assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
        Object.assign(owner, transfer.body.data);
        assert.equal(transfer.body.data.user.organizationId, undefined);
        assert.equal((await request("/auth/session", oldOwner)).status, 401);
        const newOwner = await request("/auth/session", other);
        assert.equal(newOwner.body.data.user.isCompanyOwner, true);
        assert.equal(
          (
            await request("/access/roles", other, "POST", {
              name: "New role",
              permissions: ["project.read"],
            })
          ).status,
          201,
        );
        assert.equal(
          (await request(`/companies/${companyA}/switch`, owner, "POST"))
            .status,
          403,
        );
        assert.equal(
          (await request(`/companies/${companyB}/switch`, owner, "POST"))
            .status,
          200,
        );
      },
    );
    await t.test(
      "suspending and archiving one membership preserve the account's other company",
      async () => {
        const otherEmployee = await Employee.findOne({
          organizationId: companyA,
          userId: other.account.id,
        });
        assert.equal(
          (await request(`/employee/${otherEmployee.id}`, other, "DELETE"))
            .status,
          403,
        );
        const companyAAdmin = {
          ...(await generateSessionTokens({
            userId: other.account.id,
            organizationId: companyA,
            permissions: [],
            accountType: "admin",
          })),
        };
        const cross = await request(
          `/companies/${companyOther}/switch`,
          other,
          "POST",
        );
        assert.equal(cross.status, 200);
        Object.assign(other, cross.body.data);
        const invited = await request("/employee/create", other, "POST", {
          firstName: "Sam",
          lastName: "Other company",
          workEmail: "sam@gmail.com",
          password,
        });
        assert.equal(invited.status, 201);
        const link = await request("/companies/invitations", other, "POST", {
          employeeId: invited.body.data.employee.id,
        });
        assert.equal(link.status, 201);
        const joined = await request(
          "/companies/invitations/accept",
          employeeAccount,
          "POST",
          { token: link.body.data.token },
        );
        assert.equal(joined.status, 200);
        Object.assign(employeeAccount, joined.body.data);
        const companyASession = await generateSessionTokens({
          userId: employeeAccount.user.userId,
          organizationId: companyA,
          permissions: [],
          accountType: "employee",
        });
        assert.equal(
          (
            await request(`/employee/${employee.id}`, companyAAdmin, "PATCH", {
              employmentStatus: "suspended",
            })
          ).status,
          200,
        );
        assert.equal((await request("/projects", companyASession)).status, 403);
        assert.equal(
          (await request("/auth/session", employeeAccount)).body.data.user
            .organizationId,
          companyOther,
        );
        assert.equal(
          (await User.findById(employeeAccount.user.userId)).isActive,
          true,
        );
        assert.equal(
          (await request(`/employee/${employee.id}`, companyAAdmin, "DELETE"))
            .status,
          200,
        );
        assert.equal(
          (await User.findById(employeeAccount.user.userId)).isDeleted,
          false,
        );
        assert.equal(
          (await request("/auth/session", employeeAccount)).status,
          200,
        );
        // Restore this shared fixture for the subsequent private-details checks.
        await Employee.updateOne(
          { _id: employee.id },
          { $set: { isDeleted: false, employmentStatus: "active" } },
        );
        await Membership.updateOne(
          { organizationId: companyA, userId: employeeAccount.user.userId },
          { $set: { status: "active" } },
        );
      },
    );
    await t.test(
      "Super Admin can inspect every company and suspension blocks company APIs but allows company selection",
      async () => {
        assert.equal(
          (await request("/companies", platform)).body.data.companies.length,
          3,
        );
        const inspected = await request(
          `/companies/${companyA}/switch`,
          platform,
          "POST",
        );
        assert.equal(inspected.status, 200);
        Object.assign(platform, inspected.body.data);
        assert.equal(
          (await request(`/employee/${employee.id}`, platform)).body.data
            .employee.personalEmail,
          "private@example.com",
        );
        const suspended = await request(
          `/companies/${companyOther}/status`,
          platform,
          "PATCH",
          { status: "suspended" },
        );
        assert.equal(suspended.status, 200);
        assert.equal((await request("/projects", other)).status, 403);
        assert.equal(
          (await request("/auth/session", other)).body.data.user.organizationId,
          undefined,
        );
        assert.equal((await request("/companies", other)).status, 200);
        assert.equal(
          (
            await request("/auth/refresh", null, "POST", {
              refreshToken: other.refreshToken,
            })
          ).status,
          200,
        );
        await request(`/companies/${companyOther}/status`, platform, "PATCH", {
          status: "active",
        });
      },
    );
    await t.test(
      "Google credentials are verified server-side and never accepted by decoding client claims",
      async () => {
        const original = process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_ID;
        assert.equal(
          (await request("/auth/google/config")).body.data.enabled,
          false,
        );
        assert.equal(
          (
            await request("/auth/google", null, "POST", {
              credential: "forged",
            })
          ).status,
          422,
        );
        process.env.GOOGLE_CLIENT_ID = "test.apps.googleusercontent.com";
        const challenge = await request("/auth/google/challenge");
        assert.equal(challenge.status, 200);
        assert.equal(challenge.body.data.nonce.length, 64);
        assert.equal(
          (
            await request("/auth/google", null, "POST", {
              credential: "forged",
              nonce: challenge.body.data.nonce,
            })
          ).status,
          401,
        );
        if (original === undefined) delete process.env.GOOGLE_CLIENT_ID;
        else process.env.GOOGLE_CLIENT_ID = original;
      },
    );
    await t.test(
      "migration refuses dangling/cross-company references and unreviewed duplicate accounts",
      async () => {
        const first = await User.create({
          loginId: "duplicate-one",
          email: "duplicate@gmail.com",
          passwordHash: await hashPassword(password),
        });
        const secondId = new mongoose.Types.ObjectId();
        await User.collection.insertOne({
          _id: secondId,
          loginId: "duplicate-two",
          isDeleted: true,
          isActive: false,
        });
        // Legacy duplicates have no global email yet; infer it from company profiles.
        await User.collection.updateOne(
          { _id: secondId },
          { $set: { isDeleted: false }, $unset: { email: "" } },
        );
        const row = await Employee.create({
          organizationId: companyB,
          userId: String(secondId),
          employeeCode: "duplicate",
          firstName: "Duplicate",
          lastName: "Account",
          workEmail: "duplicate@gmail.com",
          employmentStatus: "active",
        });
        const report = await migrateTenants(
          mongoose.connection.db,
          Object.values(M),
          { apply: true },
        );
        assert.ok(
          report.blockers.some((message) =>
            message.includes("--merge-accounts"),
          ),
        );
        assert.equal((await User.findById(secondId)).isDeleted, false);
        const foreignRole = await M.RoleClass.findOne({
          organizationId: companyOther,
        });
        const bad = new mongoose.Types.ObjectId();
        await M.RoleAssignmentClass.collection.insertOne({
          _id: bad,
          organizationId: companyB,
          employeeId: row._id,
          roleId: foreignRole._id,
          scopeType: "organization",
          isDeleted: false,
        });
        const scoped = await migrateTenants(
          mongoose.connection.db,
          Object.values(M),
        );
        assert.ok(
          scoped.blockers.some((message) =>
            message.includes("Cross-company reference"),
          ),
        );
        await M.RoleAssignmentClass.collection.deleteOne({ _id: bad });
        await Employee.deleteOne({ _id: row.id });
        await User.deleteMany({ _id: { $in: [first.id, secondId] } });
      },
    );
    await t.test(
      "migration dry-run detects legacy refs, preserves data and idempotently migrates to BSON",
      async () => {
        const legacyUserId = new mongoose.Types.ObjectId(),
          legacyOrgId = new mongoose.Types.ObjectId(),
          legacyEmployeeId = new mongoose.Types.ObjectId();
        await User.collection.insertOne({
          _id: legacyUserId,
          loginId: "legacy-admin",
          organizationId: legacyOrgId,
          passwordHash: await hashPassword(password),
          isActive: true,
          isPlatformAdmin: true,
          isDeleted: false,
        });
        await Org.collection.insertOne({
          _id: legacyOrgId,
          name: "Legacy",
          slug: "legacy",
          timezone: "UTC",
          status: "active",
          isDeleted: false,
        });
        await Employee.collection.insertOne({
          _id: legacyEmployeeId,
          organizationId: String(legacyOrgId),
          userId: String(legacyUserId),
          employeeCode: "legacy-001",
          firstName: "Legacy",
          lastName: "Employee",
          workEmail: "legacy@gmail.com",
          employmentStatus: "active",
          isDeleted: false,
        });
        const dry = await migrateTenants(
          mongoose.connection.db,
          Object.values(M),
        );
        assert.deepEqual(dry.blockers, [], JSON.stringify(dry));
        assert.ok(dry.referenceUpdates > 0);
        assert.equal(
          typeof (await Employee.collection.findOne({ _id: legacyEmployeeId }))
            .organizationId,
          "string",
        );
        const applied = await migrateTenants(
          mongoose.connection.db,
          Object.values(M),
          { apply: true },
        );
        assert.deepEqual(applied.blockers, []);
        const row = await Employee.collection.findOne({
          _id: legacyEmployeeId,
        });
        assert.ok(row.organizationId instanceof mongoose.Types.ObjectId);
        assert.ok(row.userId instanceof mongoose.Types.ObjectId);
        assert.equal(
          (await Org.findById(legacyOrgId)).ownerUserId,
          String(legacyUserId),
        );
        assert.equal(
          (
            await Membership.findOne({
              userId: legacyUserId,
              organizationId: legacyOrgId,
            })
          ).employeeId,
          String(legacyEmployeeId),
        );
        assert.equal(
          (await migrateTenants(mongoose.connection.db, Object.values(M)))
            .referenceUpdates,
          0,
        );
        const previousVersion = (await User.findById(legacyUserId))
          .credentialVersion;
        const reapplied = await migrateTenants(
          mongoose.connection.db,
          Object.values(M),
          { apply: true },
        );
        assert.deepEqual(reapplied.blockers, []);
        assert.equal(
          (await User.findById(legacyUserId)).credentialVersion,
          previousVersion,
        );
        const login = await request("/auth/login", null, "POST", {
          loginId: "legacy-admin",
          password,
          portal: "admin",
        });
        assert.equal(login.status, 200, JSON.stringify(login.body));
      },
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await Redis.close().catch(() => {});
  }
});
