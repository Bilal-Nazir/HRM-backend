import { NextFunction, Response } from "express";
import { randomUUID } from "node:crypto";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { constants } from "../../node-base/constants";
import { validationRulesType } from "../../node-base/validator";
import { sendResponseObject } from "../../node-base/utils";
import TermsModel, { TermsClass } from "../models/Terms";
import { notifyOrganizationEmployees } from "../../NotificationModule/services/notificationService";

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
    const organizationId = req.auth!.organizationId;
    const uploads: unknown = req.body.files ?? [];
    const removed: unknown = req.body.removeFileIds ?? [];
    if (!Array.isArray(uploads) || !Array.isArray(removed) || uploads.length > 20 ||
      uploads.some((file) => !file || typeof file.name !== "string" || file.name.length > 180 ||
        !/\.(pdf|docx?)$/i.test(file.name) || typeof file.data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data) || file.data.length % 4 !== 0) ||
      removed.some((id) => typeof id !== "string")) {
      return res.status(400).json({ message: "Choose valid PDF or Word documents." });
    }
    const current = await TermsModel.findOne({ organizationId });
    const files = [...(current?.files || []).filter((file) => !removed.includes(file.id)),
      ...uploads.map(({ name, data }) => ({ id: randomUUID(), name, data }))];
    if (files.length > 20 || files.reduce((total, file) => total + file.data.length, 0) > 8 * 1024 * 1024) {
      return res.status(400).json({ message: "Policies can contain up to 20 files and 6 MB of documents in total." });
    }
    // One current terms document per organization, scoped from the session only.
    const obj = await this.dbUpsertRecord({
      readFilter: { [fields.organizationId]: req.auth!.organizationId },
      data: { $set: { ...postData, files, [fields.updatedBy]: req.auth!.userId } },
      baseFilter: false,
    });
    await notifyOrganizationEmployees({
      organizationId: req.auth!.organizationId!,
      actorUserId: req.auth!.userId,
      type: "policy.updated",
      title: "Company policies updated",
      message: obj.title,
      href: "/terms",
    }).catch(console.error);
    return sendResponseObject({
      res,
      data: { [this._modelName]: await obj.display() },
    });
  };

  public deleteController = async (req: AuthenticatedRequest, res: Response) => {
    await TermsModel.deleteOne({ organizationId: req.auth!.organizationId });
    return sendResponseObject({ res, data: { terms: null } });
  };

  public downloadController = async (req: AuthenticatedRequest, res: Response) => {
    const terms = await TermsModel.findOne({ organizationId: req.auth!.organizationId });
    const file = terms?.files?.find((item) => item.id === req.params.id);
    if (!file) return res.sendStatus(404);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(Buffer.from(file.data, "base64"));
  };
}

export default new TermsControllerClass();
