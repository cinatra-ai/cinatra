# sdk-ui package

Shared UI primitives consumed by all packages and the main app.

## Modal components

`BackgroundProcessModal` uses `AppDialog` from `@/components/app-dialog`. The `dismissible` prop maps directly to `!effectiveRunning` — block dismiss when a background process is running (stop icon shown), allow dismiss when it completes (close button shown).

Any new modal added to sdk-ui must also use `AppDialog`. Do not introduce new `fixed inset-0` backdrop + content pairs or `createPortal` calls for dialog modals.

## Background process flow

The `BackgroundProcessModal` + `useBackgroundProcessModalSession` pair is the standard pattern for long-running operations:

- `useBackgroundProcessModalSession` manages open/closed state and `updatedAt` for the modal's `viewKey`
- `BackgroundProcessModal` handles step normalization (pending → failed/completed) and `dismissible` gating
- `steps` prop is optional — omit it when the process has no discrete steps to show

## Exports

Existing public components and hooks are re-exported from `index.ts`. Do NOT add NEW components to the `index.ts` root barrel: the route-graph no-new-rot ratchet (`scripts/audit/route-graph-ratchet.mjs`) locks the reachable-module ceilings of routes that consume the barrel, and ceilings may only shrink — a new root-barrel export grows every consuming route by one module. Give a new component its own subpath export in `package.json` (see `"./section-header"`) and re-export it from `marketplace.ts` when it is consumer-portable.
