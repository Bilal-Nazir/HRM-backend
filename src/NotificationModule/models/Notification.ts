import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, recipientUserId: 1, readAt: 1, createdAt: -1 })
@index({ organizationId: 1, recipientEmployeeId: 1, createdAt: -1 })
export class NotificationClass extends BaseModelClass<NotificationClass> {
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) recipientUserId!: string;
  @prop() recipientEmployeeId?: string;
  @prop({ required: true }) type!: string;
  @prop({ required: true, trim: true }) title!: string;
  @prop({ required: true, trim: true }) message!: string;
  @prop({ required: true }) href!: string;
  @prop() actorUserId?: string;
  @prop() actorEmployeeId?: string;
  @prop() projectId?: string;
  @prop() taskId?: string;
  @prop() readAt?: Date;
}

export default getModelForClass(NotificationClass, baseModelOptions);
