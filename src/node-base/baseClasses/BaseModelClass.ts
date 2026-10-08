import { DocumentType, prop } from "@typegoose/typegoose";

export type includeReferenceType = {
  field: string;
  reset?: boolean;
  includes?: any[];
  excludes?: string[];
};

export abstract class BaseModelClass<T = any> {
  @prop({ required: true, default: false })
  public isDeleted!: boolean;

  public createdAt?: Date;
  public updatedAt?: Date;

  public async display__includes_excludes(
    this: DocumentType<T>,
    {
      data,
      includes = [],
      excludes = [],
    }: {
      data: Record<string, any>;
      reset?: boolean;
      includes?: (string | includeReferenceType)[];
      excludes?: string[];
    },
  ) {
    excludes.forEach((field) => delete data[field]);

    await Promise.all(
      includes.map(async (include) => {
        if (typeof include === "string") {
          data[include] = this.get(include);
          return;
        }

        await this.populate(include.field);
        const referencedObj = this.get(include.field) as any;
        data[include.field] = referencedObj?.display
          ? await referencedObj.display({
              reset: include.reset,
              includes: include.includes || [],
              excludes: include.excludes || [],
            })
          : referencedObj;
      }),
    );

    return data;
  }
}

export const baseModelOptions = {
  schemaOptions: {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
};
