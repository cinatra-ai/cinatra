import { registerPermissionsPrimitives } from "./registry";

export function createPermissionsModule() {
  return {
    registerCapabilities: registerPermissionsPrimitives,
  };
}
