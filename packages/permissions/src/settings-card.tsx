import Link from "next/link";

export function PermissionsSettingsCard() {
  return (
    <Link href="/configuration/permissions" className="soft-panel rounded-panel px-5 py-5 transition hover:-translate-y-0.5">
      <p className="text-lg font-semibold text-foreground">Permissions</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Manage workspace users, MCP clients, A2A service accounts, and access controls.
      </p>
    </Link>
  );
}
