import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index(
  { organizationId: 1, projectId: 1, issueNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)
@index({ organizationId: 1, projectId: 1, workflowStatusId: 1, updatedAt: -1 })
@index({ organizationId: 1, assigneeEmployeeIds: 1, updatedAt: -1 })
@index({
  organizationId: 1,
  projectId: 1,
  title: "text",
  key: "text",
  labels: "text",
})
@index({ reminder24hSentAt: 1, dueDate: 1 })
@index({ autoCompleteAt: 1, isDeleted: 1 })
@index({ autoCompletionPending: 1 })
@index({ autoPausePending: 1 })
export class ProjectTaskClass extends BaseModelClass<ProjectTaskClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ProjectClass", true) projectId!: string;
  @prop({ required: true }) issueNumber!: number;
  @prop({ required: true }) key!: string;
  @prop({ enum: ["story", "task"], default: "task" }) type!: string;
  @prop({ required: true, trim: true }) title!: string;
  @prop({ trim: true }) description?: string;
  @mongoRef("ProjectTaskClass") parentStoryId?: string;
  @mongoRefs("EmployeeClass") assigneeEmployeeIds!: string[];
  // Admin accounts are organization users and may not have an employee record.
  @mongoRef("EmployeeClass") reporterEmployeeId?: string;
  @mongoRef("UserClass", true) createdBy!: string;
  @prop({ enum: ["low", "medium", "high", "critical"], default: "medium" })
  priority!: string;
  @mongoRef("WorkflowStatusClass", true) workflowStatusId!: string;
  @prop() startDate?: Date;
  @prop() dueDate?: Date;
  @prop() reminder24hSentAt?: Date;
  @prop({ min: 0 }) estimatedHours?: number;
  @prop({ type: () => [String], default: [] }) labels!: string[];
  @prop() timeStartedAt?: Date;
  @prop() timeStoppedAt?: Date;
  @prop({ default: 0, min: 0 }) accumulatedSeconds!: number;
  @prop({ min: 1 }) durationMinutes?: number;
  @prop() autoCompleteAt?: Date;
  @prop({ enum: ["manual", "auto"] }) completionMethod?: string;
  @prop() completedAt?: Date;
  // Persist settlement data so a process restart cannot lose the work log/history.
  @prop() autoCompletionId?: string;
  @prop() autoCompletionStartedAt?: Date;
  @mongoRef("WorkflowStatusClass") autoCompletionFromStatusId?: string;
  @prop() autoCompletionPending?: boolean;
  @prop() autoPaused?: boolean;
  @prop() autoPausedAt?: Date;
  @prop() durationExtensionRequired?: boolean;
  @prop() autoPauseId?: string;
  @prop() autoPauseStartedAt?: Date;
  @mongoRef("WorkflowStatusClass") autoPauseFromStatusId?: string;
  @mongoRef("WorkflowStatusClass") autoPauseStatusId?: string;
  @prop() autoPausePending?: boolean;
}
export default getModelForClass(ProjectTaskClass, baseModelOptions);
