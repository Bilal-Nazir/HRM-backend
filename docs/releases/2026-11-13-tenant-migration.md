# Production tenant migration — 2026-11-13

The operator explicitly approved migrating production with downtime. The previous
HTTP backend and its background workers were stopped before the final backup.

- Backend source: `8f180eae7cfcfeb6b2508a05ad3a191dd531be2e`.
- Frontend source: `712e49c104ed81604409b17fb4d9ff25e70a6ed2`.
- All 3,395 documents in the final backup restored successfully into an isolated
  local database. All 3,395 original document IDs were verified present in
  production after migration.
- 3,383 records had legacy references converted to BSON ObjectIds; eight company
  memberships and the existing company's owner were backfilled. No accounts were
  merged. The final dry-run reported zero reference updates and zero blockers.
- The existing Super Admin retained its platform access. No passwords were reset.
  Email identity migration invalidates affected old sessions; sign in again.
- Both AWS runtime images were built before downtime and deployed together. Both
  containers and the public API health endpoint passed checks. Temporary sessions
  verified Super Admin/company/employee/attendance/project APIs and employee
  session/company/attendance/task APIs, then were revoked.
- Cloudflare's initial Workers build failed during `npm ci` because five workerd
  platform packages were missing from the lockfile. Frontend fix
  `e77084ea189a8a764a44bc977af7fc5cd4a5ff85` restores exactly those entries without
  upgrading dependencies. Its clean npm 10.9.2 installation, production build and
  GitHub checks passed. Cloudflare confirmed successful production deployment on
  2026-11-13 at 11:04:38 UTC (4:04:38 PM Asia/Karachi).

## Backups and rollback

The stopped-writer backup is retained privately on the server at
`/opt/hrm/backups/hrm-prod-before-tenants-20261113.archive.gz` and off-server in the
backend checkout's ignored `backups/` directory. Both copies have SHA-256:

`1c052c4a035a295ba248390bbfb5ba36da412affa47489066a08f2241b310b3e`

The previous image references are in
`/opt/hrm/backups/images-before-tenants-20261113.env`. Keep the previous images and
backup until rollout is accepted. Rollback requires stopping writes, restoring
the database backup and restoring both application images together; never start
the old backend against the migrated database. Restoring the backup discards any
writes after migration, so review and preserve subsequent activity first.

## Validation and remaining setup

The release passed 78 backend unit checks, 56 frontend checks, 16 database-backed
tenancy checks, the restored-data rehearsal, both Linux Docker builds and live
API checks. The existing Google Web client ID was subsequently configured in the
backend deployment, and both Compose templates now forward it into the container.
The public configuration reports Google sign-in enabled, and the Google-rendered
button was verified on `https://app.bemyadmin.com/login`. The login headings and
portal role badges were removed in frontend commit `5fed7c6`; its GitHub and
Cloudflare deployment checks passed. This uses the popup JavaScript callback flow
and the authorized JavaScript origin, without a redirect URI or client secret.
