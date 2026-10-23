import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, projectId: 1, createdAt: -1 })
@index({ organizationId: 1, taskId: 1, createdAt: -1 })
export class ProjectActivityClass extends BaseModelClass<ProjectActivityClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop() taskId?: string;
  @prop({ required: true }) actorUserId!: string;
  @prop() actorEmployeeId?: string;
  @prop({ required: true }) action!: string;
  @prop({ type: () => Object }) changes?: Record<string, unknown>;
}
export default getModelForClass(ProjectActivityClass, baseModelOptions);
