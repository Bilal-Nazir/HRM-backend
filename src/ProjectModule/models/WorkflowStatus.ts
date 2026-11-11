import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, projectId: 1, order: 1 })
@index({ organizationId: 1, projectId: 1, systemKey: 1 }, { unique: true, partialFilterExpression: { systemKey: "pause", isDeleted: false } })
export class WorkflowStatusClass extends BaseModelClass<WorkflowStatusClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop({ required: true, trim: true }) name!: string;
  @prop({ required: true }) order!: number;
  @prop({ enum: ["todo", "in_progress", "paused", "done"], default: "todo" }) category!: string;
  @prop({ enum: ["pause"] }) systemKey?: string;
  @prop({ default: "#7c8b84" }) color!: string;
  @prop({ default: false }) isDefault!: boolean;
  @prop({ default: false }) isArchived!: boolean;
  @prop({ type: () => [String], default: [] }) allowedTransitionIds!: string[];
  @prop({ type: () => [String], default: ["project_manager", "member"] }) moveRoles!: string[];
  @prop({ enum: ["none", "start", "stop"] }) timerAction?: string;
}
export default getModelForClass(WorkflowStatusClass, baseModelOptions);
