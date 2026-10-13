import RoleModel from "../../AccessModule/models/Role";
import { defaultRoles } from "../../AccessModule/utils/permissions";
import AuthController from "../../AuthModule/controllers/AuthController";
import { hashPassword } from "../../AuthModule/utils/password";
import OrganizationController from "../../OrganizationModule/controllers/OrganizationController";
import OrganizationModel from "../../OrganizationModule/models/Organization";
import { constants } from "../../node-base/constants";
import { logger } from "../../node-base/utils";

export const createFirstAdminScript = async () => {
  let organization = await OrganizationController.dbReadRecord({
    Collection: OrganizationModel,
    readFilter: { [constants.fields.Organization.slug]: "novacto" },
    baseFilter: false,
  });

  if (!organization)
    organization = await OrganizationController.dbInsertRecord({
      Collection: OrganizationModel,
      data: {
        [constants.fields.Organization.name]: "NovaCTO",
        [constants.fields.Organization.slug]: "novacto",
        [constants.fields.Organization.timezone]: "Asia/Karachi",
        [constants.fields.Organization.status]:
          constants.statics.enums.Organization.status.active,
      },
    });

  const roles = [
    ["Organization Admin", defaultRoles.organizationAdmin],
    ["Manager", defaultRoles.manager],
    ["Employee", defaultRoles.employee],
  ] as const;

  for (const [name, permissions] of roles) {
    const role = await OrganizationController.dbReadRecord({
      Collection: RoleModel,
      readFilter: {
        [constants.fields.Role.organizationId]: organization.id,
        [constants.fields.Role.name]: name,
      },
      baseFilter: false,
    });
    if (!role)
      await OrganizationController.dbInsertRecord({
        Collection: RoleModel,
        data: {
          [constants.fields.Role.organizationId]: organization.id,
          [constants.fields.Role.name]: name,
          [constants.fields.Role.permissions]: permissions,
          [constants.fields.Role.isSystemRole]: true,
        },
      });
  }

  const admin = await AuthController.dbReadRecord({
    readFilter: {
      [constants.fields.User.organizationId]: organization.id,
      [constants.fields.User.loginId]: "admin-001",
    },
    baseFilter: false,
  });
  if (admin) return;

  return AuthController.dbInsertRecord({
    data: {
      [constants.fields.User.organizationId]: organization.id,
      [constants.fields.User.loginId]: "admin-001",
      passwordHash: await hashPassword("Admin@123"),
      [constants.fields.User.isActive]: true,
      [constants.fields.User.isPlatformAdmin]: true,
    },
  }).then(() => {
    logger.info("Create First Admin Script - Admin Created");
  });
};
