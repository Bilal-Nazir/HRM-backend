import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";

const { getModelForClass } = TypeGoose;

@index({ slug: 1 }, { unique: true })
export class OrganizationClass extends BaseModelClass<OrganizationClass> {
  @prop({ required: true, trim: true }) public name!: string;
  @prop({ trim: true }) public legalName?: string;
  @prop({ required: true, trim: true, lowercase: true }) public slug!: string;
  @prop({ required: true, default: "UTC" }) public timezone!: string;
  @prop({ default: "en" }) public defaultLocale?: string;
  @prop({ default: "active", enum: ["active", "suspended", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<OrganizationClass>,
    {
      reset = false,
      includes = [],
      excludes = [],
      detail = false,
      baseData = {},
    }: {
      reset?: boolean;
      includes?: any[];
      excludes?: string[];
      detail?: boolean;
      baseData?: Record<string, any>;
    } = {},
  ) {
    let data: Record<string, any> = { [constants.fields.id]: this.id };
    if (!reset)
      data = {
        [constants.fields.id]: this.id,
        [constants.fields.Organization.name]: this.name,
        [constants.fields.Organization.legalName]: this.legalName,
        [constants.fields.Organization.slug]: this.slug,
        [constants.fields.Organization.timezone]: this.timezone,
        [constants.fields.Organization.defaultLocale]: this.defaultLocale,
        [constants.fields.Organization.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}

export default getModelForClass(OrganizationClass, baseModelOptions);
