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
export class OfficeLocationClass extends BaseModelClass<OfficeLocationClass> {
  @prop({ required: true, ref: () => OrganizationClass })
  public organizationId!: Ref<OrganizationClass>;
  @prop({ required: true, trim: true }) public name!: string;
  @prop({ trim: true }) public address?: string;
  @prop({ min: -90, max: 90 }) public latitude?: number;
  @prop({ min: -180, max: 180 }) public longitude?: number;
  @prop({ min: 1, max: 100000, default: 200 })
  public geofenceRadiusMeters?: number;
  @prop() public timezone?: string;
  @prop({ default: "active", enum: ["active", "archived"] })
  public status!: string;

  public async display(
    this: DocumentType<OfficeLocationClass>,
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
        [constants.fields.OfficeLocation.name]: this.name,
        [constants.fields.OfficeLocation.address]: this.address,
        [constants.fields.OfficeLocation.latitude]: this.latitude,
        [constants.fields.OfficeLocation.longitude]: this.longitude,
        [constants.fields.OfficeLocation.geofenceRadiusMeters]:
          this.geofenceRadiusMeters,
        [constants.fields.OfficeLocation.timezone]: this.timezone,
        [constants.fields.OfficeLocation.status]: this.status,
      };
    if (detail)
      data = {
        ...data,
        [constants.fields.OfficeLocation.organizationId]: this.organizationId,
        [constants.fields.createdAt]: this.createdAt,
        [constants.fields.updatedAt]: this.updatedAt,
      };
    data = { ...data, ...baseData };
    return this.display__includes_excludes({ data, reset, includes, excludes });
  }
}
export default getModelForClass(OfficeLocationClass, baseModelOptions);
