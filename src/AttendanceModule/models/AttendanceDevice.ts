import { prop } from "@typegoose/typegoose";

export class AttendanceDevice {
  @prop({ required: true }) capturedAt!: Date;
  @prop({ enum: ["desktop", "mobile", "tablet", "unknown"], required: true }) deviceType!: string;
  @prop() browser?: string;
  @prop() browserVersion?: string;
  @prop() os?: string;
  @prop() osVersion?: string;
  @prop() userAgent?: string;
  @prop() ipAddress?: string;
  @prop() connectionIp?: string;
  @prop() platform?: string;
  @prop() platformVersion?: string;
  @prop() model?: string;
  @prop() architecture?: string;
  @prop() bitness?: string;
  @prop() timezone?: string;
  @prop() language?: string;
  @prop() screenWidth?: number;
  @prop() screenHeight?: number;
  @prop() viewportWidth?: number;
  @prop() viewportHeight?: number;
  @prop() pixelRatio?: number;
  @prop() touchPoints?: number;
  @prop() logicalProcessors?: number;
  @prop() memoryGB?: number;
}
