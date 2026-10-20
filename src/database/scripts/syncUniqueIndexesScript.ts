import UserModel from "../../AuthModule/models/User";
import EmployeeModel from "../../EmployeeModule/models/Employee";
import { logger } from "../../node-base/utils";

/**
 * Replaces the former unconditional unique indexes with the model's partial
 * indexes, allowing identifiers belonging to soft-deleted accounts to be
 * reused while keeping active employees unique within an organization.
 */
export const syncUniqueIndexesScript = async () => {
  await Promise.all([UserModel.syncIndexes(), EmployeeModel.syncIndexes()]);
  logger.info("Employee and user unique indexes synchronized");
};
