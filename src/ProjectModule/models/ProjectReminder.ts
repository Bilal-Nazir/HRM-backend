import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, projectId: 1, scheduledAt: 1 })
export class ProjectReminderClass extends BaseModelClass<ProjectReminderClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ProjectClass", true) projectId!: string;
  @prop({ required: true, trim: true }) title!: string;
  @prop({ trim: true }) note?: string;
  @prop({ required: true }) scheduledAt!: Date;
  @mongoRef("UserClass", true) createdBy!: string;
  @mongoRef("EmployeeClass") createdByEmployeeId?: string;
}

export default getModelForClass(ProjectReminderClass, baseModelOptions);
