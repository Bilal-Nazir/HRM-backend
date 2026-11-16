import { Express, Request, Response } from "express";
import TenantRouter from "../TenantModule/routes";
import {
  authMiddleware,
  requireOrganization,
} from "../AuthModule/utils/authMiddleware";
import EmployeeRouter from "../EmployeeModule/routes";
import AuthRouter from "../AuthModule/routes";
import OrganizationRouter from "../OrganizationModule/routes";
import AccessRouter from "../AccessModule/routes";
import AttendanceRouter from "../AttendanceModule/routes";
import LeaveRouter from "../LeaveModule/routes";
import AuditRouter from "../AuditModule/routes";
import TermsRouter from "../TermsModule/routes";
import AnnouncementRouter from "../AnnouncementModule/routes";
import ProjectRouter from "../ProjectModule/routes";
import NotificationRouter from "../NotificationModule/routes";
import ChatRouter from "../ChatModule/routes";
import { HiringRouter, CareersRouter } from "../HiringModule/routes";

const registerRoutes = (app: Express) => {
  app.use("/companies", TenantRouter);
  app.use("/careers", CareersRouter);
  app.use(
    [
      "/employee",
      "/organization",
      "/access",
      "/attendance",
      "/leave",
      "/audit",
      "/terms",
      "/announcements",
      "/projects",
      "/notifications",
      "/chat",
    ],
    authMiddleware(),
    requireOrganization,
  );
  app.use("/employee", EmployeeRouter);
  app.use("/auth", AuthRouter);
  app.use("/organization", OrganizationRouter);
  app.use("/access", AccessRouter);
  app.use("/attendance", AttendanceRouter);
  app.use("/leave", LeaveRouter);
  app.use("/audit", AuditRouter);
  app.use("/terms", TermsRouter);
  app.use("/announcements", AnnouncementRouter);
  app.use("/projects", ProjectRouter);
  app.use("/notifications", NotificationRouter);
  app.use("/chat", ChatRouter);
  app.use("/hiring", HiringRouter);
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ message: "HRM backend is running" });
  });
};

export default registerRoutes;
