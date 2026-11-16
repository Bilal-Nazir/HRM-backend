import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef, mongoRefs } from "../../common/mongoReferences";

@index(
  { organizationId: 1, directKey: 1 },
  { unique: true, partialFilterExpression: { kind: "direct" } },
)
@index(
  { organizationId: 1, projectId: 1 },
  { unique: true, partialFilterExpression: { kind: "project" } },
)
@index({ organizationId: 1, participantUserIds: 1, lastMessageAt: -1 })
export class ChatConversationClass extends BaseModelClass<ChatConversationClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @prop({ required: true, enum: ["direct", "project"] }) kind!: string;
  @prop() directKey?: string;
  @mongoRef("ProjectClass") projectId?: string;
  @mongoRefs("UserClass") participantUserIds!: string[];
  @prop({ type: () => [String], default: [] }) participantNames!: string[];
  @mongoRef("UserClass", true) createdByUserId!: string;
  @mongoRef("ChatMessageClass") lastMessageId?: string;
  @prop() lastMessagePreview?: string;
  @prop() lastMessageAt?: Date;
}
export default TypeGoose.getModelForClass(
  ChatConversationClass,
  baseModelOptions,
);
