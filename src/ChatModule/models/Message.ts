import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef, mongoRefs } from "../../common/mongoReferences";

@index({ organizationId: 1, conversationId: 1, createdAt: -1, _id: -1 })
@index(
  { organizationId: 1, conversationId: 1, senderUserId: 1, clientMessageId: 1 },
  { unique: true },
)
@index({
  organizationId: 1,
  conversationId: 1,
  mentionedUserIds: 1,
  createdAt: -1,
})
export class ChatMessageClass extends BaseModelClass<ChatMessageClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ChatConversationClass", true) conversationId!: string;
  @mongoRef("UserClass", true) senderUserId!: string;
  @prop({ required: true }) senderName!: string;
  @prop({ required: true, trim: true, maxlength: 5000 }) body!: string;
  @prop({ required: true }) clientMessageId!: string;
  @mongoRefs("UserClass") recipientUserIds!: string[];
  @mongoRefs("UserClass") mentionedUserIds!: string[];
  @prop({ type: () => [String], default: [] }) mentionedNames!: string[];
  @mongoRef("ChatMessageClass") replyToMessageId?: string;
  @prop() replyToName?: string;
  @prop() replyToBody?: string;
}
export default TypeGoose.getModelForClass(ChatMessageClass, baseModelOptions);
