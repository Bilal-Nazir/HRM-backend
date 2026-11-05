import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, projectId: 1, scheduledAt: 1 })
export class ProjectReminderClass extends BaseModelClass<ProjectReminderClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop({ required: true, trim: true }) title!: string;
  @prop({ trim: true }) note?: string;
  @prop({ required: true }) scheduledAt!: Date;
  @prop({ required: true }) createdBy!: string;
  @prop() createdByEmployeeId?: string;
}

export default getModelForClass(ProjectReminderClass, baseModelOptions);
