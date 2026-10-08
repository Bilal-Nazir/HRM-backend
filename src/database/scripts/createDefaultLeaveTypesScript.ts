import LeaveTypeModel from "../../LeaveModule/models/LeaveType";
import OrganizationModel from "../../OrganizationModule/models/Organization";

export const ensureDefaultLeaveTypes = async (organizationId: string) => {
  // Insert missing defaults only. Preserve customized/archived types and allowances.
  await LeaveTypeModel.init();
  for (const name of ["Sick", "Casual", "Formal"]) {
    try {
      await LeaveTypeModel.updateOne(
        { organizationId, name },
        {
          $setOnInsert: {
            organizationId,
            name,
            code: name.toUpperCase(),
            status: "active",
          },
        },
        { upsert: true, runValidators: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
};

export const createDefaultLeaveTypesScript = async () => {
  const organizations = await OrganizationModel.find({
    isDeleted: { $ne: true },
  }).select("_id");
  for (const organization of organizations)
    await ensureDefaultLeaveTypes(organization.id);
};
