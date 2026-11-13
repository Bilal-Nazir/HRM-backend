import { Request } from "express";

export interface AuthUser {
  userId: string;
  isPlatformAdmin?: boolean;
  isCompanyOwner?: boolean;
  companyName?: string;
  companySlug?: string;
  employeeId?: string;
  organizationId?: string;
  permissions: string[];
  // Login portal only: company ownership/roles do not grant the Super Admin portal.
  accountType?: "admin" | "employee";
  credentialVersion?: number;
  sessionId?: string;
  tokenId?: string;
  tokenType?: "access" | "refresh";
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthUser;
}
