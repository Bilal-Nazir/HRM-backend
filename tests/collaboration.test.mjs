import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import express from "express";
import sharp from "sharp";

const databaseName =
  "hrm_collaboration_test_" + randomUUID().replaceAll("-", "");
process.env.JWT_SESSION_PREFIX = databaseName;
process.env.DB_REDIS_URL =
  process.env.HRM_TEST_REDIS_URL || "redis://127.0.0.1:6383";
process.env.DB_REDIS_PASS = "";
const root = "../tmp/collaboration-test-build/src/";
const { default: registerRoutes } = await import(root + "routes/index.js");
const { Database: Redis } = await import(
  root + "node-base/baseClasses/Redis/index.js"
);
const { generateSessionTokens, revokeSession } = await import(
  root + "AuthModule/utils/session.js"
);
const { sendResponseObject } = await import(root + "node-base/utils/index.js");
const { defaultRoles } = await import(
  root + "AccessModule/utils/permissions.js"
);
const M = mongoose.models;

test(
  "private company chat, project mentions and detailed request review",
  { timeout: 60000 },
  async (t) => {
    let server;
    const sessions = [];
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
      async function request(path, actor, method = "GET", body) {
        const response = await fetch(base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(actor && { Authorization: `Bearer ${actor.accessToken}` }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      }
      async function user(name, platform = false) {
        return M.UserClass.create({
          loginId: name.toLowerCase(),
          name,
          email: `${name.toLowerCase()}@example.com`,
          isActive: true,
          isPlatformAdmin: platform,
        });
      }
      async function session(account, org) {
        const tokens = await generateSessionTokens({
          userId: account.id,
          organizationId: org?.id,
          permissions: [],
          accountType: "employee",
          credentialVersion: account.credentialVersion,
        });
        sessions.push(tokens);
        return { ...tokens, account, org };
      }
      async function company(name) {
        const owner = await user(name + "Owner");
        const org = await M.OrganizationClass.create({
          name,
          slug: name.toLowerCase(),
          ownerUserId: owner.id,
          status: "active",
          tenantSchemaVersion: 1,
        });
        return { org, owner: await session(owner, org) };
      }
      const a = await company("Alpha"),
        b = await company("Beta");
      async function staff(name, org = a.org, extraPermissions = []) {
        const account = await user(name),
          employee = await M.EmployeeClass.create({
            organizationId: org.id,
            userId: account.id,
            firstName: name,
            lastName: "Person",
            employeeCode: name,
            workEmail: `${name.toLowerCase()}@example.com`,
            employmentStatus: "active",
            phone: "PRIVATE_PHONE",
            personalEmail: "PRIVATE_EMAIL@example.com",
            metadata: { emergencyContact: "PRIVATE_CONTACT" },
          });
        await M.CompanyMembershipClass.create({
          organizationId: org.id,
          userId: account.id,
          employeeId: employee.id,
          status: "active",
        });
        const role = await M.RoleClass.create({
          organizationId: org.id,
          name: name + "Role",
          permissions: [...defaultRoles.employee, ...extraPermissions],
          status: "active",
        });
        await M.RoleAssignmentClass.create({
          organizationId: org.id,
          employeeId: employee.id,
          roleId: role.id,
          scopeType: "organization",
        });
        return { ...(await session(account, org)), employee };
      }
      const ben = await staff("Ben"),
        maya = await staff("Maya"),
        lead = await staff("Tim"),
        pm = await staff("Peter"),
        viewer = await staff("Victor"),
        unrelated = await staff("Uma", a.org, [
          "leave.manage",
          "leave.approve",
        ]),
        foreign = await staff("Omar", b.org);
      const platform = await session(await user("Platform", true), a.org);
      const team = await M.TeamClass.create({
        organizationId: a.org.id,
        name: "Core",
        leadEmployeeId: lead.employee.id,
        status: "active",
      });
      await M.EmployeeClass.updateOne(
        { _id: ben.employee.id },
        { $set: { teamId: team.id, managerEmployeeId: maya.employee.id } },
      );
      const project = await M.ProjectClass.create({
        organizationId: a.org.id,
        name: "Project Alpha",
        key: "ALPHA",
        createdBy: a.owner.account.id,
        managerEmployeeId: pm.employee.id,
        status: "active",
      });
      for (const [actor, role] of [
        [ben, "member"],
        [pm, "project_manager"],
        [viewer, "viewer"],
      ])
        await M.ProjectMemberClass.create({
          organizationId: a.org.id,
          projectId: project.id,
          employeeId: actor.employee.id,
          role,
          status: "active",
          addedBy: a.owner.account.id,
        });
      const leaveType = await M.LeaveTypeClass.create({
        organizationId: a.org.id,
        name: "Casual",
        code: "CL",
        annualAllowanceDays: 20,
        isPaid: true,
      });
      const leave = await M.LeaveRequestClass.create({
        organizationId: a.org.id,
        employeeId: ben.employee.id,
        leaveTypeId: leaveType.id,
        requestKind: "leave",
        startDate: new Date("2026-12-18"),
        endDate: new Date("2026-12-21"),
        totalDays: 4,
        reason: "Family wedding",
        managerComment: "Earlier remark",
        managerCommentedByEmployeeId: maya.employee.id,
        managerCommentedAt: new Date(),
      });
      let direct, group, directMessage, groupMessage;
      const send = (room, actor, body, other = {}) =>
        request(`/chat/conversations/${room}/messages`, actor, "POST", {
          body,
          clientMessageId: randomUUID(),
          ...other,
        });

      await t.test(
        "authentication, company scope and private directory fields",
        async () => {
          assert.equal((await request("/chat/inbox")).status, 401);
          const unscoped = await session(await user("Unscoped"));
          assert.equal((await request("/chat/inbox", unscoped)).status, 403);
          const result = await request("/chat/directory", ben);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert(
            result.body.data.people.some(
              (person) => person.userId === maya.account.id,
            ),
          );
          assert(
            !result.body.data.people.some(
              (person) =>
                person.userId === foreign.account.id ||
                person.userId === ben.account.id,
            ),
          );
          assert(!JSON.stringify(result.body).includes("PRIVATE_"));
          assert.equal(
            (
              await request("/chat/direct", ben, "POST", {
                userId: foreign.account.id,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request("/chat/direct", ben, "POST", {
                userId: ben.account.id,
              })
            ).status,
            422,
          );
        },
      );
      await t.test(
        "all account types can manage only their own photo; images are normalized and tenant scoped",
        async () => {
          const png = await sharp({
            create: {
              width: 12,
              height: 8,
              channels: 3,
              background: "#18aa88",
            },
          })
            .png()
            .withExif({ IFD0: { Artist: "Private source metadata" } })
            .toBuffer();
          const data = `data:image/png;base64,${png.toString("base64")}`;
          const accountOnly = await session(await user("ProfileOnly"));
          const platformOnly = await session(platform.account);
          for (const actor of [ben, a.owner, accountOnly, platformOnly]) {
            const updated = await request("/auth/profile/photo", actor, "PUT", {
              data,
              userId: foreign.account.id,
            });
            assert.equal(updated.status, 200, JSON.stringify(updated.body));
            assert.ok(updated.body.data.user.photoVersion);
            assert.ok(!JSON.stringify(updated.body).includes("photoData"));
            const profile = await request("/auth/profile", actor);
            assert.equal(profile.status, 200);
            assert.equal(profile.body.data.user.userId, actor.account.id);
            const response = await fetch(
              `${base}/auth/people/${actor.account.id}/photo`,
              { headers: { Authorization: `Bearer ${actor.accessToken}` } },
            );
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), "image/jpeg");
            assert.equal(
              response.headers.get("cache-control"),
              "private, no-store",
            );
            const metadata = await sharp(
              Buffer.from(await response.arrayBuffer()),
            ).metadata();
            assert.equal(metadata.width, 256);
            assert.equal(metadata.height, 256);
            assert.equal(metadata.exif, undefined);
          }
          const ordinary = await M.UserClass.findById(ben.account.id);
          assert.equal(ordinary.photoData, undefined);
          assert.equal(
            (await request(`/auth/people/${ben.account.id}/photo`, foreign))
              .status,
            404,
          );
          assert.equal(
            (await request(`/auth/people/${ben.account.id}/photo`, accountOnly))
              .status,
            404,
          );
          const shared = await fetch(
            `${base}/auth/people/${ben.account.id}/photo`,
            { headers: { Authorization: `Bearer ${maya.accessToken}` } },
          );
          assert.equal(shared.status, 200);
          await shared.arrayBuffer();
          for (const invalid of [
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            "data:image/png;base64,aGVsbG8=",
            "invalid",
          ]) {
            assert.equal(
              (
                await request("/auth/profile/photo", ben, "PUT", {
                  data: invalid,
                })
              ).status,
              422,
            );
          }
          assert.equal(
            (await request("/auth/profile/photo", null, "PUT", { data }))
              .status,
            401,
          );
          const directory = (await request("/chat/directory", maya)).body.data
            .people;
          assert.ok(
            directory.find((person) => person.userId === ben.account.id)
              .photoVersion,
          );
          assert.ok(!JSON.stringify(directory).includes("photoData"));
          assert.equal(
            (await request("/auth/profile/photo", ben, "DELETE")).status,
            200,
          );
          assert.equal(
            (await request(`/auth/people/${ben.account.id}/photo`, ben)).status,
            404,
          );
          assert.equal(
            (await M.UserClass.findById(foreign.account.id)).photoVersion,
            undefined,
          );
        },
      );
      await t.test(
        "direct chats are unique and private, including from admins",
        async () => {
          const [first, second] = await Promise.all([
            request("/chat/direct", ben, "POST", { userId: maya.account.id }),
            request("/chat/direct", maya, "POST", { userId: ben.account.id }),
          ]);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(second.status, 200, JSON.stringify(second.body));
          direct = first.body.data.conversationId;
          assert.equal(direct, second.body.data.conversationId);
          for (const actor of [unrelated, foreign, a.owner, platform])
            assert.equal(
              (await request(`/chat/conversations/${direct}`, actor)).status,
              404,
            );
          assert.equal(
            (await request("/chat/inbox", a.owner)).body.data.conversations
              .length,
            0,
          );
        },
      );
      await t.test(
        "delivery, safe retries, receipt counts and quoted replies",
        async () => {
          const key = randomUUID(),
            payload = { body: "Hello Maya", clientMessageId: key };
          const results = await Promise.all([
            request(
              `/chat/conversations/${direct}/messages`,
              ben,
              "POST",
              payload,
            ),
            request(
              `/chat/conversations/${direct}/messages`,
              ben,
              "POST",
              payload,
            ),
          ]);
          for (const result of results)
            assert.equal(result.status, 201, JSON.stringify(result.body));
          directMessage = results[0].body.data.message;
          assert.equal(directMessage.id, results[1].body.data.message.id);
          assert.equal(
            await M.ChatMessageClass.countDocuments({ conversationId: direct }),
            1,
          );
          assert.equal(
            (await request("/chat/inbox", maya)).body.data.unreadCount,
            1,
          );
          assert.equal(
            (await request("/chat/inbox", ben)).body.data.unreadCount,
            0,
          );
          assert.equal(
            (
              await request(
                `/chat/conversations/${direct}/messages`,
                ben,
                "POST",
                { ...payload, body: "Changed message" },
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await request(
                `/chat/conversations/${direct}/read`,
                unrelated,
                "PATCH",
                { messageIds: [directMessage.id] },
              )
            ).status,
            404,
          );
          await request(`/chat/conversations/${direct}/read`, maya, "PATCH", {
            messageIds: [directMessage.id],
          });
          assert.equal(
            (await request("/chat/inbox", maya)).body.data.unreadCount,
            0,
          );
          assert.equal(
            (await request(`/chat/conversations/${direct}/messages`, ben)).body
              .data.messages[0].readCount,
            1,
          );
          const reply = await send(direct, maya, "Thanks", {
            replyToMessageId: directMessage.id,
          });
          assert.equal(reply.status, 201, JSON.stringify(reply.body));
          assert.equal(reply.body.data.message.replyTo.body, "Hello Maya");
        },
      );
      await t.test(
        "project groups enforce membership and validate mention recipients",
        async () => {
          const result = await request(
            `/chat/projects/${project.id}`,
            ben,
            "POST",
          );
          assert.equal(result.status, 200, JSON.stringify(result.body));
          group = result.body.data.conversationId;
          assert.equal(
            (await request(`/chat/projects/${project.id}`, pm, "POST")).body
              .data.conversationId,
            group,
          );
          assert.equal(
            (await request(`/chat/projects/${project.id}`, unrelated, "POST"))
              .status,
            404,
          );
          assert.equal(
            (await request(`/chat/conversations/${group}/messages`, foreign))
              .status,
            404,
          );
          assert.equal(
            (
              await send(group, ben, "Hi @Omar Person", {
                mentionedUserIds: [foreign.account.id],
              })
            ).status,
            422,
          );
          assert.equal(
            (
              await send(group, ben, "No mention here", {
                mentionedUserIds: [pm.account.id],
              })
            ).status,
            422,
          );
          const message = await send(
            group,
            ben,
            "Please review @Peter Person",
            { mentionedUserIds: [pm.account.id] },
          );
          assert.equal(message.status, 201, JSON.stringify(message.body));
          groupMessage = message.body.data.message;
          const inbox = (await request("/chat/inbox", pm)).body.data;
          assert.equal(inbox.mentionCount, 1);
          assert.equal(inbox.unreadConversations, 1);
          assert.equal(
            (
              await request(
                `/chat/conversations/${group}/messages?mentions=1`,
                pm,
              )
            ).body.data.messages.length,
            1,
          );
          assert.equal(
            (
              await request(
                `/chat/conversations/${group}/messages?mentions=1`,
                viewer,
              )
            ).body.data.messages.length,
            0,
          );
          assert.equal(
            (await request(`/chat/conversations/${group}`, viewer)).body.data
              .conversation.isReadOnly,
            true,
          );
          assert.equal((await send(group, viewer, "Not allowed")).status, 403);
          assert.equal(
            (
              await send(group, ben, "Wrong reply", {
                replyToMessageId: directMessage.id,
              })
            ).status,
            422,
          );
          await request(`/chat/conversations/${group}/read`, pm, "PATCH", {
            messageIds: [groupMessage.id],
          });
          assert.equal(
            (await request("/chat/inbox", pm)).body.data.mentionCount,
            0,
          );
        },
      );
      await t.test(
        "pagination has no duplicate messages and cannot use foreign cursors",
        async () => {
          for (let index = 0; index < 6; index++)
            assert.equal(
              (await send(direct, ben, `Message ${index}`)).status,
              201,
            );
          const latest = (
            await request(`/chat/conversations/${direct}/messages?size=3`, maya)
          ).body.data;
          assert.equal(latest.messages.length, 3);
          assert.equal(latest.hasMore, true);
          const older = (
            await request(
              `/chat/conversations/${direct}/messages?size=3&before=${latest.messages[0].id}`,
              maya,
            )
          ).body.data;
          assert.equal(older.messages.length, 3);
          assert(
            !older.messages.some((message) =>
              latest.messages.some((recent) => recent.id === message.id),
            ),
          );
          const forward = (
            await request(
              `/chat/conversations/${direct}/messages?size=3&after=${directMessage.id}`,
              maya,
            )
          ).body.data;
          assert.equal(forward.messages.length, 3);
          assert.equal(forward.hasMore, true);
          assert(
            !forward.messages.some(
              (message) => message.id === directMessage.id,
            ),
          );
          assert.equal(
            (
              await request(
                `/chat/conversations/${direct}/messages?before=${groupMessage.id}`,
                maya,
              )
            ).status,
            422,
          );
          await request(`/chat/conversations/${direct}/read`, maya, "PATCH", {
            messageIds: [groupMessage.id],
          });
          assert(
            (await request("/chat/inbox", maya)).body.data.unreadCount > 0,
          );
          await request(
            `/chat/conversations/${direct}/read-all`,
            maya,
            "PATCH",
          );
          assert.equal(
            (await request("/chat/inbox", maya)).body.data.unreadCount,
            0,
          );
        },
      );
      await t.test(
        "requesters, admins, direct managers, team leads and project managers can inspect details",
        async () => {
          for (const actor of [ben, a.owner, platform, maya, lead, pm]) {
            const result = await request(`/leave/requests/${leave.id}`, actor);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.data.request.reason, "Family wedding");
            assert.equal(result.body.data.request.employee.name, "Ben Person");
            assert.equal(
              result.body.data.permissions.canReview,
              actor === a.owner || actor === platform,
            );
            assert(!JSON.stringify(result.body).includes("PRIVATE_"));
          }
          for (const actor of [unrelated, foreign, b.owner, viewer])
            assert.equal(
              (await request(`/leave/requests/${leave.id}`, actor)).status,
              404,
            );
          const queue = await request("/leave/requests/pending", lead);
          assert.equal(queue.status, 200);
          assert(
            queue.body.data.leaveRequests.some(
              (item) =>
                item.id === leave.id && item.employee.name === "Ben Person",
            ),
          );
          assert.equal(
            (await request("/leave/requests/manage", unrelated)).body.data
              .leaveRequests.length,
            0,
          );
        },
      );
      await t.test(
        "comments append without overwriting old remarks and notify the review participants",
        async () => {
          for (const [actor, body] of [
            [maya, "Manager context"],
            [lead, "Team lead context"],
            [a.owner, "Admin question"],
            [ben, "Employee clarification"],
          ]) {
            const result = await request(
              `/leave/requests/${leave.id}/comments`,
              actor,
              "POST",
              { body },
            );
            assert.equal(result.status, 201, JSON.stringify(result.body));
          }
          assert.equal(
            (
              await request(
                `/leave/requests/${leave.id}/comments`,
                unrelated,
                "POST",
                { body: "No access" },
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await request(
                `/leave/requests/${leave.id}/comments`,
                maya,
                "POST",
                { body: " " },
              )
            ).status,
            422,
          );
          const details = (await request(`/leave/requests/${leave.id}`, ben))
            .body.data;
          assert.equal(details.comments.length, 5);
          assert(
            details.comments.some(
              (comment) => comment.body === "Earlier remark",
            ),
          );
          const notice = await M.NotificationClass.findOne({
            recipientUserId: ben.account.id,
            type: "leave.comment",
          });
          assert.equal(notice.href, `/leave/${leave.id}`);
        },
      );
      await t.test(
        "only a real company admin or Super Admin can give the final decision",
        async () => {
          for (const actor of [ben, maya, lead, pm, unrelated])
            assert.equal(
              (
                await request(
                  `/leave/requests/${leave.id}/review`,
                  actor,
                  "PATCH",
                  { status: "approved" },
                )
              ).status,
              403,
            );
          assert.equal(
            (await M.LeaveRequestClass.findById(leave.id)).status,
            "pending",
          );
          const result = await request(
            `/leave/requests/${leave.id}/review`,
            a.owner,
            "PATCH",
            { status: "approved", comment: "Approved for the wedding" },
          );
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const saved = await M.LeaveRequestClass.findById(leave.id);
          assert.equal(saved.reviewedByUserId, a.owner.account.id);
          const details = (await request(`/leave/requests/${leave.id}`, lead))
            .body.data;
          assert.equal(details.permissions.canReview, false);
          assert(
            details.history.some(
              (item) =>
                item.action === "approved" &&
                item.body === "Approved for the wedding",
            ),
          );
          assert(
            [404, 409].includes(
              (
                await request(
                  `/leave/requests/${leave.id}/review`,
                  platform,
                  "PATCH",
                  { status: "rejected" },
                )
              ).status,
            ),
          );
          assert.equal(
            (
              await request(
                `/leave/requests/${leave.id}/comments`,
                lead,
                "POST",
                { body: "Handover arranged" },
              )
            ).status,
            201,
          );
        },
      );
      await t.test(
        "company admins and Super Admins can initiate inbox messages and employees can reply",
        async () => {
          for (const admin of [a.owner, platform]) {
            const started = await request("/chat/direct", admin, "POST", {
              userId: ben.account.id,
            });
            assert.equal(started.status, 200, JSON.stringify(started.body));
            const room = started.body.data.conversationId;
            assert.equal(
              (await send(room, admin, "Please check your inbox")).status,
              201,
            );
            const details = await request(`/chat/conversations/${room}`, ben);
            assert.equal(details.status, 200);
            assert.equal(details.body.data.conversation.isReadOnly, false);
            assert.equal(
              details.body.data.conversation.otherUserId,
              admin.account.id,
            );
            assert.equal(
              (await send(room, ben, "I can reply to the admin")).status,
              201,
            );
            assert.equal(
              (await request(`/chat/conversations/${room}`, unrelated)).status,
              404,
            );
          }
        },
      );
      await t.test(
        "revoked project/team access immediately removes conversation and request access",
        async () => {
          await M.ProjectMemberClass.updateOne(
            { projectId: project.id, employeeId: ben.employee.id },
            { $set: { status: "removed" } },
          );
          assert.equal(
            (await request(`/chat/conversations/${group}`, ben)).status,
            404,
          );
          assert(
            !(await request("/chat/inbox", ben)).body.data.conversations.some(
              (row) => row.id === group,
            ),
          );
          await M.TeamClass.updateOne(
            { _id: team.id },
            { $set: { status: "archived" } },
          );
          assert.equal(
            (await request(`/leave/requests/${leave.id}`, lead)).status,
            404,
          );
          await M.ProjectClass.updateOne(
            { _id: project.id },
            { $set: { status: "archived" } },
          );
          assert.equal((await send(group, pm, "Archived")).status, 409);
          await M.CompanyMembershipClass.updateOne(
            { organizationId: a.org.id, userId: ben.account.id },
            { $set: { status: "suspended" } },
          );
          assert.equal(
            (await send(direct, maya, "Unavailable person")).status,
            409,
          );
        },
      );
    } finally {
      for (const session of sessions)
        await revokeSession(session.accessToken, session.refreshToken).catch(
          () => {},
        );
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (mongoose.connection.readyState === 1)
        await mongoose.connection.dropDatabase();
      await Promise.all([mongoose.disconnect(), Redis.close()]);
    }
  },
);
