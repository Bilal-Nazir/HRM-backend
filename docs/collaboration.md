# Company chat and request details

These changes are local to the backend and frontend repositories. They require both applications to run the corresponding changes; publishing either repository is a separate action.

## Request management

Request rows and notification links open `/leave/:requestId` (or `/admin/leave/:requestId` in the Super Admin portal). The page shows dates, day count, reason, employee identity, current managers/leads, comments, and submission/decision/cancellation history. Existing manager remarks are retained.

The requester, company owner, scoped Super Admin, direct manager, team lead, and relevant project managers can view and comment. Managers are resolved from the employee's manager, team lead, project manager field, and active project-manager memberships. Unrelated employees and users in other companies cannot access the request. Comments remain append-only, including after a decision.

Final approval/rejection requires the actual company owner/admin or scoped Super Admin. A custom role carrying `leave.manage` or `leave.approve` does **not** grant final-decision access. Review updates require a pending, non-deleted record, so concurrent decisions cannot overwrite one another. The requester can cancel a pending request.

Comments notify the requester, relevant managers/leads, and company owner, excluding the author. Decisions notify the requester. Notifications link to the detail page.

Endpoints:

- `GET /leave/requests/:id`: details, public employee identity, comments, history and allowed actions.
- `POST /leave/requests/:id/comments`: `{ body }`, 1–4,000 characters.
- `PATCH /leave/requests/:id/manager-comment`: compatibility alias that now appends a comment.
- `PATCH /leave/requests/:id/review`: existing decision endpoint, now restricted to actual admins.

## Chat

The header chat icon opens unread chats and group mentions. `/chat` and `/admin/chat` provide the full workspace. Project headers link directly to their project chat. New conversation offers company people or accessible projects. Type `@` and select a member to create a group mention. Messages support quoted replies, draft recovery and links.

The sidebar also has an **Inbox** link. A Super Admin without company context first chooses a company in the inbox, which issues a company-scoped session and discards the previous company's UI state. Company admins can start private conversations with employees through **New conversation**. A Super Admin who initiates a direct chat remains an eligible participant for the employee's replies; this does not expose other private conversations or the global Super Admin directory.

Direct rooms have exactly two participants. Company owners and Super Admins do not gain access to other people's private direct messages. Project rooms follow current project access; viewers and archived projects are read-only. Removed project memberships immediately remove chat access. Inactive direct participants make the room read-only. Direct-room and project-room uniqueness is enforced by database indexes.

Messages are plain text (1–5,000 characters). Mentions must refer to current members and the selected member's actual name in the message. Recipient receipts are stored separately, with immutable message IDs and per-recipient read times. Retrying the same client message ID is idempotent; a different payload with the same ID is rejected. Reply and pagination cursors cannot point into another room or company.

Unread header counts represent conversations with unread messages; the `@` count represents unread project mentions. Reads are acknowledged only for rendered messages visible in the focused tab, or an explicit mark-as-read action. History uses cursor pagination. Updates currently use **three-second polling while visible**, plus focus refresh; WebSockets, browser push, file uploads, calls and message editing are not included.

Endpoints under `/chat`:

- `GET /directory`, `GET /inbox`
- `POST /direct` with `{ userId }`
- `POST /projects/:projectId`
- `GET /conversations/:id`
- `GET /conversations/:id/messages` with optional `before`, `after`, or `mentions=1`
- `POST /conversations/:id/messages` with `{ body, clientMessageId, mentionedUserIds?, replyToMessageId? }`
- `PATCH /conversations/:id/read` with `{ messageIds }`
- `PATCH /conversations/:id/read-all`

All collections use native ObjectId references and company-scoped queries. Normal Mongoose model initialization creates the new collection indexes; no conversion of existing data is needed.

## Profile photos

Both `/settings/profile` and `/admin/settings/profile` support photo preview, upload, replacement and removal. This works for employee accounts and for company admins/Super Admins with no employee record. Profile settings are available from the sidebar and account menu. The sidebar, inbox, chat member list and mention picker show photos with initials as a fallback.

Photos belong to the global user account and therefore carry across that person's companies. Uploads accept static JPG, PNG and WebP up to 5 MB / 24 megapixels. The backend uses Sharp to decode, orient, crop and re-encode a 256px JPEG, stripping source metadata. The small resulting image is stored on the user with default database selection disabled. Only the photo version is returned in normal profile/chat metadata; original files are not retained.

- `GET /auth/profile`: own account profile and public employment name/title.
- `PUT /auth/profile/photo`: `{ data: "data:image/png;base64,..." }`; always updates the authenticated user, ignoring supplied target IDs.
- `DELETE /auth/profile/photo`: removes the authenticated user's photo.
- `GET /auth/people/:userId/photo`: authenticated JPEG response, private/no-store; permitted for the owner and eligible people in the viewer's current company chat directory.

The frontend fetches images with authorization headers, falls back to initials on failure, and refreshes its own sidebar avatar after upload/removal. Photos are not public URLs. Existing company-managed employee names are preserved; accounts without an employee record can continue to set their display name.

## Local verification

Use disposable MongoDB and Redis, explicitly overriding application database settings. Never run these tests against production infrastructure.

```sh
HRM_TEST_MONGO_URI=mongodb://127.0.0.1:28073 \
HRM_TEST_REDIS_URL=redis://127.0.0.1:6383 \
DB_REDIS_PASS='' npm run test:collaboration
```

`test:collaboration` creates a uniquely named temporary database and session namespace, then removes its own test data. It covers company boundaries, direct-message privacy, membership revocation, project mentions, retries, replies, pagination, request access, comment notifications and admin-only decisions. `test:workspace` covers the existing attendance/leave flow. Frontend `tests/collaboration.test.mjs` checks rendered role-specific controls, escaped text, revoked access, and header unread/mention links. `tests/task-details.test.mjs` covers safe post-login deep links.
