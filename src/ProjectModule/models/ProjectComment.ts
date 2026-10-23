import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, taskId: 1, createdAt: 1 })
export class ProjectCommentClass extends BaseModelClass<ProjectCommentClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop({ required: true }) taskId!: string;
  @prop() authorEmployeeId?: string;
  @prop({ required: true, trim: true }) body!: string;
}
export default getModelForClass(ProjectCommentClass, baseModelOptions);
