# @cinatra-ai/permissions

Workspace access-control surface for Cinatra. Provides the React UI for managing
members, platform roles, and per-scope role grants, plus the admin impersonation
banner and the MCP primitives that drive these operations programmatically.

## Public API

The package entry point (`src/index.ts`) exports React components:

- `PermissionsSettingsCard` — settings card linking to the permissions screen.
- `ImpersonationBanner` — sticky banner shown while an admin impersonates a user, with a stop control.

The package also registers MCP primitives for headless access control:

- `permissions_members_invite` — invite a member to an organization.
- `permissions_members_update_role` — change a member's organization role.
- `permissions_members_remove` — remove a member from an organization.
- `permissions_users_update_platform_role` — set a user's platform role.
- `permissions_invitations_cancel` — cancel a pending invitation.
- `role_grant_grant` / `role_grant_revoke` / `role_grant_list` — manage per-scope role grants.

## Usage

```tsx
import { ImpersonationBanner, PermissionsSettingsCard } from "@cinatra-ai/permissions";

export function Chrome() {
  return (
    <>
      <ImpersonationBanner />
      <PermissionsSettingsCard />
    </>
  );
}
```

## Docs

See https://docs.cinatra.ai
