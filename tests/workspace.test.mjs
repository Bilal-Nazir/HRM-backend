import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import express from "express";
import "dotenv/config";

// Never use the application database or Redis session namespace.
const databaseName = "hrm_workspace_test_" + randomUUID().replaceAll("-", "");
process.env.JWT_SESSION_PREFIX = databaseName;
process.env.DB_REDIS_URL =
  process.env.HRM_TEST_REDIS_URL ||
  process.env.DB_REDIS_URL ||
  "redis://127.0.0.1:6379";
const root = "../tmp/workspace-test-build/src/";
const { default: registerRoutes } = await import(root + "routes/index.js");
const { Database: Redis } = await import(
  root + "node-base/baseClasses/Redis/index.js"
);
const { sendResponseObject } = await import(root + "node-base/utils/index.js");
const { default: User } = await import(root + "AuthModule/models/User.js");
const { default: Employee } = await import(
  root + "EmployeeModule/models/Employee.js"
);
const { default: Organization } = await import(
  root + "OrganizationModule/models/Organization.js"
);
const { default: Terms } = await import(root + "TermsModule/models/Terms.js");
const { default: Announcement } = await import(
  root + "AnnouncementModule/models/Announcement.js"
);
const { default: LeaveType } = await import(
  root + "LeaveModule/models/LeaveType.js"
);
const { default: Attendance } = await import(
  root + "AttendanceModule/models/Attendance.js"
);
const { ensureDefaultLeaveTypes } = await import(
  root + "database/scripts/createDefaultLeaveTypesScript.js"
);
const { hashPassword, verifyPassword } = await import(
  root + "AuthModule/utils/password.js"
);
const { generateSessionTokens, revokeUserSessions } = await import(
  root + "AuthModule/utils/session.js"
);

