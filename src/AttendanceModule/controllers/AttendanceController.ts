import { NextFunction, Response } from "express";
import { writeAudit } from "../../AuditModule/utils/audit";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import OfficeLocationModel from "../../OrganizationModule/models/OfficeLocation";
import {
  ConflictException,
  ObjectNotFoundException,
  ValidationException,
  sendResponseObject,
} from "../../node-base/utils";
import AttendanceModel from "../models/Attendance";
import { distanceMeters } from "../utils/geofence";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { validationRulesType } from "../../node-base/validator";
import { AttendanceClass } from "../models/Attendance";
import { constants } from "../../node-base/constants";
import WorkScheduleModel from "../../OrganizationModule/models/WorkSchedule";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import TeamModel from "../../OrganizationModule/models/Team";
import ProjectModel from "../../ProjectModule/models/Project";
import ProjectTaskModel from "../../ProjectModule/models/ProjectTask";
import ProjectMemberModel from "../../ProjectModule/models/ProjectMember";
import ProjectActivityModel from "../../ProjectModule/models/ProjectActivity";
import ProjectCommentModel from "../../ProjectModule/models/ProjectComment";
import WorkflowStatusModel from "../../ProjectModule/models/WorkflowStatus";
import LeaveRequestModel from "../../LeaveModule/models/LeaveRequest";
import TaskTimeSessionModel from "../../ProjectModule/models/TaskTimeSession";
import { isValidObjectId } from "mongoose";
import { dailyTaskActivity, nextReportDay, reportDay, reportMidnight } from "../utils/taskActivityReport";
import { pauseEmployeeTimersAtCheckout } from "../../ProjectModule/services/checkoutTimerService";

const attendanceMetrics = (record: AttendanceClass, schedule?: { timezone: string; weeklyPattern: { day: number; startTime: string; endTime: string; working: boolean }[] }) => {
  const hours = record.checkOutAt ? Math.max(0, (new Date(record.checkOutAt).getTime() - new Date(record.checkInAt).getTime()) / 3600000) : 0;
  const flags: string[] = [];
  if (record.checkInWithinGeofence === false || record.checkOutWithinGeofence === false) flags.push("outside_office_area");
  if (schedule) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(record.checkInAt));
    const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
    const workDay = schedule.weeklyPattern.find((item) => item.day === day && item.working);
    if (workDay?.startTime && `${part("hour")}:${part("minute")}` > workDay.startTime) flags.push("late_check_in");
    if (workDay?.endTime && record.checkOutAt) {
      const outParts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(record.checkOutAt));
      const out = (type: string) => outParts.find((item) => item.type === type)?.value || "";
      if (`${out("hour")}:${out("minute")}` < workDay.endTime) flags.push("early_check_out");
    }
  }
  return { workedHours: Math.round(hours * 100) / 100, flags };
};

export class AttendanceControllerClass extends BaseControllerClass<AttendanceClass> {
  _Model = AttendanceModel;
  _modelName = constants.fields.Attendance.Attendance;
  _validationRules: validationRulesType = {};
  _updateValidationRules: validationRulesType = {};

  private scheduleLookup = async (organizationId: string, employeeIds: string[]) => {
    const [employees, fallback] = await Promise.all([
      EmployeeModel.find({ organizationId, _id: { $in: employeeIds } }).select("workScheduleId"),
      WorkScheduleModel.findOne({ organizationId, name: "Organization default", status: "active", isDeleted: { $ne: true } }),
    ]);
    const schedules = await WorkScheduleModel.find({ organizationId, _id: { $in: employees.map((employee) => employee.workScheduleId).filter(Boolean) }, status: "active", isDeleted: { $ne: true } });
    const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
    return new Map(employees.map((employee) => [employee.id, employee.workScheduleId ? byId.get(employee.workScheduleId) || fallback || undefined : fallback || undefined]));
  };

