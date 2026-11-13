import mongoose, { Schema, Types } from "mongoose";
import { prop } from "@typegoose/typegoose";

// IDs remain strings at service/API boundaries; BSON storage and population use
// native ObjectIds. This also keeps existing board comparisons deterministic.
const asId = (value: any): any =>
  value instanceof Types.ObjectId ? value.toHexString() : value;
export const mongoRef = (ref: string, required = false) =>
  prop({
    type: () => Schema.Types.ObjectId,
    ref,
    required,
    get: asId,
  });
export const mongoRefs = (ref: string) =>
  prop({
    type: () => [Schema.Types.ObjectId],
    ref,
    default: [],
    get: (values: any[]) => values?.map(asId),
  });
export function plainIds(value: any): any {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    !value ||
    typeof value !== "object"
  )
    return value;
  if (Array.isArray(value)) return value.map(plainIds);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, plainIds(item)]),
  );
}
// Mongoose does not cast aggregation pipeline matches. Cast only actual schema
// reference paths, including $in/$or, while leaving dates and expressions intact.
export function castReferenceMatch(schema: Schema, match: any): any {
  if (!match || typeof match !== "object" || Array.isArray(match)) return match;
  return Object.fromEntries(
    Object.entries(match).map(([key, value]: [string, any]) => {
      if (["$or", "$and", "$nor"].includes(key))
        return [
          key,
          value.map((part: any) => castReferenceMatch(schema, part)),
        ];
      const path: any = schema.path(key);
      if (
        path?.instance !== "ObjectId" &&
        path?.caster?.instance !== "ObjectId"
      )
        return [key, value];
      const cast = (id: any): any =>
        typeof id === "string" && /^[a-f\d]{24}$/i.test(id)
          ? new Types.ObjectId(id)
          : id;
      if (
        value &&
        typeof value === "object" &&
        !(value instanceof Types.ObjectId)
      )
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([op, operand]) => [
              op,
              ["$in", "$nin", "$all"].includes(op) && Array.isArray(operand)
                ? operand.map(cast)
                : ["$eq", "$ne"].includes(op)
                  ? cast(operand)
                  : operand,
            ]),
          ),
        ];
      return [key, cast(value)];
    }),
  );
}
mongoose.plugin((schema: Schema) => {
  schema.post(["find", "findOne", "findOneAndUpdate"], function (result: any) {
    if ((this as any).mongooseOptions().lean && result) {
      const convert = (row: any) => {
        for (const [key, value] of Object.entries(row))
          row[key] = plainIds(value);
      };
      if (Array.isArray(result)) result.forEach(convert);
      else convert(result);
    }
  });
  schema.pre("aggregate", function () {
    for (const stage of this.pipeline() as any[])
      if (stage.$match) stage.$match = castReferenceMatch(schema, stage.$match);
  });
  schema.post("aggregate", function (result: any[]) {
    for (const row of result)
      for (const [key, value] of Object.entries(row))
        row[key] = plainIds(value);
  });
});
