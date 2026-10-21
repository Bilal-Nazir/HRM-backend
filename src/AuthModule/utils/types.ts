import { Request } from "express";

export interface AuthUser {
  userId: string;
  employeeId?: string;
  organizationId?: string;
  permissions: string[];
  accountType?: "admin" | "employee";
  credentialVersion?: number;
  sessionId?: string;
  tokenId?: string;
  tokenType?: "access" | "refresh";
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthUser;
}
