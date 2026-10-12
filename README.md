# HRM Backend

Module-first TypeScript, Express, MongoDB, and Typegoose starter based on the conventions used in `customerCoreV2`.

## Run

1. Copy `.env.example` to `.env` and adjust the values.
2. Run `npm install`.
3. Run `npm run dev`.

## Add a module

Copy `src/EmployeeModule`, rename the model/controller/router symbols, then register the module router in `src/routes/index.ts`.

## First-time setup

Start MongoDB and Redis, then configure `.env`. On startup, the idempotent `createFirstAdminScript` ensures the NovaCTO organization, system roles, and first organization admin exist. Redis is required because access and refresh tokens are stored there and can be revoked immediately.

Set `INITIAL_ADMIN_PASSWORD` to a unique password of at least 12 characters before the first startup. The initial login ID is `admin-001`. The script only inserts the account when it does not already exist; changing the environment variable does not reset an existing password. Change any previously seeded default password before deployment. Never commit real environment files or credentials.

The bootstrap API remains available for installations that disable or replace the scripted setup:

```json
{
  "organization": {
    "name": "Example Company",
    "slug": "example-company",
    "timezone": "Asia/Karachi"
  },
  "admin": {
    "employeeCode": "EMP-001",
    "firstName": "Office",
    "lastName": "Admin",
    "email": "admin@example.com",
    "password": "change-this-password"
  }
}
```

Log in with `POST /auth/login`. The employee code is the login ID. Send `loginId`, `password`, and `organizationSlug` when the same login ID may exist in multiple organizations. Use the returned `accessToken` as `Authorization: Bearer <token>`, and retain the `refreshToken` for `POST /auth/refresh`. Call `POST /auth/logout` with the refresh token and access-token header to revoke the complete session.

## Main APIs

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET|PATCH /organization`
- `GET|POST|PATCH /organization/offices`
- `GET|POST|PATCH /organization/departments`
- `GET|POST|PATCH /organization/teams`
- `GET /employee/me`, `PATCH /employee/me`
- `POST /employee/create`, `GET /employee/view`, `GET|PATCH /employee/:id`
- `GET|POST /access/roles`
- `GET|POST|DELETE /access/assignments`
- `POST /attendance/check-in`, `POST /attendance/check-out`, `GET /attendance/history`
- `GET|POST|PATCH /leave/types`
- `POST /leave/requests`, `GET /leave/requests/history`
- `GET /leave/requests/pending`, `PATCH /leave/requests/:id/review`
- `GET /audit`
- `GET /terms` — current organization terms, available to signed-in users.
- `PATCH /terms` — publish/update `title` and `content`; requires `organization.update`.
- `GET /announcements` — published announcements only, with `page` and `size`.
- `GET /announcements/manage` — admin table, including drafts/archived records.
- `POST /announcements`, `PATCH /announcements/:id` — admin-only; `title`, `content`, `status` (draft/published/archived).
- `POST /auth/change-password` — authenticated self-service, accepts `currentPassword`, `newPassword`, `confirmPassword`. Minimum 8 characters; maximum 72 UTF-8 bytes for bcrypt. Invalidates all existing access/refresh sessions; sign in again.

Admin content writes reuse the existing `organization.update` permission (or platform-admin `*`). Organization scope always comes from the authenticated session, never the submitted form. Terms are informational; no mandatory acceptance workflow is implied. Content is plain text.

Frontend: `/admin/terms`, `/admin/announcements`, `/admin/settings/password`; employee equivalents are `/terms`, `/announcements`, `/settings/password`. Published announcements are also shown on both dashboards.

Run `npm run test:workspace` with local MongoDB and Redis running. Tests use a unique temporary database and Redis key prefix, and clean up their own data afterward. Override connections with `HRM_TEST_MONGO_URI` and `HRM_TEST_REDIS_URL` if needed. Normal HRM data is not used.

Attendance check-in/check-out requires `latitude` and `longitude`; optional `accuracyMeters`, `address`, and `officeLocationId` are accepted. The response records distance from the office and whether the point is within its configured geofence.

## Docker deployment

For a single-server frontend, backend, MongoDB, Redis, and HTTPS stack, see
[deploy/README.md](deploy/README.md). Keep `HRM-frontend` alongside this repository.

For push-to-main deployment to the existing AWS server, see
[deploy/AWS-PIPELINE.md](deploy/AWS-PIPELINE.md). The deployment account, server
configuration, and GitHub secrets have been set up for this AWS instance.
