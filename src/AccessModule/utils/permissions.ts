export const permissionCatalogue = [
  "organization.read", "organization.update", "office.read", "office.manage",
  "department.read", "department.manage", "employee.read.self", "employee.read.team",
  "employee.read.all", "employee.create", "employee.update.self", "employee.update.employment",
  "employee.archive", "role.read", "role.manage", "role.assign", "audit.read",
  "attendance.checkin", "attendance.read.self", "attendance.read.team",
  "leave.read.self", "leave.request", "leave.manage", "leave.approve"
] as const;

export const defaultRoles = {
  organizationAdmin: [...permissionCatalogue],
  manager: ["employee.read.self", "employee.read.team", "attendance.checkin", "attendance.read.self", "attendance.read.team", "leave.read.self", "leave.request", "leave.approve"],
  employee: ["employee.read.self", "employee.update.self", "attendance.checkin", "attendance.read.self", "leave.read.self", "leave.request"],
};
