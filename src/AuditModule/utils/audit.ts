import AuditLogModel from "../models/AuditLog";

export const writeAudit = (data: {
  organizationId: string; actorUserId: string; action: string;
  entityType: string; entityId: string; before?: any;
  after?: any; metadata?: Record<string, unknown>;
}) => AuditLogModel.create(data);
