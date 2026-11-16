import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef } from "../../common/mongoReferences";

@index({ organizationId: 1, requestId: 1, createdAt: 1 })
export class LeaveRequestCommentClass extends BaseModelClass<LeaveRequestCommentClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("LeaveRequestClass", true) requestId!: string;
  @mongoRef("UserClass", true) authorUserId!: string;
  @mongoRef("EmployeeClass") authorEmployeeId?: string;
  @prop({ required: true }) authorName!: string;
  @prop({ required: true, enum: ["admin", "manager", "employee"] })
  authorRole!: string;
  @prop({ required: true, trim: true, maxlength: 4000 }) body!: string;
}
export default TypeGoose.getModelForClass(
  LeaveRequestCommentClass,
  baseModelOptions,
);