  public getScheduleController = async (req: AuthenticatedRequest, res: Response) => {
    const schedule = await WorkScheduleModel.findOne({ organizationId: req.auth!.organizationId, name: "Organization default", isDeleted: { $ne: true } });
    return sendResponseObject({ res, data: { schedule: schedule ? await schedule.display() : null } });
  };

  public updateScheduleController = async (req: AuthenticatedRequest, res: Response) => {
    const { startTime, endTime, workingDays } = req.body;
    const validTime = (value: unknown) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(startTime) || !validTime(endTime) || startTime >= endTime || !Array.isArray(workingDays) || !workingDays.length || workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new ValidationException("Choose valid working days and start/end times");
    const organizationId = req.auth!.organizationId!;
    const organization = await OrganizationModel.findById(organizationId);
    if (!organization) throw new ObjectNotFoundException("Organization");
    const schedule = await WorkScheduleModel.findOneAndUpdate({ organizationId, name: "Organization default" }, { $set: { timezone: organization.timezone, weeklyPattern: [...new Set(workingDays)].map((day) => ({ day, startTime, endTime, working: true })), expectedHours: (Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3)) - Number(startTime.slice(0, 2)) * 60 - Number(startTime.slice(3))) / 60, status: "active", isDeleted: false } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    return sendResponseObject({ res, data: { schedule: await schedule!.display() } });
  };

