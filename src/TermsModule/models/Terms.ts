import TypeGoose, {
  DocumentType,
  index,
  prop,
  Ref,
} from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
import { OrganizationClass } from "../../OrganizationModule/models/Organization";
import { UserClass } from "../../AuthModule/models/User";

const { getModelForClass } = TypeGoose;
const fields = constants.fields.Terms;

@index({ [fields.organizationId]: 1 }, { unique: true })
export class TermsClass extends BaseModelClass<TermsClass> {
  @prop({ required: true, ref: () => OrganizationClass })
  public organizationId!: Ref<OrganizationClass>;
  @prop({ required: true, trim: true, maxlength: 160 }) public title!: string;
  @prop({ required: true, trim: true, maxlength: 50000 })
  public content!: string;
  @prop({ required: true, ref: () => UserClass })
  public updatedBy!: Ref<UserClass>;

  public async display(
    this: DocumentType<TermsClass>,
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
        ...data,
        [fields.title]: this.title,
        [fields.content]: this.content,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    if (detail)
      data = {
        ...data,
        [fields.organizationId]: this.organizationId,
        [fields.updatedBy]: this.updatedBy,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}

export default getModelForClass(TermsClass, baseModelOptions);
