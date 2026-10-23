# Project Management Module

## Architecture

The project module uses the existing Express authentication, organization scope, Typegoose conventions, API envelope, employee records, and application shell. It does not create a separate identity system.

Collections:

- `projects`: project metadata and an atomically incremented issue sequence.
- `projectmembers`: project-specific employee access and role history. Removal marks membership as removed rather than deleting it.
- `workflowstatuses`: ordered, project-specific Kanban columns, categories, transitions, move roles, and the default status.
- `projecttasks`: both stories and tasks, using `type`. Tasks support multiple assignee employee IDs and an optional parent story.
- `projectcomments`: append-only task discussion records.
- `projectactivities`: append-only significant project and task events.

Project archival changes the project to read-only. Stories, tasks, memberships, comments, workflow configuration, and activity remain intact.

## Indexes

- Project key is unique per organization.
- Active project membership is unique by organization, project, and employee.
- Issues are unique by organization, project, and issue number.
- Tasks are indexed by project/status and organization/assignees.
- Workflow statuses are indexed by project/order.
- Comments and activity are indexed for chronological task/project reads.

## Permissions

| Role | Project visibility | Issues/comments | Members | Workflow | Project lifecycle |
| --- | --- | --- | --- | --- | --- |
| Organization admin | Every organization project | Full | Full | Full | Full |
| Project manager | Membership projects | Create/update/move/comment | Add, remove, change roles | Read-only | Update assigned project |
| Member | Membership projects | Create/update/move/comment | Read-only | Read-only | Read-only |
| Viewer | Membership projects | Read-only | Read-only | Read-only | Read-only |

Every controller loads records using the authenticated organization ID. Client-provided organization IDs and roles are ignored. Assignees and members must be active employees in the same organization.

## Workflow behavior

New projects receive Backlog, In Progress, and Done statuses as editable initial configuration. Status IDs remain stable when labels change. Each status stores allowed destination IDs and roles permitted to move work. The status-change API validates membership, project read-only state, role, target status, and configured transition before updating the shared task and writing activity.

A status containing work cannot be removed without a valid replacement status. Tasks are migrated before the old status is archived. A default status cannot be archived until another default is selected.

## API

Base path: `/projects`

- `GET/POST /`
- `GET/PATCH /:id`
- `PATCH /:id/archive`
- `GET /:id/overview`
- `GET/POST /:id/members`
- `PATCH/DELETE /:id/members/:employeeId`
- `GET /:id/workflow`
- `POST /:id/workflow/statuses`
- `PATCH /:id/workflow/statuses/reorder`
- `PATCH/DELETE /:id/workflow/statuses/:statusId`
- `GET/POST /:id/tasks`
- `GET/PATCH /:id/tasks/:taskId`
- `PATCH /:id/tasks/:taskId/status`
- `POST /:id/tasks/:taskId/comments`
- `GET /:id/activity`
- `GET /my-tasks`

List endpoints are bounded. Project and issue listing support filters; project listing is paginated. Board task results are capped at 200 per request.

## Frontend

Admin routes begin at `/admin/projects`; employee routes begin at `/projects`. The shared workspace includes Overview, Board, Stories & Tasks, Members, Workflow Settings for administrators, and Activity. `/projects/my-tasks` lists the signed-in employee's assignments.

The board uses native browser drag events with an optimistic status update. Failed API transitions roll the local state back and surface the server error. A per-task lock prevents repeated drop events from issuing duplicate updates.

## Setup and verification

No environment variables or migrations are required beyond the existing MongoDB and Redis configuration. MongoDB indexes are created from Typegoose schemas.

Commands:

```sh
cd HRM-backend
npm run build
npm run test:projects

cd HRM-frontend
npm run build
```

The project integration test uses isolated MongoDB and Redis namespaces and covers tenant isolation, admin-only creation, duplicate-safe membership, multiple assignees, invalid cross-organization assignments, allowed and rejected transitions, comments/activity, safe status migration, member removal warnings, unassignment, and history preservation.

## Current operational notes

- Rich text is stored as plain text because the existing HRM application has no shared rich-text editor or sanitization pipeline.
- Board results are capped rather than virtualized. Add cursor pagination or column virtualization for projects expected to exceed 200 active issues.
- Native HTML drag and drop is intentionally dependency-free and works well on desktop; a pointer/touch drag library would improve mobile reordering.
- Notifications, file attachments, mentions, effort logs, and per-assignee completion are natural later extensions and are not separate sources of task completion truth.
