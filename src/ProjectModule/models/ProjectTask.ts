import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, projectId: 1, issueNumber: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } })
@index({ organizationId: 1, projectId: 1, workflowStatusId: 1, updatedAt: -1 })
@index({ organizationId: 1, assigneeEmployeeIds: 1, updatedAt: -1 })
@index({ organizationId: 1, projectId: 1, title: "text", key: "text", labels: "text" })
export class ProjectTaskClass extends BaseModelClass<ProjectTaskClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop({ required: true }) issueNumber!: number;
  @prop({ required: true }) key!: string;
  @prop({ enum: ["story", "task"], default: "task" }) type!: string;
  @prop({ required: true, trim: true }) title!: string;
  @prop({ trim: true }) description?: string;
  @prop() parentStoryId?: string;
  @prop({ type: () => [String], default: [] }) assigneeEmployeeIds!: string[];
  @prop({ required: true }) reporterEmployeeId!: string;
  @prop({ required: true }) createdBy!: string;
  @prop({ enum: ["low", "medium", "high", "critical"], default: "medium" }) priority!: string;
  @prop({ required: true }) workflowStatusId!: string;
  @prop() startDate?: Date;
  @prop() dueDate?: Date;
  @prop({ min: 0 }) estimatedHours?: number;
  @prop({ type: () => [String], default: [] }) labels!: string[];
  @prop() timeStartedAt?: Date;
  @prop() timeStoppedAt?: Date;
  @prop({ default: 0, min: 0 }) accumulatedSeconds!: number;
}
export default getModelForClass(ProjectTaskClass, baseModelOptions);
