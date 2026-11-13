import { mongoRef, mongoRefs } from "../../common/mongoReferences";
import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { AttendanceDevice } from "./AttendanceDevice";
const { getModelForClass } = TypeGoose;

@index(
  { organizationId: 1, employeeId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true, isDeleted: false } },
)
@index({ organizationId: 1, status: 1, createdAt: -1 })
export class LocationReviewRequestClass extends BaseModelClass<LocationReviewRequestClass> {
  @mongoRef("OrganizationClass", true) organizationId!: string;
  @mongoRef("EmployeeClass", true) employeeId!: string;
  @mongoRef("UserClass", true) requestedByUserId!: string;
  @prop({ enum: ["check_in", "check_out"], required: true }) action!: string;
  @mongoRef("AttendanceClass") attendanceId?: string;
  @prop({ required: true, min: -90, max: 90 }) latitude!: number;
  @prop({ required: true, min: -180, max: 180 }) longitude!: number;
  @prop({ required: true }) reason!: string;
  @prop({ required: true }) requestedAt!: Date;
  @prop({ _id: false, type: () => AttendanceDevice }) device?: AttendanceDevice;
  @prop({
    enum: ["pending", "processing", "approved", "rejected", "cancelled"],
    default: "pending",
  })
  status!: string;
  @prop({ default: true }) active!: boolean;
  @mongoRef("UserClass") reviewedByUserId?: string;
  @prop() reviewedAt?: Date;
  @prop() reviewComment?: string;
  @prop() approvedLatitude?: number;
  @prop() approvedLongitude?: number;
  @mongoRef("AttendanceClass") resultAttendanceId?: string;
}
export default getModelForClass(LocationReviewRequestClass, baseModelOptions);
