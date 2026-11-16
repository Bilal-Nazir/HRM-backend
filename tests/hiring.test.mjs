import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import express from "express";

const databaseName = "hrm_hiring_test_" + randomUUID().replaceAll("-", "");
process.env.JWT_SESSION_PREFIX = databaseName;
process.env.DB_REDIS_URL =
  process.env.HRM_TEST_REDIS_URL || "redis://127.0.0.1:6383";
process.env.DB_REDIS_PASS = "";
const root = "../tmp/hiring-test-build/src/";
const { default: registerRoutes } = await import(root + "routes/index.js");
const { Database: Redis } = await import(
  root + "node-base/baseClasses/Redis/index.js"
);
const { generateSessionTokens, revokeSession } = await import(
  root + "AuthModule/utils/session.js"
);
const { sendResponseObject } = await import(root + "node-base/utils/index.js");
const { cvInput, MAX_CV_BYTES } = await import(
  root + "HiringModule/validation.js"
);
const M = mongoose.models;
const cv = {
  name: "Sam CV.pdf",
  data: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF").toString(
    "base64",
  ),
};

test("CV validation rejects disguised, malformed and oversized files", () => {
  assert.equal(cvInput(cv).cvType, "application/pdf");
  assert.equal(
    cvInput({
      name: "cv.doc",
      data: Buffer.from("d0cf11e0a1b11ae100000000", "hex").toString("base64"),
    }).cvType,
    "application/msword",
  );
  for (const input of [
    {
      name: "cv.pdf",
      data: Buffer.from("<script>alert(1)</script>").toString("base64"),
    },
    { name: "cv.html", data: cv.data },
    { name: "cv.docx", data: "YQ==" },
    { name: "cv.pdf", data: "%%%" },
    { name: "cv.pdf", data: Buffer.alloc(MAX_CV_BYTES + 1).toString("base64") },
  ])
    assert.throws(() => cvInput(input));
});

