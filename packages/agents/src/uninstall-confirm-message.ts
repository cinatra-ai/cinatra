// Shared helper for locked Uninstall confirm copy. Centralized here so the
// three call sites (RegistryUninstallForm, RegistryCatalogScreen
// update-available branch, RegistryCatalogScreen current/installed-newer
// branch) cannot drift independently. Do not rephrase without updating the
// dependent call-site expectations.
export function uninstallConfirmMessage(packageTitle: string): string {
  return `Uninstall ${packageTitle}? This removes the agent template from this workspace.`;
}
