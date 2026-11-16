import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Run only with the application stopped and a verified MongoDB backup.
// Native collections deliberately bypass schema casting to find old BSON strings.
export async function migrateTenants(
  db,
  models,
  { apply = false, mergeAccounts = false } = {},
) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    referenceUpdates: 0,
    mergedAccounts: [],
    owners: [],
    memberships: 0,
    blockers: [],
  };
  const model = (name) => models.find((value) => value.modelName === name);
  const users = model("UserClass").collection,
    employees = model("EmployeeClass").collection,
    organizations = model("OrganizationClass").collection,
    memberships = model("CompanyMembershipClass").collection;
  const accounts = await users.find({ isDeleted: { $ne: true } }).toArray();
  const profiles = await employees.find({ isDeleted: { $ne: true } }).toArray();
  const accountMap = new Map(accounts.map((user) => [String(user._id), user]));
  const emails = new Map(),
    remap = new Map();
  for (const account of accounts) {
    const profileEmails = new Set(
      profiles
        .filter((profile) => String(profile.userId) === String(account._id))
        .map((profile) => profile.workEmail?.trim().toLowerCase())
        .filter(Boolean),
    );
    if (account.email) profileEmails.add(account.email.trim().toLowerCase());
    if (profileEmails.size > 1) {
      report.blockers.push(
        `Account ${account._id} has conflicting emails; select its verified identity before migration`,
      );
      continue;
    }
    const email = [...profileEmails][0];
    if (!email) continue; // Platform/legacy accounts without email keep password login.
    if (!emails.has(email)) emails.set(email, []);
    emails.get(email).push(account);
  }
  for (const [email, group] of emails) {
    group.sort(
      (a, b) =>
        Number(!!b.googleSubject) - Number(!!a.googleSubject) ||
        String(a._id).localeCompare(String(b._id)),
    );
    const canonical = group[0];
    if (
      new Set(group.map((account) => account.googleSubject).filter(Boolean))
        .size > 1
    )
      report.blockers.push(
        `Conflicting Google identities for account ${canonical._id}`,
      );
    for (const duplicate of group.slice(1)) {
      remap.set(String(duplicate._id), canonical._id);
      report.mergedAccounts.push({
        from: String(duplicate._id),
        to: String(canonical._id),
      });
    }
  }
  if (remap.size && !mergeAccounts)
    report.blockers.push(
      "Duplicate email accounts require review and --merge-accounts. The oldest Google-linked/legacy account keeps its password; previous login IDs become aliases.",
    );
  const canonicalId = (value) => remap.get(String(value)) || value;
  const orgs = await organizations.find({ isDeleted: { $ne: true } }).toArray();
  const roles = await model("RoleClass")
    .collection.find({
      name: "Organization Admin",
      isDeleted: { $ne: true },
      status: "active",
    })
    .toArray();
  const assignments = await model("RoleAssignmentClass")
    .collection.find({ isDeleted: { $ne: true } })
    .toArray();
  for (const company of orgs) {
    if (company.ownerUserId) continue;
    const adminRoleIds = new Set(
      roles
        .filter((role) => String(role.organizationId) === String(company._id))
        .map((role) => String(role._id)),
    );
    const adminEmployeeIds = new Set(
      assignments
        .filter(
          (row) =>
            String(row.organizationId) === String(company._id) &&
            adminRoleIds.has(String(row.roleId)),
        )
        .map((row) => String(row.employeeId)),
    );
    const candidates = [
      ...new Set(
        profiles
          .filter(
            (profile) =>
              String(profile.organizationId) === String(company._id) &&
              adminEmployeeIds.has(String(profile._id)) &&
              profile.userId &&
              accountMap.has(String(profile.userId)),
          )
          .map((profile) => String(canonicalId(profile.userId))),
      ),
    ];
    if (!candidates.length)
      candidates.push(
        ...accounts
          .filter(
            (user) =>
              user.isPlatformAdmin &&
              String(user.organizationId) === String(company._id),
          )
          .map((user) => String(canonicalId(user._id))),
      );
    if (new Set(candidates).size !== 1)
      report.blockers.push(
        `Company ${company._id} needs exactly one ownerUserId selected before migration`,
      );
    else
      report.owners.push({
        companyId: String(company._id),
        ownerUserId: candidates[0],
      });
  }
  const existingMembershipKeys = new Set();
  for (const membership of await memberships.find({}).toArray()) {
    const key = `${membership.organizationId}:${canonicalId(membership.userId)}`;
    if (existingMembershipKeys.has(key))
      report.blockers.push(
        `Existing memberships would collide at ${key}; resolve them before merging accounts`,
      );
    existingMembershipKeys.add(key);
  }
  const memberKeys = new Set();
  for (const profile of profiles)
    if (profile.userId && accountMap.has(String(profile.userId))) {
      const key = `${profile.organizationId}:${canonicalId(profile.userId)}`;
      if (memberKeys.has(key))
        report.blockers.push(
          `Multiple employee profiles would map to membership ${key}`,
        );
      memberKeys.add(key);
      report.memberships++;
    }
  const referenceTargets = new Map();
  for (const Model of models)
    referenceTargets.set(
      Model.modelName,
      new Map(
        (
          await Model.collection
            .find(
              {},
              { projection: { _id: 1, organizationId: 1, projectId: 1 } },
            )
            .toArray()
        ).map((row) => [String(row._id), row]),
      ),
    );
  const changes = [];
  for (const Model of models) {
    const fields = [];
    Model.schema.eachPath((path, type) => {
      if (
        path !== "_id" &&
        (type.instance === "ObjectId" || type.caster?.instance === "ObjectId")
      )
        fields.push({
          path,
          array: type.instance === "Array",
          ref: type.options.ref || type.caster?.options.ref,
          user:
            type.options.ref === "UserClass" ||
            type.caster?.options.ref === "UserClass",
        });
    });
    if (!fields.length) continue;
    const cursor = Model.collection.find({});
    for await (const row of cursor) {
      const set = {},
        unset = {};
      for (const field of fields) {
        const value = row[field.path];
        if (value == null) continue;
        if (field.path === "actorUserId" && value === "system") {
          unset.actorUserId = "";
          set.actorType = "system";
          continue;
        }
        const cast = (id) => {
          if (
            !(id instanceof mongoose.Types.ObjectId) &&
            !(typeof id === "string" && /^[a-f\d]{24}$/i.test(id))
          ) {
            report.blockers.push(
              `Invalid reference ${Model.modelName}.${field.path} in ${row._id}`,
            );
            return id;
          }
          const target = field.user ? canonicalId(id) : id;
          const targets = referenceTargets.get(field.ref);
          if (targets) {
            const referenced = targets.get(String(target));
            if (!referenced)
              report.blockers.push(
                `Missing reference ${Model.modelName}.${field.path} in ${row._id}`,
              );
            else if (
              field.ref !== "UserClass" &&
              row.organizationId &&
              referenced.organizationId &&
              String(row.organizationId) !== String(referenced.organizationId)
            )
              report.blockers.push(
                `Cross-company reference ${Model.modelName}.${field.path} in ${row._id}`,
              );
            else if (
              row.projectId &&
              referenced.projectId &&
              String(row.projectId) !== String(referenced.projectId)
            )
              report.blockers.push(
                `Cross-project reference ${Model.modelName}.${field.path} in ${row._id}`,
              );
          }
          return new mongoose.Types.ObjectId(String(target));
        };
        const next =
          field.array && Array.isArray(value) ? value.map(cast) : cast(value);
        if (
          field.array
            ? JSON.stringify(value.map((id) => [typeof id, String(id)])) !==
              JSON.stringify(next.map((id) => [typeof id, String(id)]))
            : typeof value === "string" || String(next) !== String(value)
        )
          set[field.path] = next;
      }
      if (Object.keys(set).length || Object.keys(unset).length) {
        report.referenceUpdates++;
        changes.push({ collection: Model.collection, id: row._id, set, unset });
      }
    }
  }
  report.blockers = [...new Set(report.blockers)];
  if (!apply || report.blockers.length) return report;
  // Deterministic/idempotent migration. No old records are hard deleted.
  for (const change of changes)
    await change.collection.updateOne(
      { _id: change.id },
      {
        ...(Object.keys(change.set).length && { $set: change.set }),
        ...(Object.keys(change.unset).length && { $unset: change.unset }),
      },
    );
  for (const [email, group] of emails) {
    const canonical = group[0];
    const aliases = [
      ...new Set(
        group
          .flatMap((account) => [
            account.loginId,
            ...(account.legacyLoginIds || []),
          ])
          .filter(Boolean),
      ),
    ];
    for (const duplicate of group.slice(1))
      await users.updateOne(
        { _id: duplicate._id },
        {
          $set: { isActive: false, isDeleted: true },
          $unset: { email: "", googleSubject: "" },
          $inc: { credentialVersion: 1 },
        },
      );
    const identityChanged =
      canonical.email !== email ||
      group.length > 1 ||
      JSON.stringify(canonical.legacyLoginIds || []) !==
        JSON.stringify(aliases);
    await users.updateOne(
      { _id: canonical._id },
      {
        $set: {
          email,
          legacyLoginIds: aliases,
          ...(group.some((account) => account.isPlatformAdmin) && {
            isPlatformAdmin: true,
          }),
        },
        ...(identityChanged && { $inc: { credentialVersion: 1 } }),
      },
    );
  }
  for (const owner of report.owners)
    await organizations.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.companyId) },
      {
        $set: {
          ownerUserId: new mongoose.Types.ObjectId(owner.ownerUserId),
          membershipVersion: 0,
        },
      },
    );
  for (const profile of profiles)
    if (profile.userId && accountMap.has(String(profile.userId))) {
      const organizationId = new mongoose.Types.ObjectId(
          String(profile.organizationId),
        ),
        userId = new mongoose.Types.ObjectId(
          String(canonicalId(profile.userId)),
        );
      await memberships.updateOne(
        { organizationId, userId },
        {
          $setOnInsert: {
            organizationId,
            userId,
            employeeId: profile._id,
            status:
              profile.employmentStatus === "active" ? "active" : "suspended",
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  await organizations.updateMany(
    { membershipVersion: { $exists: false } },
    { $set: { membershipVersion: 0 } },
  );
  await organizations.updateMany(
    { isDeleted: { $ne: true } },
    { $set: { tenantSchemaVersion: 1 } },
  );
  // This named index used a string-only partial expression before BSON migration.
  const attendance = model("AttendanceClass");
  const indexes = await attendance.collection.indexes().catch(() => []);
  for (const index of indexes)
    if (index.partialFilterExpression?.locationRequestId?.$type === "string")
      await attendance.collection.dropIndex(index.name);
  for (const Model of models) await Model.createIndexes();
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // A dry-run must not create collections or indexes as a model-init side effect.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  // Register schemas without starting HTTP listeners or background workers.
  await import("../build/src/routes/index.js");
  await mongoose.connect(
    process.env.DB_MONGO_URI || "mongodb://127.0.0.1:27017/hrm",
    {
      dbName: process.env.DB_MONGO_DB_NAME || "hrm",
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5000,
    },
  );
  try {
    const report = await migrateTenants(
      mongoose.connection.db,
      Object.values(mongoose.models),
      {
        apply: process.argv.includes("--apply"),
        mergeAccounts: process.argv.includes("--merge-accounts"),
      },
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.blockers.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
