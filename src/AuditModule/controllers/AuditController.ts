import { Response } from "express";
import { AuthenticatedRequest } from "../../AuthModule/utils/types";
import { BaseControllerClass } from "../../node-base/baseClasses";
import { sendResponseObject } from "../../node-base/utils";
import AuditLogModel, { AuditLogClass } from "../models/AuditLog";
import { constants } from "../../node-base/constants";

export class AuditControllerClass extends BaseControllerClass<AuditLogClass> {
  _Model = AuditLogModel;
  _modelName = constants.fields.AuditLog.AuditLog;

  public viewController = async (req: AuthenticatedRequest, res: Response) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);

    const readFilter: Record<string, any> = {
      organizationId: req.auth!.organizationId,
    };

    const filterFields = ["action", "entityType", "entityId", "actorUserId"];
    filterFields.forEach((field) => {
      if (req.query[field]) readFilter[field] = req.query[field];
    });

    const objs = await this.dbReadRecords({
      readFilter,
      page,
      limit,
      paginate: true,
      baseFilter: false,
    });

    const totalCount = await this.dbCountDocs({
      readFilter,
      baseFilter: false,
    });

    return sendResponseObject({
      res,
      data: {
        [this._modelNamePlural]: await Promise.all(
          objs.map((obj) => obj.display({ detail: true })),
        ),
        totalCount,
        page,
        lastPage: Math.ceil(totalCount / limit),
      },
    });
  };
}

const AuditController = new AuditControllerClass();
export default AuditController;
