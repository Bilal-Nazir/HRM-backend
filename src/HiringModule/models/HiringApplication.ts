import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef } from "../../common/mongoReferences";

export class HiringAnswer {
  @prop({ required: true }) questionId!: string;
  @prop({ required: true }) label!: string;
  @prop({ default: "" }) value!: string;
}
@index({ pageId: 1, email: 1 }, { unique: true })
@index({ organizationId: 1, pageId: 1, createdAt: -1 })
export class HiringApplicationClass extends BaseModelClass<HiringApplicationClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("HiringPageClass", true) pageId!: string;
  @prop({ required: true }) pageTitle!: string;
  @prop({ required: true, maxlength: 120 }) name!: string;
  @prop({ required: true, maxlength: 254 }) email!: string;
  @prop({ default: "", maxlength: 60 }) phone!: string;
  @prop({ default: "", maxlength: 8000 }) coverLetter!: string;
  @prop({ type: () => [HiringAnswer], default: [] }) answers!: HiringAnswer[];
  @prop({
    enum: ["new", "reviewing", "shortlisted", "rejected", "hired"],
    default: "new",
  })
  status!: string;
  @prop({ default: "", maxlength: 10000 }) notes!: string;
  @mongoRef("UserClass") reviewedBy?: string;
  @prop() reviewedAt?: Date;
  @prop({ required: true }) consentAt!: Date;
  @prop({ required: true }) cvName!: string;
  @prop({ required: true }) cvType!: string;
  @prop({ required: true }) cvSize!: number;
  @prop({ type: () => Buffer, required: true, select: false }) cvData!: Buffer;
}
export default TypeGoose.getModelForClass(
  HiringApplicationClass,
  baseModelOptions,
);
