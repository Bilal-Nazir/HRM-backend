import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, name: 1 }, { unique: true })
export class LeaveTypeClass extends BaseModelClass<LeaveTypeClass> {
  @prop({ required: true }) public organizationId!: string;
  @prop({ required: true, trim: true }) public name!: string;
  @prop({ trim: true }) public code?: string;
  @prop({ default: true }) public isPaid!: boolean;
  @prop({ min: 0, default: 0 }) public annualAllowanceDays!: number;
  @prop({ default: false }) public requiresAttachment!: boolean;
  @prop({ default: "active", enum: ["active", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<LeaveTypeClass>,
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
        [constants.fields.LeaveType.name]: this.name,
        [constants.fields.LeaveType.code]: this.code,
        [constants.fields.LeaveType.isPaid]: this.isPaid,
        [constants.fields.LeaveType.annualAllowanceDays]:
          this.annualAllowanceDays,
        [constants.fields.LeaveType.requiresAttachment]:
          this.requiresAttachment,
        [constants.fields.LeaveType.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.LeaveType.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(LeaveTypeClass, baseModelOptions);
