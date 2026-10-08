import { Request } from "express";

export interface AuthUser {
  userId: string;
  employeeId?: string;
  organizationId?: string;
  permissions: string[];
  credentialVersion?: number;
  sessionId?: string;
  tokenId?: string;
  tokenType?: "access" | "refresh";
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthUser;
}
