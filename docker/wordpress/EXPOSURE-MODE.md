# WP MCP gateway — exposure-mode verdict

**Pinned tuple:** WordPress `6.9` · mcp-adapter `0.5.0` · enable-abilities-for-mcp `2.0.20`

**Verdict: `triad-only`** (for the mcp-adapter **default / eafm aggregator** server).

- Machine record: [`tests/e2e/wp-mcp-gateway/captures/exposure-mode.json`](../../tests/e2e/wp-mcp-gateway/captures/exposure-mode.json)
- Verbatim evidence: [`captures/annotations-a-raw-tools-list.json`](../../tests/e2e/wp-mcp-gateway/captures/annotations-a-raw-tools-list.json)
- Captured by: run <https://github.com/cinatra-ai/cinatra/actions/runs/30202762361> (head `e062837f`)

## What the capture found

On the adapter's **default server** (`/wp-json/mcp/mcp-adapter-default-server`), a raw
`tools/list` returns **only the gateway triad** — three tools, no per-ability
entries:

- `mcp-adapter-discover-abilities`
- `mcp-adapter-get-ability-info`
- `mcp-adapter-execute-ability`

All 60 WP-core / eafm / fixture abilities (`core/*`, `ewpa/*`, `fixturelabs/*`)
are **discoverable** through `discover-abilities` and **callable** via
`execute-ability(ability_name, parameters)` — but none is listed as its own
`tools[].name`. That is the definition of **triad-only** exposure (design §4): the
presence/absence of per-ability `tools/list` entries is the verdict, and here they
are absent.

### Decision rule applied

> per-ability entries present ⇒ `first-class`; else ⇒ `triad-only`.

Zero `ewpa/*` or `fixturelabs/*` abilities appear as individual tools on the
default server ⇒ **`triad-only`**.

## Nuance — the dedicated third-party server IS first-class

The fixture's **dedicated** MCP server (`/wp-json/fixturelabs/fixturelabs-server`,
created via `McpAdapter::create_server()` with an explicit `tools[]` list) exposes
all six `fixturelabs/*` abilities as **first-class tools with annotations
transported** (`fixturelabs-note-get` → `readOnlyHint:true`, `fixturelabs-note-delete`
→ `destructiveHint:true`, `fixturelabs-note-set` → `idempotentHint:true`). Exposure
mode is therefore a property of **how a given server was constructed**, not of the
adapter globally: the *default aggregator* is triad-only; a *purpose-built server*
can be first-class. The verdict above is specifically for the default/eafm
aggregator — the surface cinatra's gateway enrolls for WP-core abilities.

## Downstream (S4 — not changed by S1)

`triad-only` ⇒ **M1/list only; no native injection for the gateway (default)
server** — abilities reach the model through `execute(ability_id, args)`, not as
individually-injected tools. S1 only **records** this verdict; it changes no
injection code (design §4/§8). A pin bump re-runs the capture and updates this
file and `exposure-mode.json` in the same PR (the required capture-freshness gate
forces the refresh).
