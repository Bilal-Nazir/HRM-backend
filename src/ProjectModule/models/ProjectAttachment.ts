import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, taskId: 1, createdAt: 1 })
export class ProjectAttachmentClass extends BaseModelClass<ProjectAttachmentClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ProjectClass", true) projectId!: string;
  @mongoRef("ProjectTaskClass", true) taskId!: string;
  @mongoRef("UserClass", true) uploadedByUserId!: string;
  @mongoRef("EmployeeClass") uploadedByEmployeeId?: string;
  @prop({ required: true }) originalName!: string;
  @prop({ required: true }) storedName!: string;
  @prop({ required: true }) mimeType!: string;
  @prop({ required: true }) size!: number;
}
export default getModelForClass(ProjectAttachmentClass, baseModelOptions);
