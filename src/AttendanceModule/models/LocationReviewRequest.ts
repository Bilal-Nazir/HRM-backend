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
  @prop({ required: true }) organizationId!: string;
  @prop({ required: true }) employeeId!: string;
  @prop({ required: true }) requestedByUserId!: string;
  @prop({ enum: ["check_in", "check_out"], required: true }) action!: string;
  @prop() attendanceId?: string;
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
  @prop() reviewedByUserId?: string;
  @prop() reviewedAt?: Date;
  @prop() reviewComment?: string;
  @prop() approvedLatitude?: number;
  @prop() approvedLongitude?: number;
  @prop() resultAttendanceId?: string;
}
export default getModelForClass(LocationReviewRequestClass, baseModelOptions);
