import TypeGoose, { index, prop } from "@typegoose/typegoose";
import { BaseModelClass, baseModelOptions } from "../../node-base/baseClasses";
const { getModelForClass } = TypeGoose;
@index({ organizationId: 1, taskId: 1, createdAt: 1 })
export class ProjectAttachmentClass extends BaseModelClass<ProjectAttachmentClass> {
  @prop({ required:true }) organizationId!:string;
  @prop({ required:true }) projectId!:string;
  @prop({ required:true }) taskId!:string;
  @prop({ required:true }) uploadedByUserId!:string;
  @prop() uploadedByEmployeeId?:string;
  @prop({ required:true }) originalName!:string;
  @prop({ required:true }) storedName!:string;
  @prop({ required:true }) mimeType!:string;
  @prop({ required:true }) size!:number;
}
export default getModelForClass(ProjectAttachmentClass, baseModelOptions);
