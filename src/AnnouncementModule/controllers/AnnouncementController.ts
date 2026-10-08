import { NextFunction, Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
import { validationRulesType } from "../../node-base/validator";
import {
  ObjectNotFoundException,
  sendResponseObject,
} from "../../node-base/utils";
import AnnouncementModel, { AnnouncementClass } from "../models/Announcement";

const fields = constants.fields.Announcement;
const statuses = constants.statics.enums.Announcement.status;

export class AnnouncementControllerClass extends BaseControllerClass<AnnouncementClass> {
  _Model = AnnouncementModel;
  _modelName = fields.Announcement;
  _validationRules: validationRulesType = {
    [fields.title]: [
      { rule: "required" },
      { rule: "datatype", datatype: "String" },
      { rule: "maxLength", length: 160 },
    ],
    [fields.content]: [
      { rule: "required" },
      { rule: "datatype", datatype: "String" },
      { rule: "maxLength", length: 5000 },
    ],
    [fields.status]: [
      { rule: "required" },
      { rule: "choices", options: Object.values(statuses) },
    ],
  };

  private list = async (
    req: AuthenticatedRequest,
    res: Response,
    publishedOnly: boolean,
  ) => {
    const page = Math.max(Math.floor(Number(req.query.page)) || 1, 1);
    const limit = Math.min(
      Math.max(Math.floor(Number(req.query.size)) || 10, 1),
      100,
    );
    const readFilter = {
      [fields.organizationId]: req.auth!.organizationId,
      ...(publishedOnly ? { [fields.status]: statuses.published } : {}),
    };
    const [objs, totalCount] = await Promise.all([
      this.dbReadRecords({
        readFilter,
        page,
        limit,
        paginate: true,
        sort: { createdAt: -1, _id: -1 },
        baseFilter: false,
      }),
      this.dbCountDocs({ readFilter, baseFilter: false }),
    ]);
    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          objs.map((obj) => obj.display()),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
      },
    });
  };

  public viewController = (req: AuthenticatedRequest, res: Response) =>
    this.list(req, res, true);
  public manageController = (req: AuthenticatedRequest, res: Response) =>
    this.list(req, res, false);

  public createController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
    });
    if (!isValid) return next(errorMessages);
    const obj = await this.dbInsertRecord({
      data: {
        ...postData,
        [fields.organizationId]: req.auth!.organizationId,
        [fields.createdBy]: req.auth!.userId,
      },
    });
    return sendResponseObject({
      res,
      code: 201,
      data: { [this._modelName]: await obj.display() },
    });
  };

  public updateController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const { isValid, errorMessages, postData } = await this.validateData({
      data: { ...req.body, [constants.fields.id]: req.params.id },
      validationRules: {
        ...this._validationRules,
        [constants.fields.id]: [
          { rule: "required" },
          { rule: "format", type: "id" },
        ],
      },
    });
    if (!isValid) return next(errorMessages);
    const id = postData[constants.fields.id];
    delete postData[constants.fields.id];
    const obj = await this.dbUpdateRecord({
      readFilter: {
        [constants.fields._id]: id,
        [fields.organizationId]: req.auth!.organizationId,
      },
      data: { $set: postData },
      baseFilter: false,
    });
    if (!obj) return next(new ObjectNotFoundException("Announcement"));
    return sendResponseObject({
      res,
      data: { [this._modelName]: await obj.display() },
    });
  };
}

export default new AnnouncementControllerClass();
