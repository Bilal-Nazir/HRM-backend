import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { mongoRef } from "../../common/mongoReferences";

export class HiringQuestion {
  @prop({ required: true }) id!: string;
  @prop({ required: true }) label!: string;
  @prop({ default: false }) required!: boolean;
}

@index({ publicId: 1 }, { unique: true })
@index({ organizationId: 1, createdAt: -1 })
export class HiringPageClass extends BaseModelClass<HiringPageClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("UserClass", true) createdBy!: string;
  @prop({ required: true }) publicId!: string;
  @prop({ required: true, maxlength: 160 }) title!: string;
  @prop({ default: "", maxlength: 500 }) introduction!: string;
  @prop({ default: "", maxlength: 30000 }) description!: string;
  @prop({ default: "", maxlength: 160 }) location!: string;
  @prop({ enum: ["On-site", "Hybrid", "Remote"], default: "On-site" })
  workMode!: string;
  @prop({
    enum: ["Full-time", "Part-time", "Contract", "Internship"],
    default: "Full-time",
  })
  employmentType!: string;
  @prop({ default: "#0d9488" }) accentColor!: string;
  @prop({
    enum: ["draft", "published", "closed", "archived"],
    default: "draft",
  })
  status!: string;
  @prop({ type: () => [HiringQuestion], default: [] })
  questions!: HiringQuestion[];
  @prop() publishedAt?: Date;
}
export default TypeGoose.getModelForClass(HiringPageClass, baseModelOptions);
