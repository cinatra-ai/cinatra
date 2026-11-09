# `dashboard-producer-agent` — a run that writes a dashboard

A deterministic, **no-LLM, no-connector, no-secret** agent that exists for one
reason: its run writes one dashboard, so a dashboard an agent run produces has a
producer an e2e harness can drive (cinatra#3092).

Not a product extension. Private, never published, and mounted only from this
tree — the same shape `tests/fixtures/review-gate-agent/` uses.

## Why it exists

A dashboard names the agent run that wrote it as its producer only when the
write carries a verified run. An LLM step reaches the dashboards tools only
through a native-MCP model, and the stand-in model makes no tool call, so a
credential-free walk had no run that writes a dashboard. The passthrough admits
`dashboards_create` for the run the bridge binding proves: it writes as that
run's owner, with that run's id and the run's org-write authority.

## The flow

```
StartNode(title: string, cinatra_run_id: string)
   → ApiNode "write_dashboard"   POST {{CINATRA_BASE_URL}}/api/agents/passthrough
                                 { tool: "dashboards_create",
                                   input: { name: "{{ title }}", ownerLevel: "user", ownerId: "me",
                                            config: <one fixed agent_runs portlet> },
                                   agent_run_id: "{{ agent_run_id }}" }
       → EndNode(dashboardId)
```

The dashboard is a personal dashboard of the run's owner. The request carries
no organization, user or run of its own: the passthrough takes all three from
the proven run.

## How it is used

`tests/e2e/agents-run/dashboard-producer-fixture.ts` stages the tree into
`extensions/<vendor>/<slug>/` (the directory both the host's dev boot scan and
the WayFlow runtime read) with `stageDashboardProducerFixture`, and seeds one
run of `@cinatra-dashboard-fixture/run-writes-dashboard` with a `title` with
`seedDashboardProducerRun`, the same way
`tests/e2e/agents-run/review-gate-fixture.ts` stages and seeds its fixture.

## Keeping the marker in sync

`.cinatra-published.json` carries `oasSha256` over the raw bytes of
`cinatra/oas.json`. The WayFlow loader refuses to mount an agent whose marker
does not match, so **re-hash after every edit**:

```sh
shasum -a 256 cinatra/oas.json
```

`src/__tests__/dashboard-producer-fixture-3092.test.ts` checks the marker, the
runtime invariants, the one passthrough call and the tool's input schema.