  public manageController = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(req.query.size) || 20)),
    );
    const scope = { organizationId, isDeleted: { $ne: true } };
    const openFilter = {
      ...scope,
      status: { $in: ["open", "flagged"] },
      checkOutAt: { $exists: false },
    };
    const filterFlags = req.query.flags === "true";
    const readFilter = req.query.open === "true" && !filterFlags ? openFilter : scope;
    let [objs, totalCount, presentNow, activeEmployees, attendanceFlags] =
      await Promise.all([
        this.dbReadRecords({
          readFilter,
          page,
          limit,
          paginate: true,
          sort: { checkInAt: -1 },
          baseFilter: false,
        }),
        this.dbCountDocs({ readFilter, baseFilter: false }),
        this.dbCountDocs({ readFilter: openFilter, baseFilter: false }),
        EmployeeModel.countDocuments({ ...scope, employmentStatus: "active" }),
        this.dbCountDocs({
          readFilter: { ...openFilter, checkInWithinGeofence: false },
          baseFilter: false,
        }),
      ]);
    if (filterFlags) {
      const all = await AttendanceModel.find(scope).sort({ checkInAt: -1 }).limit(5000);
      const lookup = await this.scheduleLookup(organizationId, [...new Set(all.map((record) => record.employeeId))]);
      const flagged = all.filter((record) => attendanceMetrics(record, lookup.get(record.employeeId)).flags.length > 0);
      totalCount = flagged.length;
      objs = flagged.slice((page - 1) * limit, page * limit);
    }
    const people = await EmployeeModel.find({
      ...scope,
      _id: { $in: objs.map((obj) => obj.employeeId) },
    }).select("firstName lastName employeeCode");
    const names = new Map(
      people.map((person) => [
        person.id,
        {
          name: `${person.firstName} ${person.lastName}`,
          employeeCode: person.employeeCode,
        },
      ]),
    );
    const schedules = await this.scheduleLookup(organizationId, objs.map((obj) => obj.employeeId));
    return sendResponseObject({
      res,
      data: {
        attendances: await Promise.all(
          objs.map(async (obj) => ({
            ...(await obj.display({ detail: true })),
            ...attendanceMetrics(obj, schedules.get(obj.employeeId)),
            employee: names.get(obj.employeeId) || null,
          })),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
        summary: { presentNow, activeEmployees, attendanceFlags },
      },
    });
  };

  public activityOptionsController = async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = req.auth!.organizationId!;
    const [employees, teams, projects] = await Promise.all([
      EmployeeModel.find({ organizationId, employmentStatus: "active", isDeleted: { $ne: true } }).select("firstName lastName employeeCode jobTitle teamId").sort({ firstName: 1, lastName: 1 }).lean(),
      TeamModel.find({ organizationId, status: "active", isDeleted: { $ne: true } }).select("name leadEmployeeId").sort({ name: 1 }).lean(),
      ProjectModel.find({ organizationId, isDeleted: { $ne: true }, status: { $ne: "archived" } }).select("name key").sort({ name: 1 }).lean(),
    ]);
    const row = (value: any) => ({ ...value, id: String(value._id), _id: undefined });
    return sendResponseObject({ res, data: { employees: employees.map(row), teams: teams.map(row), projects: projects.map(row) } });
  };

  public employeeActivityController = async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId : "";
    if (!isValidObjectId(employeeId)) throw new ValidationException("Choose an employee");
    const employee = await EmployeeModel.findOne({ _id: employeeId, organizationId, isDeleted: { $ne: true } }).select("firstName lastName employeeCode jobTitle teamId employmentStatus timezone").lean();
    if (!employee) throw new ObjectNotFoundException("Employee");
    const organization = await OrganizationModel.findById(organizationId).select("timezone").lean();
    let timeZone = employee.timezone || organization?.timezone || "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone }).format(); } catch { timeZone = "UTC"; }
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const today = reportDay(new Date(), timeZone);
    const monthStart = `${today.slice(0, 8)}01`;
    const from = typeof req.query.from === "string" && datePattern.test(req.query.from) ? req.query.from : monthStart;
    const to = typeof req.query.to === "string" && datePattern.test(req.query.to) ? req.query.to : today;
    if (from > to) throw new ValidationException("Start date must be before end date");
    if ([from, to].some((day) => Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)) throw new ValidationException("Choose valid report dates");
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new ValidationException("Choose a report period of one year or less");
    const fromDate = reportMidnight(from, timeZone), toDate = reportMidnight(nextReportDay(to), timeZone);
    const projectId = typeof req.query.projectId === "string" && isValidObjectId(req.query.projectId) ? req.query.projectId : undefined;
    const projectFilter = projectId ? { projectId } : {};

    const [attendance, tasks, requests, comments, projectActivity, memberships, timerSessions] = await Promise.all([
      AttendanceModel.find({ organizationId, employeeId, isDeleted: { $ne: true }, workDate: { $gte: from, $lte: to } }).sort({ checkInAt: -1 }).lean(),
      ProjectTaskModel.find({ organizationId, isDeleted: { $ne: true }, ...(projectId ? { projectId } : {}), $or: [{ assigneeEmployeeIds: employeeId }, { reporterEmployeeId: employeeId }] }).sort({ updatedAt: -1 }).limit(500).lean(),
      LeaveRequestModel.find({ organizationId, employeeId, isDeleted: { $ne: true }, $or: [{ createdAt: { $gte: fromDate, $lt: toDate } }, { startDate: { $lt: toDate }, endDate: { $gte: fromDate } }] }).sort({ createdAt: -1 }).lean(),
      ProjectCommentModel.find({ organizationId, isDeleted: { $ne: true }, ...projectFilter, createdAt: { $gte: fromDate, $lt: toDate }, $or: [{ authorEmployeeId: employeeId }, { mentionedEmployeeIds: employeeId }] }).sort({ createdAt: -1 }).limit(500).lean(),
      ProjectActivityModel.find({ organizationId, isDeleted: { $ne: true }, ...projectFilter, actorEmployeeId: employeeId, createdAt: { $gte: fromDate, $lt: toDate } }).sort({ createdAt: -1 }).limit(1000).lean(),
      ProjectMemberModel.find({ organizationId, employeeId, status: "active", isDeleted: { $ne: true }, ...(projectId ? { projectId } : {}) }).select("projectId role").lean(),
      TaskTimeSessionModel.find({ organizationId, employeeId, isDeleted: { $ne: true }, ...(projectId ? { projectId } : {}), startedAt: { $lt: toDate }, $or: [{ endedAt: { $gt: fromDate } }, { endedAt: { $exists: false } }] }).sort({ startedAt: -1 }).limit(2000).lean(),
    ]);
    const missingTimerTaskIds = [...new Set([...timerSessions.map((session: any) => String(session.taskId)), ...projectActivity.filter((event: any) => event.taskId).map((event: any) => String(event.taskId))].filter((id) => !tasks.some((task: any) => String(task._id) === id)))];
    const timerTasks = missingTimerTaskIds.length ? await ProjectTaskModel.find({ organizationId, _id: { $in: missingTimerTaskIds }, isDeleted: { $ne: true } }).lean() : [];
    const taskDocuments = [...tasks, ...timerTasks];
    const projectIds = [...new Set([...taskDocuments.map((task: any) => String(task.projectId)), ...comments.map((comment: any) => String(comment.projectId)), ...projectActivity.map((event: any) => String(event.projectId)), ...memberships.map((member: any) => String(member.projectId))])];
    const taskIds = [...new Set([...taskDocuments.map((task: any) => String(task._id)), ...comments.map((comment: any) => String(comment.taskId)), ...projectActivity.map((event: any) => event.taskId ? String(event.taskId) : "").filter(Boolean)])];
    const [projects, relatedTasks, statuses, schedules] = await Promise.all([
      ProjectModel.find({ organizationId, _id: { $in: projectIds } }).select("name key").lean(),
      ProjectTaskModel.find({ organizationId, _id: { $in: taskIds } }).select("title key projectId workflowStatusId").lean(),
      WorkflowStatusModel.find({ organizationId, projectId: { $in: projectIds }, isDeleted: { $ne: true } }).select("name category").lean(),
      this.scheduleLookup(organizationId, [employeeId]),
    ]);
    const projectMap = new Map(projects.map((project: any) => [String(project._id), { id: String(project._id), name: project.name, key: project.key }]));
    const taskMap = new Map(relatedTasks.map((task: any) => [String(task._id), { id: String(task._id), title: task.title, key: task.key, projectId: String(task.projectId) }]));
    const statusMap = new Map(statuses.map((status: any) => [String(status._id), { name: status.name, category: status.category }]));
    const now = new Date();
    const location = (point: any) => point ? { latitude: point.latitude, longitude: point.longitude, accuracyMeters: point.accuracyMeters, address: point.address } : null;
    const attendanceRows = attendance.map((record: any) => ({ id: String(record._id), workDate: record.workDate, checkInAt: record.checkInAt, checkOutAt: record.checkOutAt, checkInLocation: location(record.checkInLocation), checkOutLocation: location(record.checkOutLocation), checkInWithinGeofence: record.checkInWithinGeofence, checkOutWithinGeofence: record.checkOutWithinGeofence, status: record.status, ...attendanceMetrics(record, schedules.get(employeeId)) }));
    const totalAttendanceHours = attendanceRows.reduce((sum, record) => sum + record.workedHours, 0);
    const timerRows = timerSessions.map((session: any) => { const durationSeconds = session.endedAt ? session.durationSeconds || Math.max(0, Math.floor((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)) : Math.max(0, Math.floor((now.getTime() - new Date(session.startedAt).getTime()) / 1000)); return { id: String(session._id), taskId: String(session.taskId), projectId: String(session.projectId), startedAt: session.startedAt, endedAt: session.endedAt, durationSeconds, stopReason: session.stopReason, running: !session.endedAt }; });
    const taskDays = dailyTaskActivity(timerRows, projectActivity, from, to, timeZone, now).map((day) => ({ ...day, tasks: day.tasks.map((row) => ({ ...row, task: taskMap.get(row.taskId) || null, project: projectMap.get(taskMap.get(row.taskId)?.projectId || "") || null })) }));
    const taskPeriodSeconds = taskDays.reduce((sum, day) => sum + day.seconds, 0);
    const taskPeriodCount = new Set(taskDays.flatMap((day) => day.tasks.map((task) => task.taskId))).size;
    const taskRows = taskDocuments.map((task: any) => { const running = task.timeStartedAt ? Math.max(0, Math.floor((now.getTime() - new Date(task.timeStartedAt).getTime()) / 1000)) : 0; const history = timerRows.filter((session) => session.taskId === String(task._id)); const sessionSeconds = history.reduce((sum, session) => sum + session.durationSeconds, 0); const trackedSeconds = (task.accumulatedSeconds || 0) + running; return { id: String(task._id), key: task.key, title: task.title, priority: task.priority, dueDate: task.dueDate, startDate: task.startDate, status: statusMap.get(String(task.workflowStatusId)) || null, project: projectMap.get(String(task.projectId)) || null, assigned: task.assigneeEmployeeIds.includes(employeeId), reported: task.reporterEmployeeId === employeeId, trackedSeconds, previouslyRecordedSeconds: Math.max(0, trackedSeconds - sessionSeconds), timerSessions: history, running: Boolean(task.timeStartedAt), updatedAt: task.updatedAt }; });
    const trackedTaskSeconds = taskRows.reduce((sum, task) => sum + task.trackedSeconds, 0);
    const commentRows = comments.map((comment: any) => ({ id: String(comment._id), body: comment.body, authored: comment.authorEmployeeId === employeeId, mentioned: comment.mentionedEmployeeIds.includes(employeeId), createdAt: comment.createdAt, task: taskMap.get(String(comment.taskId)) || null, project: projectMap.get(String(comment.projectId)) || null }));
    const requestRows = requests.map((request: any) => ({ id: String(request._id), kind: request.requestKind, startDate: request.startDate, endDate: request.endDate, totalDays: request.totalDays, reason: request.reason, status: request.status, managerComment: request.managerComment, reviewComment: request.reviewComment, createdAt: request.createdAt }));
    const timeline: any[] = [];
    attendanceRows.forEach((record) => { timeline.push({ id: `in-${record.id}`, type: "attendance.check_in", at: record.checkInAt, title: "Checked in", detail: record.workDate }); if (record.checkOutAt) timeline.push({ id: `out-${record.id}`, type: "attendance.check_out", at: record.checkOutAt, title: "Checked out", detail: `${record.workedHours.toFixed(2)} hours` }); });
    projectActivity.forEach((event: any) => timeline.push({ id: `activity-${event._id}`, type: event.action, at: event.createdAt, title: event.action.replaceAll(".", " ").replaceAll("_", " "), detail: taskMap.get(String(event.taskId))?.key, task: taskMap.get(String(event.taskId)), project: projectMap.get(String(event.projectId)) }));
    commentRows.forEach((comment) => timeline.push({ id: `comment-${comment.id}`, type: comment.authored ? "comment.authored" : "comment.mentioned", at: comment.createdAt, title: comment.authored ? "Added a comment" : "Was mentioned in a comment", detail: comment.task?.key, task: comment.task, project: comment.project }));
    timerRows.forEach((session) => { const task = taskMap.get(session.taskId); timeline.push({ id: `timer-start-${session.id}`, type: "task.timer_started", at: session.startedAt, title: "Started task timer", detail: task?.key, project: projectMap.get(session.projectId) }); if (session.endedAt) timeline.push({ id: `timer-stop-${session.id}`, type: session.stopReason === "pause" ? "task.timer_paused" : "task.timer_stopped", at: session.endedAt, title: session.stopReason === "pause" ? "Paused task timer" : "Stopped task timer", detail: `${task?.key || "Task"} · ${Math.floor(session.durationSeconds / 60)}m`, project: projectMap.get(session.projectId) }); });
    requestRows.forEach((request) => timeline.push({ id: `request-${request.id}`, type: "request.created", at: request.createdAt, title: `${request.kind.replaceAll("_", " ")} request`, detail: request.status }));
    timeline.sort((a, b) => +new Date(b.at) - +new Date(a.at));
    const completed = taskRows.filter((task) => task.status?.category === "done").length;
    const overdue = taskRows.filter((task) => task.dueDate && new Date(task.dueDate) < now && task.status?.category !== "done").length;
    return sendResponseObject({ res, data: { timeZone, taskDays, taskPeriodSummary: { seconds: taskPeriodSeconds, taskCount: taskPeriodCount, workingDays: taskDays.filter((day) => day.seconds > 0).length, sessionCount: timerRows.length }, limitsReached: { tasks: tasks.length >= 500, activities: projectActivity.length >= 1000, timerSessions: timerSessions.length >= 2000 }, employee: { id: String(employee._id), firstName: employee.firstName, lastName: employee.lastName, employeeCode: employee.employeeCode, jobTitle: employee.jobTitle, teamId: employee.teamId }, range: { from, to }, summary: { attendanceHours: Math.round(totalAttendanceHours * 100) / 100, attendanceSessions: attendanceRows.length, workingDays: new Set(attendanceRows.map((record) => record.workDate)).size, lateCheckIns: attendanceRows.filter((record) => record.flags.includes("late_check_in")).length, earlyCheckOuts: attendanceRows.filter((record) => record.flags.includes("early_check_out")).length, trackedTaskHours: Math.round(trackedTaskSeconds / 36) / 100, totalTasks: taskRows.length, completedTasks: completed, overdueTasks: overdue, openRequests: requestRows.filter((request) => request.status === "pending").length, mentionsReceived: commentRows.filter((comment) => comment.mentioned).length }, attendance: attendanceRows, tasks: taskRows, timerSessions: timerRows, requests: requestRows, comments: commentRows, memberships: memberships.map((member: any) => ({ project: projectMap.get(String(member.projectId)) || null, role: member.role })), timeline: timeline.filter((event) => +new Date(event.at) >= +fromDate && +new Date(event.at) < +toDate).slice(0, 1500) } });
  };

  public summaryController = async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = req.auth!.organizationId!;
    const isAdmin = req.query.scope === "organization" && req.auth!.permissions.some((permission) => ["*", "attendance.read.team"].includes(permission));
    const requestedEmployeeId = typeof req.query.employeeId === "string" && /^[a-f\d]{24}$/i.test(req.query.employeeId) ? req.query.employeeId : undefined;
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : `${new Date().getUTCFullYear()}-01-01`;
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
    const records = await AttendanceModel.find({ organizationId, ...(!isAdmin ? { employeeId: req.auth!.employeeId } : requestedEmployeeId ? { employeeId: requestedEmployeeId } : {}), isDeleted: { $ne: true }, workDate: { $gte: from, $lte: to } }).sort({ workDate: -1 }).limit(5000);
    const employeeSchedule = await this.scheduleLookup(organizationId, [...new Set(records.map((record) => record.employeeId))]);
    const buckets = { atLeastEightHours: 0, fiveToUnderEightHours: 0, underFiveHours: 0 };
    const flagCounts = { lateCheckIns: 0, earlyCheckOuts: 0, outsideOfficeArea: 0 };
    let totalWorkedHours = 0;
    const daily = records.map((record) => {
      const metrics = attendanceMetrics(record, employeeSchedule.get(record.employeeId));
      if (record.checkOutAt) {
        totalWorkedHours += metrics.workedHours;
        if (metrics.workedHours >= 8) buckets.atLeastEightHours++;
        else if (metrics.workedHours >= 5) buckets.fiveToUnderEightHours++;
        else buckets.underFiveHours++;
      }
      if (metrics.flags.includes("late_check_in")) flagCounts.lateCheckIns++;
      if (metrics.flags.includes("early_check_out")) flagCounts.earlyCheckOuts++;
      if (metrics.flags.includes("outside_office_area")) flagCounts.outsideOfficeArea++;
      return { id: record.id, employeeId: record.employeeId, workDate: record.workDate, checkInAt: record.checkInAt, checkOutAt: record.checkOutAt, checkInLocation: record.checkInLocation, checkOutLocation: record.checkOutLocation, checkInWithinGeofence: record.checkInWithinGeofence, checkOutWithinGeofence: record.checkOutWithinGeofence, ...metrics };
    });
    return sendResponseObject({ res, data: { totalWorkingDays: new Set(records.map((record) => `${record.employeeId}:${record.workDate}`)).size, totalWorkedHours: Math.round(totalWorkedHours * 100) / 100, buckets, flags: flagCounts, daily: daily.slice(0, 2000) } });
  };

  private getLocationData = (data: Record<string, any>) => {
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);

    const invalidLatitude =
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90;
    const invalidLongitude =
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180;

    if (invalidLatitude || invalidLongitude) {
      throw new ValidationException(
        "Valid latitude and longitude are required",
      );
    }

    return {
      latitude,
      longitude,
      accuracyMeters: data.accuracyMeters,
      address: data.address,
      capturedAt: new Date(),
    };
  };

  private getOfficeDistance = async ({
    organizationId,
    officeLocationId,
    latitude,
    longitude,
  }: {
    organizationId: string;
    officeLocationId?: string;
    latitude: number;
    longitude: number;
  }) => {
    if (!officeLocationId) {
      return {
        office: null,
        distance: undefined,
        withinGeofence: undefined,
      };
    }

    const office = await this.dbReadRecord({
      Collection: OfficeLocationModel,
      readFilter: {
        _id: officeLocationId,
        organizationId,
        status: "active",
      },
      baseFilter: false,
    });

    if (
      !office ||
      office.latitude === undefined ||
      office.longitude === undefined
    ) {
      return {
        office,
        distance: undefined,
        withinGeofence: undefined,
      };
    }

    const distance = distanceMeters(
      latitude,
      longitude,
      office.latitude,
      office.longitude,
    );

    return {
      office,
      distance,
      withinGeofence: distance <= (office.geofenceRadiusMeters || 200),
    };
  };

  public checkInController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = req.auth!.employeeId!;
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        [constants.fields.OfficeLocation.latitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -90 },
          { rule: "maxValue", value: 90 },
        ],
        [constants.fields.OfficeLocation.longitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -180 },
          { rule: "maxValue", value: 180 },
        ],
        accuracyMeters: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0 },
        ],
        address: [{ rule: "datatype", datatype: "String" }],
        [constants.fields.Attendance.officeLocationId]: [
          { rule: "format", type: "id" },
        ],
        [constants.fields.Attendance.notes]: [
          { rule: "datatype", datatype: "String" },
        ],
      },
    });

    if (!isValid) return next(errorMessages);

    const location = this.getLocationData(postData);

    const openAttendance = await this.dbReadRecord({
      readFilter: {
        organizationId,
        employeeId,
        status: { $in: ["open", "flagged"] },
        checkOutAt: { $exists: false },
      },
      baseFilter: false,
    });

    if (openAttendance) {
      return next(
        new ConflictException("You already have an open attendance session"),
      );
    }

    const employee = await this.dbReadRecord({
      Collection: EmployeeModel,
      readFilter: {
        _id: employeeId,
        organizationId,
        employmentStatus: "active",
      },
      baseFilter: false,
    });

    if (!employee) {
      return next(new ObjectNotFoundException("Active employee"));
    }

    const officeLocationId =
      postData.officeLocationId || employee.primaryOfficeLocationId;

    const officeData = await this.getOfficeDistance({
      organizationId,
      officeLocationId,
      latitude: location.latitude,
      longitude: location.longitude,
    });

    const obj = await this.dbInsertRecord({
      data: {
        organizationId,
        employeeId,
        officeLocationId: officeData.office?.id,
        workDate: new Date().toISOString().slice(0, 10),
        checkInAt: new Date(),
        checkInLocation: location,
        checkInDistanceMeters: officeData.distance,
        checkInWithinGeofence: officeData.withinGeofence,
        status: officeData.withinGeofence === false ? "flagged" : "open",
        notes: postData.notes,
      },
    });

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "attendance.checked_in",
      entityType: "Attendance",
      entityId: obj.id,
      after: obj.toObject(),
    });

    return sendResponseObject({
      res,
      code: 201,
      data: {
        [this._modelName]: await obj.display({ detail: true }),
      },
    });
  };

  public checkOutController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const organizationId = req.auth!.organizationId!;
    const employeeId = req.auth!.employeeId!;
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
      validationRules: {
        [constants.fields.OfficeLocation.latitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -90 },
          { rule: "maxValue", value: 90 },
        ],
        [constants.fields.OfficeLocation.longitude]: [
          { rule: "required" },
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: -180 },
          { rule: "maxValue", value: 180 },
        ],
        accuracyMeters: [
          { rule: "datatype", datatype: "Number" },
          { rule: "minValue", value: 0 },
        ],
        address: [{ rule: "datatype", datatype: "String" }],
      },
    });

    if (!isValid) return next(errorMessages);

    const location = this.getLocationData(postData);

    const obj = await this.dbReadRecord({
      readFilter: {
        organizationId,
        employeeId,
        status: { $in: ["open", "flagged"] },
        checkOutAt: { $exists: false },
      },
      options: { sort: { checkInAt: -1 } },
      baseFilter: false,
    });

    if (!obj) {
      return next(
        new ConflictException("No open attendance session was found"),
      );
    }

    const officeData = await this.getOfficeDistance({
      organizationId,
      officeLocationId: obj.officeLocationId,
      latitude: location.latitude,
      longitude: location.longitude,
    });

    const checkOutAt = new Date();
    const pausedTasks = await pauseEmployeeTimersAtCheckout({ organizationId, employeeId, userId: req.auth!.userId, at: checkOutAt });
    const updatedObj = await this.dbUpdateRecord({
      obj,
      filterObj: false,
      data: {
        checkOutAt,
        checkOutLocation: location,
        checkOutDistanceMeters: officeData.distance,
        checkOutWithinGeofence: officeData.withinGeofence,
        status:
          obj.checkInWithinGeofence === false ||
          officeData.withinGeofence === false
            ? "flagged"
            : "completed",
      },
    });

    await writeAudit({
      organizationId,
      actorUserId: req.auth!.userId,
      action: "attendance.checked_out",
      entityType: "Attendance",
      entityId: obj.id,
      after: updatedObj.toObject(),
    });

    return sendResponseObject({
      res,
      data: {
        [this._modelName]: await updatedObj.display({ detail: true }),
        pausedTaskCount: pausedTasks.length,
      },
    });
  };

  public viewController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);

    const readFilter: Record<string, any> = {
      organizationId: req.auth!.organizationId,
      employeeId: req.auth!.employeeId,
    };

    if (req.query.from || req.query.to) {
      readFilter.workDate = {
        ...(req.query.from && { $gte: req.query.from }),
        ...(req.query.to && { $lte: req.query.to }),
      };
    }

    const objs = await this.dbReadRecords({
      readFilter,
      page,
      limit,
      sort: { checkInAt: -1 },
      paginate: true,
      baseFilter: false,
    });

    const totalCount = await this.dbCountDocs({
      readFilter,
      baseFilter: false,
    });

    const schedules = await this.scheduleLookup(req.auth!.organizationId!, [req.auth!.employeeId!]);
    const schedule = schedules.get(req.auth!.employeeId!);

    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          objs.map(async (obj) => ({ ...(await obj.display({ detail: true })), ...attendanceMetrics(obj, schedule || undefined) })),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
      },
    });
  };
}

const AttendanceController = new AttendanceControllerClass();
export default AttendanceController;
