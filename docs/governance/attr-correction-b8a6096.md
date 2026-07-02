# Attribution correction for b8a609674a277e97883bb65ffd1fb0016dfce309

Commit b8a6096 (PR #783 — fix(extensions): fail-fast on null cinatra.kind at
the install planner) landed on main 2026-06-30 with a malformed Accountable
trailer: `Accountable: groganz-bot[bot]` (the bot-login `[bot]` form, which the
gate parser rejects — the Accountable trailer requires the full identity form
`Name <email> (@login)`).

The Correction-for PR (#785) carries the corrected machine-arm trailer.
No code changes; docs-only correction.
