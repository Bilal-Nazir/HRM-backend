import TypeGoose, { DocumentType, prop, Ref } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { OrganizationClass } from "./Organization";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

export class WorkDay {
  @prop({ required: true }) public day!: number;
  @prop({ required: true }) public startTime!: string;
  @prop({ required: true }) public endTime!: string;
  @prop({ default: true }) public working!: boolean;
}
export class WorkScheduleClass extends BaseModelClass<WorkScheduleClass> {
  @prop({ required: true, ref: () => OrganizationClass })
  public organizationId!: Ref<OrganizationClass>;
  @prop({ required: true }) public name!: string;
  @prop({ required: true }) public timezone!: string;
  @prop({ type: () => [WorkDay], default: [] })
  public weeklyPattern!: WorkDay[];
  @prop({ min: 0 }) public expectedHours?: number;
  @prop({ default: "active", enum: ["active", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<WorkScheduleClass>,
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
        [constants.fields.WorkSchedule.name]: this.name,
        [constants.fields.WorkSchedule.timezone]: this.timezone,
        [constants.fields.WorkSchedule.weeklyPattern]: this.weeklyPattern,
        [constants.fields.WorkSchedule.expectedHours]: this.expectedHours,
        [constants.fields.WorkSchedule.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.WorkSchedule.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(WorkScheduleClass, baseModelOptions);
