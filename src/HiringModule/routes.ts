import { Router, Response, Request, NextFunction } from "express";
import { randomBytes, createHash } from "crypto";
import { isValidObjectId } from "mongoose";
import { AuthenticatedRequest } from "../AuthModule/utils/types";
import {
  authMiddleware,
  requireOrganization,
} from "../AuthModule/utils/authMiddleware";
import { requireCompanyOwner } from "../TenantModule/services/companyContext";
import Organization from "../OrganizationModule/models/Organization";
import Page from "./models/HiringPage";
import Application from "./models/HiringApplication";
import {
  asyncWrapper,
  sendResponseObject,
  ValidationException,
  ObjectNotFoundException,
} from "../node-base/utils";
import { Database as Redis } from "../node-base/baseClasses/Redis";
import config from "../common/config";
import { createNotifications } from "../NotificationModule/services/notificationService";
import {
  applicantStatuses,
  choice,
  cvInput,
  pageInput,
  text,
} from "./validation";

const active = { isDeleted: { $ne: true } };
const ok = (res: Response, data: Record<string, unknown>) =>
  sendResponseObject({ res, data });
const id = (value: unknown) => {
  if (typeof value !== "string" || !isValidObjectId(value))
    throw new ValidationException("Invalid record ID");
  return value;
};
const pageDto = (page: any) => ({
  id: String(page._id),
  publicId: page.publicId,
  title: page.title,
  introduction: page.introduction,
  description: page.description,
  location: page.location,
  workMode: page.workMode,
  employmentType: page.employmentType,
  accentColor: page.accentColor,
  status: page.status,
  questions: page.questions.map((q: any) => ({
    id: q.id,
    label: q.label,
    required: q.required,
  })),
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
  publishedAt: page.publishedAt,
});
const applicationDto = (row: any, detail = false) => ({
  id: String(row._id),
  pageId: String(row.pageId),
  pageTitle: row.pageTitle,
  name: row.name,
  email: row.email,
  phone: row.phone,
  status: row.status,
  createdAt: row.createdAt,
  cvName: row.cvName,
  cvType: row.cvType,
  cvSize: row.cvSize,
  ...(detail && {
    coverLetter: row.coverLetter,
    answers: row.answers,
    notes: row.notes,
    reviewedAt: row.reviewedAt,
    consentAt: row.consentAt,
  }),
});
async function ownedPage(req: AuthenticatedRequest) {
  const page = await Page.findOne({
    _id: id(req.params.id),
    organizationId: req.auth!.organizationId,
    ...active,
  });
  if (!page) throw new ObjectNotFoundException("Hiring page");
  return page;
}
async function ownedApplication(req: AuthenticatedRequest, cv = false) {
  const query = Application.findOne({
    _id: id(req.params.id),
    organizationId: req.auth!.organizationId,
    ...active,
  });
  if (cv) query.select("+cvData");
  const application = await query;
  if (!application) throw new ObjectNotFoundException("Application");
  return application;
}

