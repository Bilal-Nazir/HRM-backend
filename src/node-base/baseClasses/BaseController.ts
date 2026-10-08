import { DocumentType, mongoose } from "@typegoose/typegoose";
import { ClientSession, QueryOptions } from "mongoose";
import config from "../../common/config";
import { ValidationException, sendResponseObject } from "../utils";
import {
  dataValidator,
  validationRulesType,
  validationRule,
} from "../validator";

export abstract class BaseControllerClass<T> {
  public abstract _Model: mongoose.Model<any>;
  public abstract _modelName: string;

  public get _modelNamePlural() {
    return `${this._modelName}s`;
  }

  public get _baseFilter(): Record<string, any> {
    return {};
  }

  public _validationRules: validationRulesType = {};
  public _updateValidationRules: validationRulesType = {};
  public defaultSort: Record<string, number> = { createdAt: -1, _id: 1 };

  public idValidation = (baseFilter = true): validationRule[] => [
    { rule: "format", type: "id" },
    {
      operate: "fetchObj",
      controller: this,
      field: "_id",
      objField: this._modelName,
      baseFilter,
    },
  ];

  public idValidationExtended = (
    extendedFilter: Record<string, any>,
    baseFilter = true,
    deletedRecords = false,
  ): validationRule[] => [
    { rule: "format", type: "id" },
    {
      operate: "fetchObj",
      controller: this,
      field: ({ keyData }: any) => ({ _id: keyData, ...extendedFilter }),
      objField: this._modelName,
      baseFilter,
      deletedRecords,
    },
  ];

  public validateData = async ({
    data,
    validationRules = {},
    operationType = "CREATE",
  }: {
    data: Record<string, any>;
    validationRules?: validationRulesType;
    operationType?: "CREATE" | "UPDATE" | "PATCH";
  }) => {
    let rules = Object.keys(validationRules).length
      ? validationRules
      : this._validationRules;

    if (["UPDATE", "PATCH"].includes(operationType)) {
      rules = { ...rules, ...this._updateValidationRules };
    }

    const validationReturn = await dataValidator.validate(data, rules);

    return {
      isValid: validationReturn.isValid,
      errorMessages: new ValidationException(validationReturn.errorMessages),
      postData: validationReturn.postData,
    };
  };

  public dbReadRecord = async ({
    readFilter,
    Collection = this._Model,
    selectFields = [],
    deletedRecords = false,
    baseFilter = true,
    options = {},
  }: {
    readFilter: Record<string, any>;
    Collection?: mongoose.Model<any>;
    selectFields?: string[];
    deletedRecords?: boolean;
    baseFilter?: boolean;
    options?: QueryOptions;
  }) => {
    const filter = {
      ...readFilter,
      ...(baseFilter ? this._baseFilter : {}),
      ...(!deletedRecords ? { isDeleted: false } : {}),
    };

    return Collection.findOne(filter, selectFields, options).exec();
  };

  public dbReadRecords = async ({
    readFilter,
    Collection = this._Model,
    page = config.pagination.page,
    limit = config.pagination.limit,
    sort = {},
    selectFields = [],
    deletedRecords = false,
    baseFilter = true,
    paginate = false,
    options = {},
  }: {
    readFilter: Record<string, any>;
    Collection?: mongoose.Model<any>;
    page?: number;
    limit?: number;
    sort?: Record<string, any>;
    selectFields?: string[];
    deletedRecords?: boolean;
    baseFilter?: boolean;
    paginate?: boolean;
    options?: QueryOptions;
  }) => {
    const filter = {
      ...readFilter,
      ...(baseFilter ? this._baseFilter : {}),
      ...(!deletedRecords ? { isDeleted: false } : {}),
    };
    const actualSort = Object.keys(sort).length ? sort : this.defaultSort;
    const queryOptions = paginate
      ? { ...options, sort: actualSort, skip: (page - 1) * limit, limit }
      : { ...options, sort: actualSort };

    return Collection.find(filter, selectFields, queryOptions).exec();
  };

  public dbCountDocs = async ({
    readFilter,
    Collection = this._Model,
    deletedRecords = false,
    baseFilter = true,
  }: {
    readFilter: Record<string, any>;
    Collection?: mongoose.Model<any>;
    deletedRecords?: boolean;
    baseFilter?: boolean;
  }) => {
    const filter = {
      ...readFilter,
      ...(baseFilter ? this._baseFilter : {}),
      ...(!deletedRecords ? { isDeleted: false } : {}),
    };
    return Collection.countDocuments(filter).exec();
  };

  public dbInsertRecord = async ({
    data,
    Collection = this._Model,
    dbSession,
  }: {
    data: Record<string, any>;
    Collection?: mongoose.Model<any>;
    dbSession?: ClientSession;
  }) => {
    const obj = new Collection(data);
    return obj.save({ session: dbSession }) as Promise<DocumentType<T>>;
  };

  public dbInsertRecords = async ({
    data,
    Collection = this._Model,
    dbSession,
  }: {
    data: Record<string, any>[];
    Collection?: mongoose.Model<any>;
    dbSession?: ClientSession;
  }) => Collection.insertMany(data, { session: dbSession });

  public dbUpdateRecord = async ({
    data,
    readFilter,
    obj,
    Collection = this._Model,
    deletedRecords = false,
    filterObj = true,
    baseFilter = true,
    dbSession,
  }: {
    data: Record<string, any>;
    readFilter?: Record<string, any>;
    obj?: DocumentType<any>;
    Collection?: mongoose.Model<any>;
    deletedRecords?: boolean;
    filterObj?: boolean;
    baseFilter?: boolean;
    dbSession?: ClientSession;
  }) => {
    if (!filterObj) {
      if (!obj) throw new Error("obj is required when filterObj is false");
      obj.set(data);
      await obj.save({ session: dbSession });
      return obj as DocumentType<T>;
    }

    if (!readFilter) throw new Error("readFilter is required");

    const filter = {
      ...readFilter,
      ...(baseFilter ? this._baseFilter : {}),
      ...(!deletedRecords ? { isDeleted: false } : {}),
    };

    return Collection.findOneAndUpdate(filter, data, {
      new: true,
      runValidators: true,
      session: dbSession,
    }).exec();
  };

  public dbUpsertRecord = async ({
    data,
    readFilter,
    Collection = this._Model,
    baseFilter = true,
  }: {
    data: Record<string, any>;
    readFilter: Record<string, any>;
    Collection?: mongoose.Model<any>;
    baseFilter?: boolean;
  }) =>
    Collection.findOneAndUpdate(
      { ...readFilter, ...(baseFilter ? this._baseFilter : {}) },
      data,
      { new: true, upsert: true, runValidators: true },
    );

  public deleteController = async (req: any, res: any, next: any) => {
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.params,
      validationRules: {
        id: [{ rule: "required" }, ...this.idValidation()],
      },
    });

    if (!isValid) return next(errorMessages);

    const obj = postData[this._modelName];
    await this.dbUpdateRecord({
      data: { isDeleted: true },
      obj,
      filterObj: false,
    });

    return sendResponseObject({ res });
  };
}
