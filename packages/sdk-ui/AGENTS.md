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

All public components and hooks are re-exported from `index.ts`. Add new exports there when adding components to the package.
