import TypeGoose, {
  DocumentType,
  index,
  prop,
  Ref,
} from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { OrganizationClass } from "../../OrganizationModule/models/Organization";
import { constants } from "../../node-base/constants";

const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, loginId: 1 }, { unique: true })
export class UserClass extends BaseModelClass<UserClass> {
  @prop({ ref: () => OrganizationClass })
  public organizationId?: Ref<OrganizationClass>;

  @prop({ required: true, trim: true, lowercase: true })
  public loginId!: string;

  @prop({ required: true, select: false })
  public passwordHash!: string;

  @prop({ default: 0 })
  public credentialVersion!: number;

  @prop({ default: true })
  public isActive!: boolean;

  @prop({ default: false })
  public isPlatformAdmin!: boolean;

  public async display(
    this: DocumentType<UserClass>,
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
        [constants.fields.User.loginId]: this.loginId,
        [constants.fields.User.isActive]: this.isActive,
        [constants.fields.User.isPlatformAdmin]: this.isPlatformAdmin,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.User.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}

const UserModel = getModelForClass(UserClass, baseModelOptions);
export default UserModel;
