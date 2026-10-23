import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, key: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } })
@index({ organizationId: 1, status: 1, updatedAt: -1 })
export class ProjectClass extends BaseModelClass<ProjectClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true, trim: true }) name!: string;
  @prop({ required: true, uppercase: true, trim: true }) key!: string;
  @prop({ trim: true }) description?: string;
  @prop() managerEmployeeId?: string;
  @prop() startDate?: Date;
  @prop() targetEndDate?: Date;
  @prop({ enum: ["low", "medium", "high", "critical"], default: "medium" }) priority!: string;
  @prop({ enum: ["planned", "active", "on_hold", "completed", "archived"], default: "planned" }) status!: string;
  @prop({ required: true }) createdBy!: string;
  @prop({ default: 1 }) nextIssueNumber!: number;
}
export default getModelForClass(ProjectClass, baseModelOptions);
