# Skills-drift acknowledgment — 9cb0ae148 (#2005)

## What triggered this

The squash `9cb0ae148` ("refactor(sdk): #1896 — re-home the dashboardContribution
carrier to the artifact kind", PR #2005) modified
`packages/agents/src/mcp/handlers.ts`, which is a declared `cinatra-watches`
surface for these assistant skills:

- `chat-artifact-extension-authoring`
- `chat-extension-discovery`
- `chat-skill-extension-authoring`
- `chat-workflow-extension-authoring`

The push-to-main arm of `skills-drift-gate` flagged the surface because the
squash body carried no `Skills-*` acknowledgment marker.

## Why the watching skills are unaffected

The only change to `packages/agents/src/mcp/handlers.ts` in that squash was a
one-line edit to the artifact-package validation **diagnostic error string** in
`validateArtifactPackageOnDisk` — the list of allowed top-level `cinatra.*`
manifest keys reported to an author who declares an unexpected key gained
`dashboardContribution`:

```
artifact extensions may only declare cinatra.{kind,apiVersion,artifact,dependencies,roles,displayName,vendor,views,fieldRenderers,dashboardContribution}; unexpected key(s): ...
```

No MCP primitive name, tool/input shape, dispatch contract, or polling contract
that the watching `chat-*` skills document changed. The skills describe the MCP
authoring/discovery surface behavior; a wider allowed-key set in a validator's
human-readable message does not alter any behavior those skills teach, so none
of them goes stale.

## Resolution

This docs-only note records the acknowledgment. The gate-satisfying marker is
carried in the acknowledging PR body as a single-line
`Skills-unaffected: ...` entry naming the surface and the reason above, and the
same marker rides the squash into `main` so the push-to-main gate arm reads it
for the `9cb0ae148` finding.
