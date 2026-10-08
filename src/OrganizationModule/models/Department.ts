import TypeGoose, {
  DocumentType,
  index,
  prop,
  Ref,
} from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { OrganizationClass } from "./Organization";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, name: 1 }, { unique: true })
export class DepartmentClass extends BaseModelClass<DepartmentClass> {
  @prop({ required: true, ref: () => OrganizationClass })
  public organizationId!: Ref<OrganizationClass>;
  @prop({ required: true, trim: true }) public name!: string;
  @prop({ trim: true }) public code?: string;
  @prop() public headEmployeeId?: string;
  @prop({ default: "active", enum: ["active", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<DepartmentClass>,
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
        [constants.fields.Department.name]: this.name,
        [constants.fields.Department.code]: this.code,
        [constants.fields.Department.headEmployeeId]: this.headEmployeeId,
        [constants.fields.Department.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.Department.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(DepartmentClass, baseModelOptions);
