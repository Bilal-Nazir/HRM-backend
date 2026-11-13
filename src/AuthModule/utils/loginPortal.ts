import {
  UnauthenticatedException,
  ValidationException,
} from "../../node-base/utils";
export function assertLoginPortal(portal: unknown, isPlatformAdmin: boolean) {
  if (portal !== "admin" && portal !== "employee")
    throw new ValidationException("Invalid login portal");
  if ((portal === "admin") !== isPlatformAdmin)
    throw new UnauthenticatedException(
      portal === "admin"
        ? "Only Super Admin can use the admin login"
        : "Super Admin accounts must use the admin login",
    );
}
