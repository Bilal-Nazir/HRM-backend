import { NextFunction, Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
import { validationRulesType } from "../../node-base/validator";
import { sendResponseObject } from "../../node-base/utils";
import TermsModel, { TermsClass } from "../models/Terms";

const fields = constants.fields.Terms;

export class TermsControllerClass extends BaseControllerClass<TermsClass> {
  _Model = TermsModel;
  _modelName = fields.Terms;
  _validationRules: validationRulesType = {
    [fields.title]: [
      { rule: "required" },
      { rule: "datatype", datatype: "String" },
      { rule: "maxLength", length: 160 },
    ],
    [fields.content]: [
      { rule: "required" },
      { rule: "datatype", datatype: "String" },
      { rule: "maxLength", length: 50000 },
    ],
  };

  public readController = async (req: AuthenticatedRequest, res: Response) => {
    const obj = await this.dbReadRecord({
      readFilter: { [fields.organizationId]: req.auth!.organizationId },
      baseFilter: false,
    });
    return sendResponseObject({
      res,
      data: { [this._modelName]: obj ? await obj.display() : null },
    });
  };

  public updateController = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const { isValid, errorMessages, postData } = await this.validateData({
      data: req.body,
    });
    if (!isValid) return next(errorMessages);
    // One current terms document per organization, scoped from the session only.
    const obj = await this.dbUpsertRecord({
      readFilter: { [fields.organizationId]: req.auth!.organizationId },
      data: { $set: { ...postData, [fields.updatedBy]: req.auth!.userId } },
      baseFilter: false,
    });
    return sendResponseObject({
      res,
      data: { [this._modelName]: await obj.display() },
    });
  };
}

export default new TermsControllerClass();
