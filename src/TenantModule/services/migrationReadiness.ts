import mongoose from "mongoose";
export async function assertTenantMigrationReady() {
  for (const Model of Object.values(mongoose.models)) {
    const fields: string[] = [];
    Model.schema.eachPath((name, type: any) => {
      if (
        name !== "_id" &&
        (type.instance === "ObjectId" || type.caster?.instance === "ObjectId")
      )
        fields.push(name);
    });
    if (
      fields.length &&
      (await Model.collection.findOne(
        { $or: fields.map((name) => ({ [name]: { $type: "string" } })) },
        { projection: { _id: 1 } },
      ))
    )
      throw new Error(
        "Legacy string references detected. Stop the app, back up MongoDB, then run npm run migrate:tenants (review) and npm run migrate:tenants -- --apply before restarting.",
      );
  }
  const company = mongoose.models.OrganizationClass;
  if (
    await company.collection.findOne({
      isDeleted: { $ne: true },
      $or: [
        { ownerUserId: { $exists: false } },
        { tenantSchemaVersion: { $ne: 1 } },
      ],
    })
  )
    throw new Error(
      "Company ownership migration is required. Run npm run migrate:tenants and review its report before applying.",
    );
}
