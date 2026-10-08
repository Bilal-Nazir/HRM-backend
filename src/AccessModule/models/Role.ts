import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, name: 1 }, { unique: true })
export class RoleClass extends BaseModelClass<RoleClass> {
  @prop() public organizationId?: string;
  @prop({ required: true }) public name!: string;
  @prop() public description?: string;
  @prop({ type: () => [String], default: [] }) public permissions!: string[];
  @prop({ default: false }) public isSystemRole!: boolean;
  @prop({ default: "active", enum: ["active", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<RoleClass>,
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
        [constants.fields.Role.name]: this.name,
        [constants.fields.Role.description]: this.description,
        [constants.fields.Role.permissions]: this.permissions,
        [constants.fields.Role.isSystemRole]: this.isSystemRole,
        [constants.fields.Role.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.Role.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(RoleClass, baseModelOptions);
