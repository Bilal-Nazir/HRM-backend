import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index(
  { organizationId: 1, projectId: 1, employeeId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)
@index({ organizationId: 1, employeeId: 1, status: 1 })
export class ProjectMemberClass extends BaseModelClass<ProjectMemberClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ProjectClass", true) projectId!: string;
  @mongoRef("EmployeeClass", true) employeeId!: string;
  @prop({ enum: ["project_manager", "member", "viewer"], default: "member" })
  role!: string;
  @prop({ enum: ["active", "removed"], default: "active" }) status!: string;
  @mongoRef("UserClass", true) addedBy!: string;
  @prop() removedAt?: Date;
}
export default getModelForClass(ProjectMemberClass, baseModelOptions);
