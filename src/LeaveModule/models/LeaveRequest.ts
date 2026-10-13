import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, employeeId: 1, startDate: -1 })
export class LeaveRequestClass extends BaseModelClass<LeaveRequestClass> {
  @prop({ required: true }) public organizationId!: string;
  @prop({ required: true }) public employeeId!: string;
  @prop() public leaveTypeId?: string;
  @prop({ default: "leave", enum: ["leave", "work_from_home"] }) public requestKind!: string;
  @prop({ required: true }) public startDate!: Date;
  @prop({ required: true }) public endDate!: Date;
  @prop({ required: true, min: 0.5 }) public totalDays!: number;
  @prop() public reason?: string;
  @prop({
    default: "pending",
    enum: ["pending", "approved", "rejected", "cancelled"],
  })
  public status!: string;
  @prop() public reviewedByEmployeeId?: string;
  @prop() public reviewedAt?: Date;
  @prop() public reviewComment?: string;

  public async display(
    this: DocumentType<LeaveRequestClass>,
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
        [constants.fields.LeaveRequest.employeeId]: this.employeeId,
        [constants.fields.LeaveRequest.leaveTypeId]: this.leaveTypeId,
        requestKind: this.requestKind || "leave",
        [constants.fields.LeaveRequest.startDate]: this.startDate,
        [constants.fields.LeaveRequest.endDate]: this.endDate,
        [constants.fields.LeaveRequest.totalDays]: this.totalDays,
        [constants.fields.LeaveRequest.reason]: this.reason,
        [constants.fields.LeaveRequest.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.LeaveRequest.organizationId]: this.organizationId,
        [constants.fields.LeaveRequest.reviewedByEmployeeId]:
          this.reviewedByEmployeeId,
        [constants.fields.LeaveRequest.reviewedAt]: this.reviewedAt,
        [constants.fields.LeaveRequest.reviewComment]: this.reviewComment,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(LeaveRequestClass, baseModelOptions);
