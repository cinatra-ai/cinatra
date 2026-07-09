// Shared helper for locked Uninstall confirm copy. Centralized here so the
// three call sites (RegistryUninstallForm, RegistryCatalogScreen
// update-available branch, RegistryCatalogScreen current/installed-newer
// branch) cannot drift independently. Do not rephrase without updating the
// dependent call-site expectations.
//
// cinatra#1061 req 4: when the ACTIVE dependents that require this agent are
// known, NAME them in the confirm so the operator sees the blockers BEFORE
// confirming (the removal gate refuses otherwise). `dependents` is optional and
// backward-compatible — the existing no-arg call sites are unchanged.
export function uninstallConfirmMessage(packageTitle: string, dependents?: string[]): string {
  const base = `Uninstall ${packageTitle}? This removes the agent template from this workspace.`;
  if (dependents && dependents.length > 0) {
    const them = dependents.length === 1 ? "it" : "them";
    return `${base}\n\nRequired by ${dependents.join(", ")} — uninstall or archive ${them} first.`;
  }
  return base;
}
