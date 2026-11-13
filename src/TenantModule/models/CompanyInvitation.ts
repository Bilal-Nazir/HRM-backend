import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef } from "../../common/mongoReferences";
@index({ tokenHash: 1 }, { unique: true })
@index({ organizationId: 1, email: 1, status: 1 })
export class CompanyInvitationClass extends BaseModelClass<CompanyInvitationClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("EmployeeClass", true) employeeId!: string;
  @mongoRef("UserClass", true) invitedByUserId!: string;
  @prop({ required: true, lowercase: true, trim: true }) email!: string;
  @prop({ required: true, select: false }) tokenHash!: string;
  @prop({ required: true }) expiresAt!: Date;
  @prop({ enum: ["pending", "accepted", "revoked"], default: "pending" })
  status!: string;
  @prop() acceptedAt?: Date;
}
export default TypeGoose.getModelForClass(
  CompanyInvitationClass,
  baseModelOptions,
);
