import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef } from "../../common/mongoReferences";
@index({ organizationId: 1, userId: 1 }, { unique: true })
@index({ userId: 1, status: 1, isDeleted: 1 })
export class CompanyMembershipClass extends BaseModelClass<CompanyMembershipClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("UserClass", true) userId!: string;
  @mongoRef("EmployeeClass") employeeId?: string;
  @prop({ enum: ["active", "suspended"], default: "active" }) status!: string;
}
export default TypeGoose.getModelForClass(
  CompanyMembershipClass,
  baseModelOptions,
);
