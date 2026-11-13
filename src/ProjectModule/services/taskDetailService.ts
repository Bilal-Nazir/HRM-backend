import { isValidObjectId } from "mongoose";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import UserModel from "../../AuthModule/models/User";
import ProjectCommentModel from "../models/ProjectComment";
import ProjectActivityModel from "../models/ProjectActivity";
import ProjectAttachmentModel from "../models/ProjectAttachment";
import ProjectTaskModel from "../models/ProjectTask";
import TaskTimeSessionModel from "../models/TaskTimeSession";
import WorkflowStatusModel from "../models/WorkflowStatus";
import { taskHistoryChanges } from "./taskHistory";

const serialize = (doc: any) => {
  const value = doc?.toObject ? doc.toObject() : doc;
  const { _id, __v, ...rest } = value;
  return { ...rest, id: String(_id) };
};
const validIds = (ids: any[]) => [
  ...new Set(ids.filter((id) => typeof id === "string" && isValidObjectId(id))),
];

export async function readTaskDetails({
  organizationId,
  task,
  project,
  canEdit,
  canAdministerTask = false,
  activityPage = 1,
  worklogPage = 1,
}: {
  organizationId: string;
  task: any;
  project: any;
  canEdit: boolean;
  canAdministerTask?: boolean;
  activityPage?: number;
  worklogPage?: number;
}) {
  const scope = {
    organizationId,
    projectId: task.projectId,
    taskId: task.id,
    isDeleted: { $ne: true },
  };
  const size = 50;
  const [
    comments,
    history,
    historyCount,
    attachments,
    worklog,
    worklogCount,
    statuses,
    workTotals,
    commentEvents,
  ] = await Promise.all([
    ProjectCommentModel.find(scope).sort({ createdAt: 1, _id: 1 }).lean(),
    ProjectActivityModel.find(scope)
      .sort({ createdAt: -1, _id: -1 })
      .skip((activityPage - 1) * size)
      .limit(size)
      .lean(),
    ProjectActivityModel.countDocuments(scope),
    ProjectAttachmentModel.find(scope).sort({ createdAt: 1 }).lean(),
    TaskTimeSessionModel.find(scope)
      .sort({ startedAt: -1, _id: -1 })
      .skip((worklogPage - 1) * size)
      .limit(size)
      .lean(),
    TaskTimeSessionModel.countDocuments(scope),
    WorkflowStatusModel.find({
      organizationId,
      projectId: task.projectId,
    }).lean(),
    TaskTimeSessionModel.aggregate([
      { $match: { ...scope, endedAt: { $exists: true } } },
      { $group: { _id: null, seconds: { $sum: "$durationSeconds" } } },
    ]),
    ProjectActivityModel.find({ ...scope, action: "comment.added" })
      .select("actorUserId actorEmployeeId changes")
      .lean(),
  ]);
  const userIds = validIds([
    task.createdBy,
    ...history.map((row) => row.actorUserId),
    ...worklog.map((row) => row.startedByUserId),
    ...comments.map((row) => row.authorUserId),
    ...commentEvents.map((row) => row.actorUserId),
  ]);
  const employeeIds = validIds([
    task.reporterEmployeeId,
    ...task.assigneeEmployeeIds,
    ...history.flatMap((row: any) => [
      row.actorEmployeeId,
      ...(row.changes?.before?.assigneeEmployeeIds || []),
      ...(row.changes?.after?.assigneeEmployeeIds || []),
    ]),
    ...worklog.map((row) => row.employeeId),
    ...comments.flatMap((row) => [
      row.authorEmployeeId,
      ...(row.mentionedEmployeeIds || []),
    ]),
    ...attachments.map((row) => row.uploadedByEmployeeId),
  ]);
  const parentIds = validIds([
    task.parentStoryId,
    ...history.flatMap((row: any) => [
      row.changes?.before?.parentStoryId,
      row.changes?.after?.parentStoryId,
    ]),
  ]);
  const [people, users, parents, children] = await Promise.all([
    EmployeeModel.find({
      organizationId,
      $or: [{ _id: { $in: employeeIds } }, { userId: { $in: userIds } }],
    })
      .select("firstName lastName employeeCode jobTitle userId")
      .lean(),
    UserModel.find({ _id: { $in: userIds } })
      .select("loginId")
      .lean(),
    ProjectTaskModel.find({
      organizationId,
      projectId: task.projectId,
      _id: { $in: parentIds },
    })
      .select("key title isDeleted")
      .lean(),
    task.type === "story"
      ? ProjectTaskModel.find({
          organizationId,
          projectId: task.projectId,
          parentStoryId: task.id,
          isDeleted: { $ne: true },
        })
          .select("key title workflowStatusId")
          .lean()
      : [],
  ]);
  const employeeMap = new Map(
    people.map((person: any) => [
      String(person._id),
      {
        id: String(person._id),
        employeeId: String(person._id),
        name: `${person.firstName} ${person.lastName}`.trim(),
        employeeCode: person.employeeCode,
        jobTitle: person.jobTitle,
      },
    ]),
  );
  const employeeByUser = new Map(
    people
      .filter((person) => person.userId)
      .map((person: any) => [
        person.userId,
        employeeMap.get(String(person._id))!,
      ]),
  );
  const userMap = new Map(
    users.map((user: any) => [
      String(user._id),
      { id: String(user._id), name: user.loginId },
    ]),
  );
  const personFor = (employeeId?: string, userId?: string) =>
    userId === "system"
      ? { id: "system", name: "System" }
      : employeeMap.get(employeeId || "") ||
        employeeByUser.get(userId || "") ||
        userMap.get(userId || "") || { id: "unknown", name: "Unknown user" };
  const names = new Map(
    [...employeeMap].map(([id, person]) => [id, person.name]),
  );
  const statusNames = new Map(
    statuses.map((status: any) => [String(status._id), status.name]),
  );
  const parentNames = new Map(
    parents.map((parent: any) => [
      String(parent._id),
      `${parent.key}: ${parent.title}`,
    ]),
  );
  const creator = personFor(undefined, task.createdBy);
  const enrichedTask = {
    ...serialize(task),
    creator,
    reporter: task.reporterEmployeeId
      ? personFor(task.reporterEmployeeId)
      : creator,
    assignees: task.assigneeEmployeeIds.map((id: string) => personFor(id)),
    status: statuses.find(
      (status: any) => String(status._id) === task.workflowStatusId,
    )
      ? serialize(
          statuses.find(
            (status: any) => String(status._id) === task.workflowStatusId,
          ),
        )
      : null,
    parent: parents.find(
      (parent: any) => String(parent._id) === task.parentStoryId,
    )
      ? serialize(
          parents.find(
            (parent: any) => String(parent._id) === task.parentStoryId,
          ),
        )
      : null,
  };
  const now = new Date();
  const trackedSeconds =
    (task.accumulatedSeconds || 0) +
    (task.timeStartedAt
      ? Math.max(0, Math.floor((+now - +new Date(task.timeStartedAt)) / 1000))
      : 0);
  return {
    task: enrichedTask,
    project: {
      id: project.id,
      name: project.name,
      key: project.key,
      status: project.status,
      taskDurationOptionsMinutes: project.taskDurationOptionsMinutes || [],
      pauseStatusId: project.pauseStatusId,
    },
    permissions: {
      canEdit,
      canMove: canEdit && (!task.autoPaused || canAdministerTask),
      canEditDuration:
        canEdit && (!task.durationExtensionRequired || canAdministerTask),
    },
    workflow: statuses
      .filter((status) => !status.isArchived && !status.isDeleted)
      .map(serialize),
    children: children.map(serialize),
    comments: comments.map((comment: any) => {
      const recorded = commentEvents.find(
        (event: any) => event.changes?.commentId === String(comment._id),
      );
      return {
        ...serialize(comment),
        author: personFor(
          comment.authorEmployeeId || recorded?.actorEmployeeId,
          comment.authorUserId || recorded?.actorUserId,
        ),
        mentions: (comment.mentionedEmployeeIds || [])
          .map((id: string) => employeeMap.get(id))
          .filter(Boolean),
      };
    }),
    activity: history.map((entry: any) => ({
      ...serialize(entry),
      actor:
        entry.actorType === "system"
          ? { id: "system", name: "System" }
          : personFor(entry.actorEmployeeId, entry.actorUserId),
      fieldChanges: taskHistoryChanges(entry, names, statusNames, parentNames),
    })),
    activityPagination: {
      page: activityPage,
      size,
      totalCount: historyCount,
      hasMore: activityPage * size < historyCount,
    },
    worklog: worklog.map((session: any) => ({
      ...serialize(session),
      employee: personFor(session.employeeId, session.startedByUserId),
      durationSeconds: session.endedAt
        ? (session.durationSeconds ??
          Math.max(
            0,
            Math.floor(
              (+new Date(session.endedAt) - +new Date(session.startedAt)) /
                1000,
            ),
          ))
        : Math.max(0, Math.floor((+now - +new Date(session.startedAt)) / 1000)),
    })),
    worklogPagination: {
      page: worklogPage,
      size,
      totalCount: worklogCount,
      hasMore: worklogPage * size < worklogCount,
    },
    worklogSummary: {
      trackedSeconds,
      legacySeconds: Math.max(
        0,
        (task.accumulatedSeconds || 0) - (workTotals[0]?.seconds || 0),
      ),
      sessionCount: worklogCount,
    },
    attachments: attachments.map((attachment: any) => {
      const row = serialize(attachment);
      delete row.storedName;
      return row;
    }),
  };
}
