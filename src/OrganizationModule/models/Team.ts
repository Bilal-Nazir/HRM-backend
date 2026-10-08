import TypeGoose, {
  DocumentType,
  index,
  prop,
  Ref,
} from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { OrganizationClass } from "./Organization";
import { DepartmentClass } from "./Department";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

@index({ organizationId: 1, name: 1 }, { unique: true })
export class TeamClass extends BaseModelClass<TeamClass> {
  @prop({ required: true, ref: () => OrganizationClass })
  public organizationId!: Ref<OrganizationClass>;
  @prop({ ref: () => DepartmentClass })
  public departmentId?: Ref<DepartmentClass>;
  @prop({ required: true, trim: true }) public name!: string;
  @prop() public leadEmployeeId?: string;
  @prop({ default: "active", enum: ["active", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<TeamClass>,
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
        [constants.fields.Team.name]: this.name,
        [constants.fields.Team.departmentId]: this.departmentId,
        [constants.fields.Team.leadEmployeeId]: this.leadEmployeeId,
        [constants.fields.Team.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.Team.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(TeamClass, baseModelOptions);
