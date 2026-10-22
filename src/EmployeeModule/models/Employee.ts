import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

@index(
  { organizationId: 1, employeeCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)
@index(
  { organizationId: 1, workEmail: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)
@index({
  organizationId: 1,
  firstName: "text",
  lastName: "text",
  workEmail: "text",
  employeeCode: "text",
})
export class EmployeeClass extends BaseModelClass<EmployeeClass> {
  @prop({ required: true }) public organizationId!: string;
  @prop() public userId?: string;
  @prop({ required: true, trim: true }) public employeeCode!: string;
  @prop({ required: true, trim: true }) public firstName!: string;
  @prop({ required: true, trim: true }) public lastName!: string;
  @prop({ required: true, lowercase: true, trim: true })
  public workEmail!: string;
  @prop({ lowercase: true, trim: true }) public personalEmail?: string;
  @prop({ trim: true }) public phone?: string;
  @prop({ trim: true }) public jobTitle?: string;
  @prop() public departmentId?: string;
  @prop() public teamId?: string;
  @prop() public managerEmployeeId?: string;
  @prop() public primaryOfficeLocationId?: string;
  @prop() public workScheduleId?: string;
  @prop({
    required: true,
    default: "invited",
    enum: ["invited", "active", "suspended", "terminated", "archived"],
  })
  public employmentStatus!: string;
  @prop({ enum: ["full-time", "part-time", "contract", "intern"] })
  public employmentType?: string;
  @prop() public joinDate?: Date;
  @prop() public endDate?: Date;
  @prop() public timezone?: string;
  @prop({ type: () => Object }) public metadata?: Record<string, unknown>;
  public async display(
    this: DocumentType<EmployeeClass>,
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
        [constants.fields.Employee.employeeCode]: this.employeeCode,
        [constants.fields.Employee.firstName]: this.firstName,
        [constants.fields.Employee.lastName]: this.lastName,
        [constants.fields.Employee.workEmail]: this.workEmail,
        [constants.fields.Employee.phone]: this.phone,
        [constants.fields.Employee.jobTitle]: this.jobTitle,
        [constants.fields.Employee.departmentId]: this.departmentId,
        [constants.fields.Employee.teamId]: this.teamId,
        [constants.fields.Employee.managerEmployeeId]: this.managerEmployeeId,
        [constants.fields.Employee.primaryOfficeLocationId]:
          this.primaryOfficeLocationId,
        [constants.fields.Employee.employmentStatus]: this.employmentStatus,
        [constants.fields.Employee.employmentType]: this.employmentType,
        [constants.fields.Employee.joinDate]: this.joinDate,
        [constants.fields.createdAt]: this.createdAt,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.Employee.organizationId]: this.organizationId,
        [constants.fields.Employee.userId]: this.userId,
        [constants.fields.Employee.personalEmail]: this.personalEmail,
        [constants.fields.Employee.workScheduleId]: this.workScheduleId,
        [constants.fields.Employee.joinDate]: this.joinDate,
        [constants.fields.Employee.endDate]: this.endDate,
        [constants.fields.Employee.timezone]: this.timezone,
        [constants.fields.Employee.metadata]: this.metadata,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
const EmployeeModel = getModelForClass(EmployeeClass, baseModelOptions);
export default EmployeeModel;
