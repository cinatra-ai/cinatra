# cinatra#2700 — /configuration admin gate: visual proof

Captured on a lane host against a real dev server (Next.js dev), 1440×900, with
two real sessions the database records as `role=admin` and `role=user`
(`roles.txt`). No credentials were placed on the lane host.

- `member-*.png` — the non-admin member on /configuration/development,
  /configuration/telemetry, /configuration/llm, /configuration/extensions,
  the agent-approval detail page and the artifact-restore page: every one lands
  on `/not-authorized` ("This area is limited to platform admins.").
- `anon-*.png` — an unauthenticated visitor on the same six routes: every one
  lands on `/sign-in?next=<route>`.
- `admin-*.png` — the admin on the same six routes: each renders (Development,
  Telemetry, LLM, Extensions in its "Setup required" branch because the lane
  instance has no namespace configured, the approval detail, and the restore
  page showing the per-object denial for a nonexistent change set — the
  per-object check still runs on top of the gate; the admin gate does not
  bypass it).
- `mcp-handler-denials.txt` — the six /configuration MCP route-handler methods
  probed with the member session: three JSON denials (403/401) and three
  browser-form POSTs answering 303 → /not-authorized.
- `results.json` — route → final path → h1 for all 18 navigations.
