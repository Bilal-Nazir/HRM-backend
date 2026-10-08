import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, createdAt: -1 })
export class AuditLogClass extends BaseModelClass<AuditLogClass> {
  @prop({ required: true }) public organizationId!: string;
  @prop({ required: true }) public actorUserId!: string;
  @prop({ required: true, default: "user" }) public actorType!: string;
  @prop({ required: true }) public action!: string;
  @prop({ required: true }) public entityType!: string;
  @prop({ required: true }) public entityId!: string;
  @prop({ type: () => Object }) public before?: Record<string, unknown>;
  @prop({ type: () => Object }) public after?: Record<string, unknown>;
  @prop({ type: () => Object }) public metadata?: Record<string, unknown>;

  public async display(
    this: DocumentType<AuditLogClass>,
    {
      reset = false,
      includes = [],
      excludes = [],
      detail = false,
      baseData = {},
    }: {
      reset?: boolean;
      includes?: any[];
      excludes?: string[];
      detail?: boolean;
      baseData?: Record<string, any>;
    } = {},
  ) {
    let data: Record<string, any> = { [constants.fields.id]: this.id };
    if (!reset)
      data = {
        [constants.fields.id]: this.id,
        [constants.fields.AuditLog.actorUserId]: this.actorUserId,
        [constants.fields.AuditLog.actorType]: this.actorType,
        [constants.fields.AuditLog.action]: this.action,
        [constants.fields.AuditLog.entityType]: this.entityType,
        [constants.fields.AuditLog.entityId]: this.entityId,
        [constants.fields.createdAt]: this.createdAt,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.AuditLog.organizationId]: this.organizationId,
        [constants.fields.AuditLog.before]: this.before,
        [constants.fields.AuditLog.after]: this.after,
        [constants.fields.AuditLog.metadata]: this.metadata,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(AuditLogClass, baseModelOptions);
