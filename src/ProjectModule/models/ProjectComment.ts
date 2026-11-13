import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, taskId: 1, createdAt: 1 })
export class ProjectCommentClass extends BaseModelClass<ProjectCommentClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ProjectClass", true) projectId!: string;
  @mongoRef("ProjectTaskClass", true) taskId!: string;
  @mongoRef("EmployeeClass") authorEmployeeId?: string;
  @mongoRef("UserClass") authorUserId?: string;
  @mongoRefs("EmployeeClass") mentionedEmployeeIds!: string[];
  @prop({ required: true, trim: true }) body!: string;
}
export default getModelForClass(ProjectCommentClass, baseModelOptions);
