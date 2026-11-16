import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef } from "../../common/mongoReferences";

@index(
  { organizationId: 1, messageId: 1, recipientUserId: 1 },
  { unique: true },
)
@index({ organizationId: 1, recipientUserId: 1, readAt: 1, conversationId: 1 })
export class ChatReceiptClass extends BaseModelClass<ChatReceiptClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("ChatConversationClass", true) conversationId!: string;
  @mongoRef("ChatMessageClass", true) messageId!: string;
  @mongoRef("UserClass", true) recipientUserId!: string;
  @prop({ default: false }) mentioned!: boolean;
  @prop() readAt?: Date;
}
export default TypeGoose.getModelForClass(ChatReceiptClass, baseModelOptions);