test(
  "Hiring publishing, private applicant review and company isolation",
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
      app.use(express.json({ limit: "12mb" }));
      registerRoutes(app);
      app.use((error, _req, res, _next) =>
        sendResponseObject({
          res,
          code: error.statusCode || 500,
          message: error.message,
          data: {},
          success: false,
        }),
      );
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      async function request(path, actor, method = "GET", body) {
        const res = await fetch(base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(actor && { Authorization: `Bearer ${actor.accessToken}` }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      }
      async function account(name, platform = false) {
        return M.UserClass.create({
          loginId: name,
          name,
          email: `${name}@example.com`,
          isActive: true,
          isPlatformAdmin: platform,
        });
      }
      async function session(user, organization) {
        const tokens = await generateSessionTokens({
          userId: user.id,
          organizationId: organization.id,
          permissions: [],
          accountType: "employee",
          credentialVersion: user.credentialVersion,
        });
        sessions.push(tokens);
        return tokens;
      }
      async function company(name) {
        const owner = await account(name + "Owner"),
          org = await M.OrganizationClass.create({
            name,
            slug: name.toLowerCase(),
            ownerUserId: owner.id,
            status: "active",
            tenantSchemaVersion: 1,
          });
        return { owner, org, token: await session(owner, org) };
      }
      const alpha = await company("Alpha"),
        beta = await company("Beta"),
        person = await account("Employee");
      const employee = await M.EmployeeClass.create({
        organizationId: alpha.org.id,
        userId: person.id,
        firstName: "Team",
        lastName: "Member",
        employeeCode: "E-1",
        workEmail: person.email,
        employmentStatus: "active",
      });
      await M.CompanyMembershipClass.create({
        organizationId: alpha.org.id,
        userId: person.id,
        employeeId: employee.id,
        status: "active",
      });
      const staff = await session(person, alpha.org),
        platform = await session(await account("SuperAdmin", true), alpha.org);
      let page, applicationId;
      const edit = (body) =>
        request(`/hiring/pages/${page.id}`, alpha.token, "PATCH", body);
      const submit = (body) =>
        request(`/careers/${page.publicId}/applications`, null, "POST", body);
      const application = () => ({
        name: "Sam Applicant",
        email: "sam@example.com",
        phone: "01234567",
        consent: true,
        coverLetter: "I would like to apply",
        answers: { [page.questions[0].id]: "2 weeks" },
        cv,
      });

      await t.test(
        "only admins can create and drafts are not public",
        async () => {
          assert.equal((await request("/hiring/pages", null)).status, 401);
          assert.equal(
            (
              await request("/hiring/pages", staff, "POST", {
                title: "Engineer",
              })
            ).status,
            403,
          );
          const created = await request("/hiring/pages", alpha.token, "POST", {
            title: "Frontend Engineer",
            description: "## Responsibilities\n- Build interfaces",
            questions: [{ label: "Notice period?", required: true }],
            organizationId: beta.org.id,
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          page = created.body.data.page;
          assert.equal(page.status, "draft");
          assert.equal(
            (await request(`/careers/${page.publicId}`, null)).status,
            404,
          );
          assert.equal((await submit(application())).status, 404);
          assert.equal(
            (await request(`/hiring/pages/${page.id}`, beta.token)).status,
            404,
          );
          assert.equal(
            (await request("/hiring/pages", platform)).body.data.pages.length,
            1,
          );
        },
      );
      await t.test(
        "published page is anonymous, branded and omits internal data",
        async () => {
          const result = await edit({
            status: "published",
            accentColor: "#3056b5",
          });
          assert.equal(result.status, 200);
          page = result.body.data.page;
          const publicResult = await request(`/careers/${page.publicId}`, null);
          assert.equal(publicResult.status, 200);
          assert.equal(publicResult.body.data.page.companyName, "Alpha");
          assert.equal(publicResult.body.data.page.accentColor, "#3056b5");
          for (const field of [
            "organizationId",
            "ownerUserId",
            "createdBy",
            "id",
            "applications",
            "cvData",
          ])
            assert.equal(publicResult.body.data.page[field], undefined);
          assert.equal((await edit({ accentColor: "url(x)" })).status, 422);
        },
      );
      await t.test(
        "required answers, consent, contact and CV are validated",
        async () => {
          for (const changes of [
            { consent: false },
            { email: "bad" },
            { answers: {} },
            { cv: { name: "evil.pdf", data: "PHNjcmlwdD4=" } },
            { website: "spam" },
          ])
            assert.equal(
              (await submit({ ...application(), ...changes })).status,
              422,
            );
          const [one, two] = await Promise.all([
            submit(application()),
            submit(application()),
          ]);
          assert.equal(one.status, 200, JSON.stringify(one.body));
          assert.equal(two.status, 200);
          assert.deepEqual(one.body.data, { received: true });
          assert.equal(await M.HiringApplicationClass.countDocuments(), 1);
          const stored = await M.HiringApplicationClass.collection.findOne({});
          assert(stored.organizationId instanceof mongoose.Types.ObjectId);
          assert(stored.pageId instanceof mongoose.Types.ObjectId);
          const notifs = await M.NotificationClass.find({
            type: "hiring_application",
          });
          assert.equal(notifs.length, 1);
          assert.equal(notifs[0].recipientUserId, alpha.owner.id);
          assert.match(
            notifs[0].href,
            /^\/settings\/hiring\?page=.+&application=/,
          );
        },
      );
      await t.test(
        "admin can search, review and retrieve CV, other companies and employees cannot",
        async () => {
          const list = await request(
            `/hiring/applications?pageId=${page.id}&search=SAM`,
            alpha.token,
          );
          assert.equal(list.body.data.total, 1);
          const row = list.body.data.applications[0];
          applicationId = row.id;
          assert.equal(row.cvData, undefined);
          assert.equal(row.notes, undefined);
          assert.equal(
            (
              await request(
                `/hiring/applications?pageId=${page.id}&search=[`,
                alpha.token,
              )
            ).body.data.total,
            0,
          );
          assert.equal(
            (await request(`/hiring/applications/${applicationId}`, beta.token))
              .status,
            404,
          );
          assert.equal(
            (await request(`/hiring/applications/${applicationId}`, staff))
              .status,
            403,
          );
          assert.equal(
            (await request(`/hiring/applications/${applicationId}/cv`, null))
              .status,
            401,
          );
          assert.equal(
            (
              await request(
                `/hiring/applications/${applicationId}/cv`,
                beta.token,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await request(
                `/careers/${page.publicId}/applications/${applicationId}`,
                null,
              )
            ).status,
            404,
          );
          const updated = await request(
            `/hiring/applications/${applicationId}`,
            alpha.token,
            "PATCH",
            {
              status: "shortlisted",
              notes: "Schedule technical interview",
              organizationId: beta.org.id,
            },
          );
          assert.equal(updated.status, 200);
          assert.equal(updated.body.data.application.status, "shortlisted");
          const detail = (
            await request(`/hiring/applications/${applicationId}`, platform)
          ).body.data.application;
          assert.equal(detail.notes, "Schedule technical interview");
          assert.equal(detail.answers[0].label, "Notice period?");
          assert.equal(detail.cvData, undefined);
          assert.equal(
            (
              await request(
                `/hiring/applications/${applicationId}`,
                alpha.token,
                "PATCH",
                { status: "invalid" },
              )
            ).status,
            422,
          );
          const file = await fetch(
            `${base}/hiring/applications/${applicationId}/cv`,
            { headers: { Authorization: `Bearer ${alpha.token.accessToken}` } },
          );
          assert.equal(file.status, 200);
          assert.equal(file.headers.get("content-type"), "application/pdf");
          assert.match(file.headers.get("content-disposition"), /^inline;/);
          assert.match(file.headers.get("cache-control"), /no-store/);
          assert.deepEqual(
            Buffer.from(await file.arrayBuffer()),
            Buffer.from(cv.data, "base64"),
          );
          assert.equal(
            (
              await request(
                `/hiring/applications?pageId=${page.id}&status=shortlisted`,
                alpha.token,
              )
            ).body.data.total,
            1,
          );
          assert.equal(
            (await request(`/hiring/pages`, beta.token)).body.data.pages.length,
            0,
          );
          const pages = (await request("/hiring/pages", alpha.token)).body.data
            .pages;
          assert.equal(pages[0].applicants, 1);
          assert.equal(pages[0].newApplicants, 0);
        },
      );
      await t.test(
        "closed, archived and suspended companies stop collecting applications; records remain private",
        async () => {
          await edit({ status: "closed", questions: [] });
          assert.equal(
            (await request(`/careers/${page.publicId}`, null)).body.data.page
              .status,
            "closed",
          );
          assert.equal(
            (await submit({ ...application(), email: "other@example.com" }))
              .status,
            404,
          );
          const retained = (
            await request(`/hiring/applications/${applicationId}`, alpha.token)
          ).body.data.application;
          assert.equal(retained.answers[0].label, "Notice period?");
          await edit({ status: "archived" });
          assert.equal(
            (await request(`/careers/${page.publicId}`, null)).status,
            404,
          );
          await edit({ status: "published" });
          await M.OrganizationClass.updateOne(
            { _id: alpha.org.id },
            { $set: { status: "suspended" } },
          );
          assert.equal(
            (await request(`/careers/${page.publicId}`, null)).status,
            404,
          );
          assert.equal((await submit(application())).status, 404);
        },
      );
    } finally {
      for (const tokens of sessions)
        await revokeSession(tokens.accessToken, tokens.refreshToken).catch(
          () => {},
        );
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (mongoose.connection.readyState === 1)
        await mongoose.connection.dropDatabase();
      if (Redis.client?.isOpen) {
        const keys = await Redis.client.keys(`${databaseName}:*`);
        if (keys.length) await Redis.client.del(keys);
      }
      await Promise.all([mongoose.disconnect(), Redis.close()]);
    }
  },
);
