import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, projectId: 1, createdAt: -1 })
@index({ organizationId: 1, taskId: 1, createdAt: -1 })
export class ProjectActivityClass extends BaseModelClass<ProjectActivityClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ProjectClass", true) projectId!: string;
  @mongoRef("ProjectTaskClass") taskId?: string;
  @mongoRef("UserClass") actorUserId?: string;
  @prop({ enum: ["user", "system"], default: "user" }) actorType!: string;
  @mongoRef("EmployeeClass") actorEmployeeId?: string;
  @prop({ required: true }) action!: string;
  @prop({ type: () => Object }) changes?: Record<string, unknown>;
}
export default getModelForClass(ProjectActivityClass, baseModelOptions);