export const HiringRouter = Router();
HiringRouter.use(
  authMiddleware(),
  requireOrganization,
  (req: AuthenticatedRequest, _res, next) => {
    try {
      requireCompanyOwner(req.auth!);
      next();
    } catch (error) {
      next(error);
    }
  },
);
HiringRouter.get(
  "/pages",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) => {
    const pages = await Page.find({
      organizationId: req.auth!.organizationId,
      ...active,
    })
      .sort({ createdAt: -1 })
      .limit(200);
    const counts = await Application.aggregate([
      { $match: { organizationId: req.auth!.organizationId, ...active } },
      {
        $group: {
          _id: "$pageId",
          total: { $sum: 1 },
          unread: { $sum: { $cond: [{ $eq: ["$status", "new"] }, 1, 0] } },
        },
      },
    ]);
    const byPage = new Map(counts.map((c: any) => [String(c._id), c]));
    ok(res, {
      pages: pages.map((p) => ({
        ...pageDto(p),
        applicants: byPage.get(p.id)?.total || 0,
        newApplicants: byPage.get(p.id)?.unread || 0,
      })),
    });
  }),
);
HiringRouter.post(
  "/pages",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) => {
    const input = pageInput(req.body);
    const page = await Page.create({
      ...input,
      organizationId: req.auth!.organizationId,
      createdBy: req.auth!.userId,
      publicId: randomBytes(18).toString("hex"),
      ...(input.status === "published" && { publishedAt: new Date() }),
    });
    ok(res, { page: pageDto(page) });
  }),
);
HiringRouter.get(
  "/pages/:id",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) =>
    ok(res, { page: pageDto(await ownedPage(req)) }),
  ),
);
HiringRouter.patch(
  "/pages/:id",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) => {
    const page = await ownedPage(req),
      input = pageInput(req.body, pageDto(page));
    Object.assign(page, input);
    if (page.status === "published" && !page.publishedAt)
      page.publishedAt = new Date();
    await page.save();
    ok(res, { page: pageDto(page) });
  }),
);
HiringRouter.get(
  "/applications",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) => {
    const query: any = { organizationId: req.auth!.organizationId, ...active };
    if (req.query.pageId) query.pageId = id(req.query.pageId);
    if (req.query.status)
      query.status = choice(
        req.query.status,
        applicantStatuses,
        "application status",
      );
    if (req.query.search) {
      const search = text(req.query.search, "Search", 120).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    const page = Math.floor(
      Math.max(1, Math.min(100000, Number(req.query.page) || 1)),
    );
    const [rows, total] = await Promise.all([
      Application.find(query)
        .select("-coverLetter -answers -notes")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * 25)
        .limit(25),
      Application.countDocuments(query),
    ]);
    ok(res, {
      applications: rows.map((row) => applicationDto(row)),
      total,
      page,
      pageSize: 25,
    });
  }),
);
HiringRouter.get(
  "/applications/:id",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) =>
    ok(res, { application: applicationDto(await ownedApplication(req), true) }),
  ),
);
HiringRouter.patch(
  "/applications/:id",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) => {
    const application = await ownedApplication(req);
    if (req.body.status !== undefined)
      application.status = choice(
        req.body.status,
        applicantStatuses,
        "application status",
      );
    if (req.body.notes !== undefined)
      application.notes = text(req.body.notes, "Review notes", 10000);
    application.reviewedBy = req.auth!.userId;
    application.reviewedAt = new Date();
    await application.save();
    ok(res, { application: applicationDto(application, true) });
  }),
);
HiringRouter.get(
  "/applications/:id/cv",
  asyncWrapper(async (req: AuthenticatedRequest, res: Response) => {
    const application = await ownedApplication(req, true);
    res.set({
      "Content-Type": application.cvType,
      "Content-Length": String(application.cvSize),
      "Content-Disposition": `${application.cvType === "application/pdf" && req.query.download !== "1" ? "inline" : "attachment"}; filename="${application.cvName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    res.send(application.cvData);
  }),
);

export const CareersRouter = Router();
CareersRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
async function publicPage(publicId: unknown, accepting = false) {
  if (typeof publicId !== "string" || !/^[a-f\d]{36}$/.test(publicId))
    throw new ObjectNotFoundException("Hiring page");
  const page = await Page.findOne({
    publicId,
    status: { $in: accepting ? ["published"] : ["published", "closed"] },
    ...active,
  });
  const company =
    page &&
    (await Organization.findOne({
      _id: page.organizationId,
      status: "active",
      ...active,
    }).select("name ownerUserId"));
  if (!page || !company)
    throw new ObjectNotFoundException(
      accepting ? "Open hiring page" : "Hiring page",
    );
  return { page, company };
}
CareersRouter.get(
  "/:publicId",
  asyncWrapper(async (req: Request, res: Response) => {
    const { page, company } = await publicPage(req.params.publicId);
    // Explicit public allow-list; internal IDs, applicant records and CVs never leave this endpoint.
    const {
      id: _id,
      createdAt: _created,
      updatedAt: _updated,
      ...publicFields
    } = pageDto(page);
    ok(res, { page: { ...publicFields, companyName: company.name } });
  }),
);
async function submissionLimit(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const identity = createHash("sha256")
      .update(`${req.ip || req.socket.remoteAddress}:${req.params.publicId}`)
      .digest("hex");
    const key = `${config.jwt.sessionPrefix}:hiring-limit:${identity}:${Math.floor(Date.now() / 900000)}`;
    const count = await Redis.client.incr(key);
    if (count === 1) await Redis.client.expire(key, 901);
    if (count > 30) {
      res
        .status(429)
        .json({
          success: false,
          message:
            "Too many application attempts. Please try again in 15 minutes",
          data: {},
        });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
CareersRouter.post(
  "/:publicId/applications",
  submissionLimit,
  asyncWrapper(async (req: Request, res: Response) => {
    const { page, company } = await publicPage(req.params.publicId, true);
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      throw new ValidationException("Invalid application");
    if (req.body.website)
      throw new ValidationException("Application could not be submitted");
    if (req.body.consent !== true)
      throw new ValidationException(
        "Please agree to share your application with this company",
      );
    const name = text(req.body.name, "Full name", 120, true),
      email = text(req.body.email, "Email", 254, true).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ValidationException("Enter a valid email address");
    const answersInput = req.body.answers;
    if (
      !answersInput ||
      typeof answersInput !== "object" ||
      Array.isArray(answersInput)
    )
      throw new ValidationException("Invalid application answers");
    const answers = page.questions.map((q) => ({
      questionId: q.id,
      label: q.label,
      value: text(answersInput[q.id], q.label, 3000, q.required),
    }));
    const record = {
      organizationId: page.organizationId,
      pageId: page.id,
      pageTitle: page.title,
      name,
      email,
      phone: text(req.body.phone, "Phone", 60),
      coverLetter: text(req.body.coverLetter, "Cover letter", 8000),
      answers,
      consentAt: new Date(),
      ...cvInput(req.body.cv),
    };
    let application;
    try {
      application = await Application.create(record);
    } catch (error: any) {
      if (error.code !== 11000) throw error;
    }
    if (application) {
      // Notification failure must not lose an accepted application or trigger duplicate submissions.
      await createNotifications({
        organizationId: page.organizationId,
        recipientUserIds: company.ownerUserId ? [company.ownerUserId] : [],
        type: "hiring_application",
        title: "New job application",
        message: `${name} applied for ${page.title}`,
        href: `/settings/hiring?page=${page.id}&application=${application.id}`,
      }).catch(() =>
        console.error(
          "Hiring application saved; admin notification could not be created",
        ),
      );
    }
    // Same receipt for duplicate emails: prevents accidental resubmits and email enumeration.
    ok(res, { received: true });
  }),
);
