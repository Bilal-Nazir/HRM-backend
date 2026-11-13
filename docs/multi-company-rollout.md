# Multi-company rollout

One global account has a unique email and optional Google subject. A company has
exactly one `ownerUserId`; it is the only source of company-admin authority.
Memberships and employee profiles belong to a company. Roles delegate company
permissions but cannot create an additional admin. Super Admin is an explicit,
server-managed account flag, never granted by signup, roles, or email domain.

Accounts can own multiple companies and join others through invitations. Owners
without an employee profile can administer the company; they need to add/invite
their own employee profile for attendance or personal task timers. Employee IDs
and passwords continue to work. Google-only users do not have a password until a
separate password-enrollment flow is introduced; they should use Google login.

## Deployment order for existing installations

Do not deploy just the frontend: this changes the authentication contract.

1. Stop HTTP writes and both task background workers. Back up MongoDB and verify
   the backup can be restored. Keep the old backend/frontend releases available.
2. Build the new backend. Run `npm run migrate:tenants` with the target database
   configuration. It is **read-only by default**. Review owner choices, reference
   conversions, duplicate identities, and every blocker. Never post DB credentials
   or Google secrets into issue descriptions or chat.
3. If a company has multiple legacy admins, explicitly choose its single
   `ownerUserId` before applying. All other accounts retain only delegated roles.
   Company admin access formerly granted solely by the role name is retired.
4. If multiple accounts have the same email, review the listed account IDs. Resolve
   conflicts manually or explicitly add `--merge-accounts` to the migration.
   The Google-linked/oldest account becomes canonical; other accounts are soft
   deleted, their user references are rewired, and previous login IDs become
   aliases. Only the canonical password survives. Arrange password support for
   those users. Platform privilege, if present on a merged identity, is retained;
   this is an offline reviewed operation, never a signup behavior.
5. Run `npm run migrate:tenants -- --apply` (add `--merge-accounts` only after the
   review above). This converts existing relationship fields and arrays to native
   BSON ObjectIds, backfills email/memberships/owners, and recreates the changed
   attendance partial index. It does not hard delete old records. JSON API IDs
   remain strings. Audit before/after snapshots intentionally retain their original
   historical contents. System actors now use `actorType: "system"`, not an
   invalid `actorUserId: "system"` reference.
6. Rerun the dry-run and confirm zero reference updates/blockers. Membership and
   owner backfills are idempotent. Apply invalidates credentials for migrated
   email accounts; users must sign in again. Do not rerun apply needlessly.
7. Set backend `GOOGLE_CLIENT_ID` to a Google OAuth **Web application** client ID.
   In Google Cloud, configure the consent screen/audience and authorized
   JavaScript origins, including `https://app.bemyadmin.com` and any localhost
   origin used for development. No Google client secret is needed by this GIS
   ID-token flow. Until configured, Google signup is unavailable and existing
   password login remains available.
8. Start the backend, then release the frontend. A startup readiness check refuses
   legacy string references or companies without a migrated owner/version, rather
   than returning incomplete data after the schema type changes.
9. Smoke-test Google signup, company creation/switching, employee password login,
   invitation acceptance with the exact invited email, ownership transfer,
   cross-company access denial, attendance, task timers, announcements, and reports.

The production database has **not** been modified by implementing this change.
Use the deployment account to execute the reviewed migration. For rollback after
migration, stop writes and restore the backup alongside the old application;
old code expects string references and cannot simply read the new BSON types.

## Login and invitations

- Google signature, issuer, audience, expiry, verified email and a one-time Redis
  nonce are checked on the server using Google's official library. Gmail and
  Google Workspace identities are supported; third-party Google email identities
  without an authoritative hosted domain require a separate email-verification
  flow and are rejected.
- Existing password accounts must prove the current password before connecting
  Google. A matching email alone never links or merges accounts at runtime.
- Employee creation cannot overwrite an existing global account's password.
  If its email already exists, the new employee is invited instead of activated.
- Company settings generates a seven-day, email-bound invitation link. Admins
  share it themselves. Automatic email delivery is not configured.
- Company switches rotate the browser session, revoke its old Redis session and
  reload the document. Per-company shortcuts and project filters stay scoped;
  late responses from the previous company are rejected.
- Live membership, active employee status, company status, owner and role grants
  are rechecked on every request/refresh. Company selection remains available when
  one company is suspended or membership is removed.
- One company's employee suspension/archive never disables a global account in
  its other companies. Company admins and Super Admin can see private employee
  details; delegated roles cannot see other employees' personal/emergency data.

## Validation

Use disposable MongoDB and Redis instances. Never point tests at the production
MongoDB database or Redis instance. Existing integration suites create unique test
DB names and clear only their own session keys; the dedicated test service ports
also prevent accidental interference with production tunnels.

```sh
npx tsc -p . --outDir tmp/tenant-test-build
HRM_TEST_MONGO_URI=mongodb://127.0.0.1:28073 HRM_TEST_REDIS_URL=redis://127.0.0.1:6383 DB_REDIS_PASS= node --import=extensionless/register --test --test-force-exit tests/tenancy.test.mjs
```

## Login portals

`/login` is the user login for company admins, delegated roles and employees.
`/admin/login` and `/admin/*` are exclusively for platform Super Admin accounts.
Company ownership and permissions are independent of the login portal. Company
admins use `/dashboard`, `/employees`, `/attendance`, `/leave`, `/projects`, and
`/settings/company` to manage their company; they never need `/admin/*` links.
Both password and Google sign-in enforce this split on the backend, including
accounts that have not selected or created a company yet. Google sign-in on the
admin login cannot create a new account or link a company account.

The portal split has passed 78 backend unit checks, 56 frontend checks, all 16
database-backed tenancy checks and both production builds. The tenancy suite
covers migration, native BSON references, company isolation and both login portals.

Production images include the migration script. With HTTP writes and workers
stopped and a verified backup available, run `npm run migrate:tenants:built` in a
one-off container for the read-only report, then add `-- --apply` after reviewing
the report. This command uses the already compiled schemas and does not require
development dependencies in the runtime image.
