import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, projectId: 1, employeeId: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } })
@index({ organizationId: 1, employeeId: 1, status: 1 })
export class ProjectMemberClass extends BaseModelClass<ProjectMemberClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop({ required: true }) employeeId!: string;
  @prop({ enum: ["project_manager", "member", "viewer"], default: "member" }) role!: string;
  @prop({ enum: ["active", "removed"], default: "active" }) status!: string;
  @prop({ required: true }) addedBy!: string;
  @prop() removedAt?: Date;
}
export default getModelForClass(ProjectMemberClass, baseModelOptions);
