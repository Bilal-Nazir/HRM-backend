import TypeGoose, {
  DocumentType,
  index,
  prop,
  Ref,
} from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { RoleClass } from "./Role";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

@index(
  { organizationId: 1, employeeId: 1, roleId: 1, scopeType: 1, scopeId: 1 },
  { unique: true },
)
export class RoleAssignmentClass extends BaseModelClass<RoleAssignmentClass> {
  @prop({ required: true }) public organizationId!: string;
  @prop({ required: true }) public employeeId!: string;
  @prop({ required: true, ref: () => RoleClass })
  public roleId!: Ref<RoleClass>;
  @prop({ required: true, enum: ["organization", "team", "self"] })
  public scopeType!: string;
  @prop() public scopeId?: string;
  @prop() public activeFrom?: Date;
  @prop() public activeTo?: Date;

  public async display(
    this: DocumentType<RoleAssignmentClass>,
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
        [constants.fields.RoleAssignment.employeeId]: this.employeeId,
        [constants.fields.RoleAssignment.roleId]: this.roleId,
        [constants.fields.RoleAssignment.scopeType]: this.scopeType,
        [constants.fields.RoleAssignment.scopeId]: this.scopeId,
        [constants.fields.RoleAssignment.activeFrom]: this.activeFrom,
        [constants.fields.RoleAssignment.activeTo]: this.activeTo,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.RoleAssignment.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(RoleAssignmentClass, baseModelOptions);
