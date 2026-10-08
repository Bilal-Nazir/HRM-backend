import TypeGoose, { DocumentType, index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
const { getModelForClass } = TypeGoose;

export class LocationPoint {
  @prop({ required: true, min: -90, max: 90 }) public latitude!: number;
  @prop({ required: true, min: -180, max: 180 }) public longitude!: number;
  @prop({ min: 0 }) public accuracyMeters?: number;
  @prop() public capturedAt!: Date;
  @prop() public address?: string;
}
@index({ organizationId: 1, employeeId: 1, workDate: -1 })
@index({ organizationId: 1, employeeId: 1, status: 1 })
export class AttendanceClass extends BaseModelClass<AttendanceClass> {
  @prop({ required: true }) public organizationId!: string;
  @prop({ required: true }) public employeeId!: string;
  @prop() public officeLocationId?: string;
  @prop({ required: true }) public workDate!: string;
  @prop({ required: true }) public checkInAt!: Date;
  @prop({ _id: false, type: () => LocationPoint, required: true })
  public checkInLocation!: LocationPoint;
  @prop() public checkOutAt?: Date;
  @prop({ _id: false, type: () => LocationPoint })
  public checkOutLocation?: LocationPoint;
  @prop() public checkInDistanceMeters?: number;
  @prop() public checkOutDistanceMeters?: number;
  @prop() public checkInWithinGeofence?: boolean;
  @prop() public checkOutWithinGeofence?: boolean;
  @prop({ default: "open", enum: ["open", "completed", "flagged"] })
  public status!: string;
  @prop() public notes?: string;

  public async display(
    this: DocumentType<AttendanceClass>,
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
        [constants.fields.Attendance.employeeId]: this.employeeId,
        [constants.fields.Attendance.officeLocationId]: this.officeLocationId,
        [constants.fields.Attendance.workDate]: this.workDate,
        [constants.fields.Attendance.checkInAt]: this.checkInAt,
        [constants.fields.Attendance.checkInLocation]: this.checkInLocation,
        [constants.fields.Attendance.checkOutAt]: this.checkOutAt,
        [constants.fields.Attendance.checkOutLocation]: this.checkOutLocation,
        [constants.fields.Attendance.status]: this.status,
        [constants.fields.Attendance.notes]: this.notes,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.Attendance.organizationId]: this.organizationId,
        [constants.fields.Attendance.checkInDistanceMeters]:
          this.checkInDistanceMeters,
        [constants.fields.Attendance.checkOutDistanceMeters]:
          this.checkOutDistanceMeters,
        [constants.fields.Attendance.checkInWithinGeofence]:
          this.checkInWithinGeofence,
        [constants.fields.Attendance.checkOutWithinGeofence]:
          this.checkOutWithinGeofence,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(AttendanceClass, baseModelOptions);
