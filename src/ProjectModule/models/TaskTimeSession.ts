import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, employeeId: 1, startedAt: -1 })
@index({ organizationId: 1, taskId: 1, startedAt: -1 })
@index({ organizationId: 1, taskId: 1, endedAt: 1 })
export class TaskTimeSessionClass extends BaseModelClass<TaskTimeSessionClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) projectId!: string;
  @prop({ required: true }) taskId!: string;
  @prop() employeeId?: string;
  @prop({ required: true }) startedByUserId!: string;
  @prop({ required: true }) startedAt!: Date;
  @prop() endedAt?: Date;
  @prop({ min: 0 }) durationSeconds?: number;
  @prop({ enum: ["pause", "status_change", "checkout"] }) stopReason?: string;
}
export default getModelForClass(TaskTimeSessionClass, baseModelOptions);
