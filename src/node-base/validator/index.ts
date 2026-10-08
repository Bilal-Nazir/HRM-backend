import mongoose from "mongoose";

export type validationRule =
  | { rule: "required" }
  | {
      rule: "datatype";
      datatype: "String" | "Number" | "Boolean" | "Object" | "Array";
    }
  | {
      rule: "format";
      type: "email" | "id" | "datetime" | "date" | "numeric" | "slug";
    }
  | { rule: "maxLength"; length: number }
  | { rule: "minLength"; length: number }
  | { rule: "minValue"; value: number }
  | { rule: "maxValue"; value: number }
  | { rule: "choices"; options: any[] }
  | {
      rule: "unique";
      controller: any;
      field:
        string | Record<string, any> | ((args: any) => Record<string, any>);
      baseFilter?: boolean;
    }
  | {
      rule: "exists";
      controller: any;
      field:
        string | Record<string, any> | ((args: any) => Record<string, any>);
      baseFilter?: boolean;
    }
  | {
      operate: "fetchObj";
      controller: any;
      field:
        string | Record<string, any> | ((args: any) => Record<string, any>);
      objField: string;
      baseFilter?: boolean;
      deletedRecords?: boolean;
    }
  | {
      rule: "custom";
      custom: (args: {
        key: string;
        keyData: any;
        data: Record<string, any>;
      }) => Promise<{ isValid: boolean; errorMessages?: any }>;
    };

export type validationRulesType = Record<string, validationRule[]>;

const getObjProp = (obj: Record<string, any>, path: string): any =>
  path.split(".").reduce((value, key) => value?.[key], obj);

const setObjProp = (obj: Record<string, any>, path: string, value: any) => {
  const keys = path.split(".");
  const lastKey = keys.pop()!;
  const parent = keys.reduce((value, key) => (value[key] ??= {}), obj);
  parent[lastKey] = value;
};

const getReadFilter = (field: any, keyData: any, data: Record<string, any>) => {
  if (typeof field === "string") return { [field]: keyData };
  if (typeof field === "function") return field({ keyData, data });
  return field;
};

const isEmpty = (value: any) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.keys(value).length);

const formats: Record<string, (value: string) => boolean> = {
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  id: (value) => mongoose.isValidObjectId(value),
  datetime: (value) => !Number.isNaN(new Date(value).valueOf()),
  date: (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(value).valueOf()),
  numeric: (value) => /^-?\d+(\.\d+)?$/.test(value),
  slug: (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
};

export const dataValidator = {
  validate: async (data: Record<string, any>, rules: validationRulesType) => {
    const postData: Record<string, any> = {};
    const errorMessages: Record<string, any> = {};

    for (const [key, fieldRules] of Object.entries(rules)) {
      let keyData = getObjProp(data, key);
      if (typeof keyData === "string") keyData = keyData.trim();
      if (!isEmpty(keyData)) setObjProp(postData, key, keyData);

      for (const validation of fieldRules) {
        const operation =
          "operate" in validation ? validation.operate : validation.rule;
        const acceptsEmpty = operation === "required";
        if (isEmpty(keyData) && !acceptsEmpty) continue;

        let error = "";

        if (operation === "required" && isEmpty(keyData))
          error = "This field is required";
        if (
          operation === "datatype" &&
          keyData?.constructor?.name !== (validation as any).datatype
        )
          error = `Expected ${(validation as any).datatype}`;
        if (
          operation === "format" &&
          (typeof keyData !== "string" ||
            !formats[(validation as any).type]?.(keyData))
        )
          error = `Invalid ${(validation as any).type} format`;
        if (
          operation === "maxLength" &&
          keyData.length > (validation as any).length
        )
          error = `Maximum length is ${(validation as any).length}`;
        if (
          operation === "minLength" &&
          keyData.length < (validation as any).length
        )
          error = `Minimum length is ${(validation as any).length}`;
        if (operation === "minValue" && keyData < (validation as any).value)
          error = `Minimum value is ${(validation as any).value}`;
        if (operation === "maxValue" && keyData > (validation as any).value)
          error = `Maximum value is ${(validation as any).value}`;
        if (
          operation === "choices" &&
          !(validation as any).options.includes(keyData)
        )
          error = "Invalid choice";

        if (["unique", "exists", "fetchObj"].includes(operation)) {
          const typedRule: any = validation;
          const obj = await typedRule.controller.dbReadRecord({
            readFilter: getReadFilter(typedRule.field, keyData, postData),
            baseFilter: typedRule.baseFilter ?? true,
            deletedRecords: typedRule.deletedRecords ?? false,
          });

          if (
            operation === "unique" &&
            obj &&
            obj.id !== data.id &&
            obj.id !== data._id
          )
            error = "Already exists";
          if (["exists", "fetchObj"].includes(operation) && !obj)
            error = "Related record does not exist";
          if (operation === "fetchObj" && obj)
            setObjProp(postData, typedRule.objField, obj);
        }

        if (operation === "custom") {
          const result = await (validation as any).custom({
            key,
            keyData,
            data: postData,
          });
          if (!result.isValid) error = result.errorMessages || "Invalid value";
        }

        if (error) {
          errorMessages[key] = error;
          break;
        }

        keyData = getObjProp(postData, key);
      }
    }

    return {
      isValid: !Object.keys(errorMessages).length,
      errorMessages,
      postData,
    };
  },
};