test("workspace APIs, organization boundaries, password changes and attendance", async (t) => {
  let server;
  const users = [];
  try {
    await mongoose.connect(
      process.env.HRM_TEST_MONGO_URI ||
        process.env.DB_MONGO_URI ||
        "mongodb://127.0.0.1:27017",
      { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
    );
    await Redis.initialize();
    await Promise.all([User.init(), Terms.init(), Announcement.init()]);
    const org = await Organization.create({
      name: "Test office",
      slug: "test-office",
      timezone: "UTC",
    });
    const otherOrg = await Organization.create({
      name: "Other office",
      slug: "other-office",
      timezone: "UTC",
    });
    const password = "Initial-test-password-42";
    async function account(
      loginId,
      organizationId,
      permissions,
      platform = false,
    ) {
      const user = await User.create({
        organizationId,
        loginId,
        passwordHash: await hashPassword(password),
        isActive: true,
        isPlatformAdmin: platform,
      });
      users.push(user);
      const employee = await Employee.create({
        organizationId,
        userId: user.id,
        employeeCode: loginId,
        firstName: "Test",
        lastName: "Person",
        workEmail: loginId + "@example.test",
        employmentStatus: "active",
      });
      const payload = {
        userId: user.id,
        employeeId: employee.id,
        organizationId,
        permissions,
        credentialVersion: 0,
      };
      return { user, payload, ...(await generateSessionTokens(payload)) };
    }
    const admin = await account("admin-test", org.id, ["*"], true);
    const employee = await account("employee-test", org.id, [
      "attendance.checkin",
      "attendance.read.self",
      "leave.read.self",
      "leave.request",
    ]);
    const other = await account("other-test", otherOrg.id, ["*"], true);
    const unscoped = await generateSessionTokens({
      userId: admin.user.id,
      permissions: ["*"],
    });
    const app = express();
    app.use(express.json());
    registerRoutes(app);
    app.use((error, _req, res, _next) =>
      sendResponseObject({
        res,
        code: error.statusCode || 500,
        message: error.message,
        data: error.data || {},
      }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    async function request(path, session, method = "GET", data) {
      const response = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(session
            ? { Authorization: "Bearer " + session.accessToken }
            : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      const body = await response.json();
      assert.equal(body.code, response.status);
      assert.equal(body.success, response.ok);
      return { status: response.status, body };
    }
    await t.test(
      "authentication and permissions reject employee writes and unscoped accounts",
      async () => {
        assert.equal((await request("/terms")).status, 401);
        assert.equal((await request("/announcements")).status, 401);
        assert.equal((await request("/terms", unscoped)).status, 403);
        assert.equal(
          (
            await request("/terms", employee, "PATCH", {
              title: "Policy",
              content: "Text",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/announcements", employee, "POST", {
              title: "News",
              content: "Text",
              status: "published",
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/announcements/manage", employee)).status,
          403,
        );
        assert.equal(
          (await request("/auth/change-password", null, "POST", {})).status,
          401,
        );
      },
    );
    await t.test(
      "terms persist, can be edited and are visible only in their organization",
      async () => {
        assert.equal((await request("/terms", employee)).body.data.terms, null);
        assert.equal(
          (
            await request("/terms", admin, "PATCH", {
              title: " ",
              content: " ",
            })
          ).status,
          422,
        );
        const saved = await request("/terms", admin, "PATCH", {
          title: "Office terms",
          content: "Be respectful.\nKeep data secure.",
          organizationId: otherOrg.id,
        });
        assert.equal(saved.status, 200);
        const read = await request("/terms", employee);
        assert.equal(
          read.body.data.terms.content,
          "Be respectful.\nKeep data secure.",
        );
        assert.equal((await request("/terms", other)).body.data.terms, null);
        await request("/terms", admin, "PATCH", {
          title: "Updated policy",
          content: "Updated terms.",
        });
        assert.equal(await Terms.countDocuments({ organizationId: org.id }), 1);
        assert.equal(
          (await request("/terms", employee)).body.data.terms.title,
          "Updated policy",
        );
      },
    );
    let announcementId;
    await t.test(
      "draft/published/archived lifecycle, pagination and tenant-safe editing",
      async () => {
        const created = await request("/announcements", admin, "POST", {
          title: "Office news",
          content: "Friday update",
          status: "draft",
          organizationId: otherOrg.id,
        });
        assert.equal(created.status, 201);
        announcementId = created.body.data.announcement.id;
        assert.equal(
          (await request("/announcements", employee)).body.data.totalCount,
          0,
        );
        assert.equal(
          (await request("/announcements/manage", admin)).body.data.totalCount,
          1,
        );
        const update = {
          title: "Office news",
          content: "Friday update",
          status: "published",
        };
        assert.equal(
          (
            await request(
              "/announcements/" + announcementId,
              employee,
              "PATCH",
              update,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/announcements/" + announcementId,
              other,
              "PATCH",
              update,
            )
          ).status,
          404,
        );
        assert.equal(
          (await request("/announcements/invalid", admin, "PATCH", update))
            .status,
          422,
        );
        assert.equal(
          (
            await request("/announcements/" + announcementId, admin, "PATCH", {
              ...update,
              status: "invalid",
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await request(
              "/announcements/" + announcementId,
              admin,
              "PATCH",
              update,
            )
          ).status,
          200,
        );
        assert.equal(
          (await request("/announcements?size=1", employee)).body.data
            .announcements[0].id,
          announcementId,
        );
        assert.equal(
          (await request("/announcements", other)).body.data.totalCount,
          0,
        );
        await request("/announcements/" + announcementId, admin, "PATCH", {
          ...update,
          status: "archived",
        });
        assert.equal(
          (await request("/announcements?status=archived", employee)).body.data
            .totalCount,
          0,
        );
        assert.equal(
          (await request("/announcements/manage", admin)).body.data
            .announcements[0].status,
          "archived",
        );
      },
    );
    await t.test(
      "check-in/out uses the existing API and persists captured location",
      async () => {
        const location = {
          latitude: 31.5,
          longitude: 74.3,
          accuracyMeters: 20,
        };
        assert.equal(
          (await request("/attendance/check-in", employee, "POST", {})).status,
          422,
        );
        assert.equal(
          (await request("/attendance/check-in", employee, "POST", location))
            .status,
          201,
        );
        assert.equal(
          (await request("/attendance/check-in", employee, "POST", location))
            .status,
          409,
        );
        assert.equal(
          (await request("/attendance/history", employee)).body.data
            .attendances[0].checkInLocation.latitude,
          location.latitude,
        );
        const current = await request(
          "/attendance/manage?open=true&size=1",
          admin,
        );
        assert.equal(current.status, 200);
        assert.equal(current.body.data.summary.presentNow, 1);
        assert.equal(
          current.body.data.attendances[0].employee.employeeCode,
          "employee-test",
        );
        assert.equal(
          (await request("/attendance/manage", employee)).status,
          403,
        );
        assert.equal(
          (await request("/attendance/manage", unscoped)).status,
          403,
        );
        assert.equal(
          (await request("/attendance/manage", other)).body.data.summary
            .presentNow,
          0,
        );
        assert.equal(
          (await request("/attendance/check-out", employee, "POST", location))
            .status,
          200,
        );
        assert.ok(
          (await request("/attendance/history", employee)).body.data
            .attendances[0].checkOutAt,
        );
        assert.equal(
          (await request("/attendance/manage?open=true", admin)).body.data
            .summary.presentNow,
          0,
        );
        await Attendance.insertMany(
          Array.from({ length: 7 }, (_, index) => ({
            organizationId: org.id,
            employeeId: new mongoose.Types.ObjectId().toString(),
            checkInLocation: {
              latitude: 31.5,
              longitude: 74.3,
              accuracyMeters: 20,
              capturedAt: new Date(),
            },
            checkInAt: new Date(),
            workDate: "2026-10-08",
            status: index === 0 ? "flagged" : "open",
            checkInWithinGeofence: index === 0 ? false : undefined,
          })),
        );
        const paginated = (
          await request("/attendance/manage?open=true&size=2", admin)
        ).body.data;
        assert.equal(paginated.attendances.length, 2);
        assert.equal(paginated.totalCount, 7);
        assert.equal(paginated.summary.presentNow, 7);
        assert.equal(paginated.summary.attendanceFlags, 1);
      },
    );
    await t.test(
      "default leave types, submission, admin notifications and review are tenant scoped",
      async () => {
        await Promise.all([
          ensureDefaultLeaveTypes(org.id),
          ensureDefaultLeaveTypes(org.id),
          ensureDefaultLeaveTypes(otherOrg.id),
        ]);
        let types = (await request("/leave/types", employee)).body.data
          .leaveTypes;
        assert.deepEqual(types.map((item) => item.name).sort(), [
          "Casual",
          "Formal",
          "Sick",
        ]);
        const sick = types.find((item) => item.name === "Sick");
        await LeaveType.updateOne(
          { _id: sick.id },
          { $set: { annualAllowanceDays: 12 } },
        );
        await ensureDefaultLeaveTypes(org.id);
        assert.equal(
          await LeaveType.countDocuments({ organizationId: org.id }),
          3,
        );
        assert.equal(
          (await LeaveType.findById(sick.id)).annualAllowanceDays,
          12,
        );
        const foreignType = await LeaveType.findOne({
          organizationId: otherOrg.id,
        });
        const body = {
          leaveTypeId: sick.id,
          startDate: "2026-11-10",
          endDate: "2026-11-11",
          reason: "Not feeling well",
          totalDays: 99,
        };
        assert.equal(
          (
            await request("/leave/requests", employee, "POST", {
              ...body,
              leaveTypeId: foreignType.id,
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await request("/leave/requests", employee, "POST", {
              ...body,
              endDate: "2026-11-09",
            })
          ).status,
          422,
        );
        const saved = await request("/leave/requests", employee, "POST", body);
        assert.equal(saved.status, 201, JSON.stringify(saved.body));
        assert.equal(saved.body.data.leaveRequest.totalDays, 2);
        assert.equal(saved.body.data.leaveRequest.status, "pending");
        assert.equal(
          (await request("/leave/requests", employee, "POST", body)).status,
          409,
        );
        const pending = (
          await request("/leave/requests/manage?status=pending&size=1", admin)
        ).body.data;
        assert.equal(pending.totalCount, 1);
        assert.equal(
          pending.leaveRequests[0].employee.employeeCode,
          "employee-test",
        );
        assert.equal(pending.leaveRequests[0].leaveTypeName, "Sick");
        assert.equal(
          (await request("/leave/requests/pending", admin)).body.data
            .leaveRequests.length,
          1,
        );
        assert.equal(
          (await request("/leave/requests/manage", employee)).status,
          403,
        );
        assert.equal(
          (await request("/leave/requests/manage", unscoped)).status,
          403,
        );
        assert.equal(
          (await request("/leave/requests/manage", other)).body.data.totalCount,
          0,
        );
        const url =
          "/leave/requests/" + saved.body.data.leaveRequest.id + "/review";
        assert.equal(
          (await request(url, employee, "PATCH", { status: "approved" }))
            .status,
          403,
        );
        assert.equal(
          (await request(url, other, "PATCH", { status: "approved" })).status,
          404,
        );
        assert.equal(
          (await request(url, admin, "PATCH", { status: "approved" })).status,
          200,
        );
        assert.equal(
          (await request("/leave/requests/manage?status=pending", admin)).body
            .data.totalCount,
          0,
        );
        assert.equal(
          (await request("/leave/requests/history", employee)).body.data
            .leaveRequests[0].status,
          "approved",
        );
        assert.equal(
          (await request(url, admin, "PATCH", { status: "rejected" })).status,
          404,
        );
      },
    );
    await t.test(
      "password validation, hashing, old-session invalidation and new login for both roles",
      async () => {
        for (const session of [employee, admin]) {
          const secondSession = await generateSessionTokens(session.payload);
          const newPassword = " Changed-test-password-43 ";
          const change = {
            currentPassword: password,
            newPassword,
            confirmPassword: newPassword,
          };
          assert.equal(
            (
              await request("/auth/change-password", session, "POST", {
                ...change,
                currentPassword: "incorrect",
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await request("/auth/change-password", session, "POST", {
                ...change,
                confirmPassword: "mismatch",
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await request("/auth/change-password", session, "POST", {
                ...change,
                newPassword: "short",
                confirmPassword: "short",
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await request("/auth/change-password", session, "POST", {
                ...change,
                newPassword: password,
                confirmPassword: password,
              })
            ).status,
            422,
          );
          assert.equal(
            (await request("/auth/change-password", session, "POST", change))
              .status,
            200,
          );
          const saved = await User.findById(session.user.id).select(
            "+passwordHash",
          );
          assert.equal(saved.credentialVersion, 1);
          assert.notEqual(saved.passwordHash, newPassword);
          assert.ok(await verifyPassword(newPassword, saved.passwordHash));
          assert.equal(
            await verifyPassword(password, saved.passwordHash),
            false,
          );
          assert.equal((await request("/terms", session)).status, 401);
          assert.equal((await request("/terms", secondSession)).status, 401);
          assert.equal(
            (
              await request("/auth/refresh", null, "POST", {
                refreshToken: secondSession.refreshToken,
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await request("/auth/login", null, "POST", {
                loginId: session.user.loginId,
                password,
                organizationSlug: "test-office",
              })
            ).status,
            401,
          );
          const login = await request("/auth/login", null, "POST", {
            loginId: session.user.loginId,
            password: newPassword,
            organizationSlug: "test-office",
          });
          assert.equal(login.status, 200);
          assert.equal(login.body.data.user.passwordHash, undefined);
          assert.equal((await request("/terms", login.body.data)).status, 200);
          // Simulate a stale token reinserted after cleanup: version check still rejects it.
          const stale = await generateSessionTokens(session.payload);
          assert.equal((await request("/terms", stale)).status, 401);
          assert.equal(
            (
              await request("/auth/refresh", null, "POST", {
                refreshToken: stale.refreshToken,
              })
            ).status,
            401,
          );
        }
      },
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const user of users) await revokeUserSessions(user.id).catch(() => {});
    await Redis.close();
    if (mongoose.connection.readyState === 1) {
      assert.equal(mongoose.connection.name, databaseName);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});
