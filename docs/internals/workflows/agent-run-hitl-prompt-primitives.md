# Authoring guide — run-scoped HITL prompt primitives (prep-node + resume-mutation)

How an agent extension assembles and shapes its human-in-the-loop (HITL) payload
from **inside its own workflow** — with a deterministic primitive call before the
interrupt and a typed mutation applied after the resume — instead of a field
renderer reaching an authenticated host action.

- Status: normative authoring guidance (epic #1620, owner action-boundary ruling
  2026-07-18; the enabling primitives landed with #1794).
- Audience: authors of `kind:"agent"` workflow extensions (`cinatra/oas.json`)
  whose HITL screens used to depend on host server actions — the auditor
  family, and the generic review surface built on top.

## Why this exists

The public field-renderer props contract is deliberately a pure
`snapshot → onChange` surface: a renderer receives an authorized snapshot and
emits a value; it **cannot** call an authenticated host action. Action-coupled
HITL screens therefore move their authenticated work into the agent's **own
workflow**:

- **data prep** runs *pre-interrupt* as a deterministic node in the workflow, and
- **mutations** ride the typed resume payload and are applied *post-resume* via a
  deterministic node.

Two run-scoped MCP primitives supply the missing machinery for the HITL prompt
store:

| Primitive | Purpose |
|-----------|---------|
| `agent_run_hitl_prompts_list` | Run-scoped snapshot of the run's own captured HITL amendment prompts, for pre-interrupt payload assembly. |
| `agent_run_hitl_prompts_exclude` | Batch, idempotent (un)exclusion of the run's own prompts — flags which rows autosave / payload assembly skips. |

## Trust model (read this first)

Both primitives derive **everything that scopes them** from the invocation
context — never from caller input:

- **run** — a run id from a VERIFIED channel only: either an OBO
  `delegation:"agent_run"` actor (its run id is a signed token claim) or the
  `verifiedRunScopeId` a trusted server-side seam stamps (`/api/agents/passthrough`
  after `bindBridgeRunId`). The plain ambient `runId` is deliberately NOT trusted
  — the MCP transport also fills it from the caller-controlled `x-cinatra-run-id`
  header — so a `runId` in the tool `input` OR that header cannot redirect the
  scope. No verified channel ⇒ fail closed.
- **declaring agent package** — the run's own template `packageName` (the
  prompts store `agent_id = template.packageName` at capture time). Not a
  caller-supplied `agentPackageName`, and not the untrusted provenance tag on the
  frame.
- **actor** — the context-built actor envelope, gated by `enforceRunAccess`
  against the run row (`read` for list, `respondToHitl` for exclude).

Consequences an author can rely on:

- calling either primitive **outside a run** fails closed (a bare chat/session
  MCP call can never reach another run's prompts);
- `exclude` validates **every** id against the run's own `(run, declaring-agent)`
  prompt set and rejects the **whole batch** on any unknown id — no cross-run,
  cross-agent, stale, or partial mutation;
- `exclude` is idempotent (re-applying the same target state is a no-op) and
  batch-bounded.

## The deterministic pre-interrupt seam

A workflow reaches these primitives deterministically through the existing
**`/api/agents/passthrough`** node — an `ApiNode` whose body is
`{ tool, input, agent_run_id }`. The route binds the body-selected
`agent_run_id` to the run actually executing the callback (the auth-injected
context-id header — not author-writable), then invokes the named primitive
**inside a run-bound `mcpRequestContextStorage` frame** carrying that verified
run id. That frame is what makes "derive the run from context" work off the
LLM path.

`agent_run_hitl_prompts_list` and `agent_run_hitl_prompts_exclude` are on the
route's deterministic-dispatch allowlist.

### Prep-node shape (`oas.json`)

A prep `ApiNode` placed *before* the interrupt (gate) node, wired into the gate
via a `DataFlowEdge`:

```jsonc
// $referenced_components.prep_list
{
  "component_type": "ApiNode",
  "id": "prep_list",
  "name": "Assemble HITL payload",
  "url": "{{CINATRA_BASE_URL}}/api/agents/passthrough",
  "http_method": "POST",
  "data": {
    "tool": "agent_run_hitl_prompts_list",
    "input": {},
    "agent_run_id": "{{ agent_run_id }}"   // bound + verified route-side; NOT trusted as the run scope
  },
  "outputs": [{ "title": "prompts", "type": "array" }]
}
```

```jsonc
// data_flow_connections — route the prep output into the gate input
{ "component_type": "DataFlowEdge", "source": "prep_list", "source_output": "prompts",
  "target": "review_gate", "target_input": "prompts" }
```

Control flow: `start → prep_list → review_gate (InputMessageNode) → … → end`.
The renderer bound to `review_gate` reads `prompts` from its snapshot and stays a
pure `snapshot → onChange` surface — it never calls a host action.

### Pinned-runtime contract for the gate node (cinatra#1830)

Two consumers read this same `oas.json` and disagree about the gate node's shape;
authoring MUST satisfy both, and the WayFlow loader reconciles the difference:

- **The host** (`packages/agents/src/oas-compiler.ts`) pins
  `component_type: "InputMessageNode"` and reads the gate's **declared `inputs`**
  to surface the DFE-delivered values (e.g. `prompts`, `preview`) to the renderer
  via the runtime interrupt payload. So the gate is authored EXACTLY as above:
  `component_type: "InputMessageNode"` with declared `inputs` fed by a
  `DataFlowEdge`. Keep it that way.
- **The pinned WayFlow runtime** (`pyagentspec==26.1.2`) does the opposite: an
  `InputMessageNode` derives its expected inputs *only* from placeholder tokens in
  its message field and **rejects any explicitly-declared `inputs`** ("received a
  property titled `X`, but did not expect any properties"). A bare
  `AgentSpecLoader().load_json()` of the authored form therefore fails.

The **WayFlow agent loader reconciles this at mount** — see
`docker/wayflow/agent_loader.py` `_reconcile_input_message_gates`: it rewrites the
declared-input gate to wayflowcore's `PluginInputMessageNode` and synthesizes a
`message_template` whose placeholders reproduce the declared input titles (using
empty-rendering `{% if <name> %}{% endif %}` guards, so no payload text leaks into
the conversation), then drops the declared `inputs`. The `DataFlowEdge` keeps
delivering the same values. **Do not** author `PluginInputMessageNode` /
`message_template` directly — the host compiler pins the `InputMessageNode`
literal; author the declared-input form and let the loader reconcile it.

### The two mount paths, and what enforces the contract (cinatra#2140)

The same gate exists in **two encodings**, and both must satisfy this contract:

- **Standalone** — the agent package's own `cinatra/oas.json`, mounted by the
  WayFlow container as its own A2A agent. This is the declared-`inputs` form
  above; it reaches the runtime only through the reconcile shim.
- **Orchestrated** — the same gate inlined as a subflow of an orchestrator
  (e.g. `email-outreach-agent`). Those inlined copies declare **no** gate
  `inputs`, so they mount natively and never touch the shim.

Because the two travel different code, either can move without the other
noticing. Three things now hold them together:

1. `OAS-RUNTIME-013` in `packages/agents/src/validate-oas-runtime-invariants.ts`
   — the HOST half of the contract. It mirrors exactly what the shim can and
   cannot repair, and every rule is backed by an observed
   `pyagentspec==26.1.2` mount outcome, not by inference:
   declared input titles must be plain unique Jinja identifiers; the gate must
   not carry a *truthy* author-supplied `message_template` (a falsy one is
   overwritten by the shim and mounts, so it is deliberately allowed); it must
   declare exactly one `string` output; and it must never be an authored
   `PluginInputMessageNode`. It runs on every extension-lock bump via
   `.github/workflows/validate-agents.yml`.
2. `docker/wayflow/tests/test_gate_mount_both_paths.py` — mounts BOTH encodings
   through the real pre-load pipeline, asserts the shim fired on the standalone
   form and did **not** need to on the orchestrated one, and pins the
   repairability case table against the live pinned runtime.
3. The `WayFlow mount guard` job in `.github/workflows/validate-agents.yml`
   boots the repo's own WayFlow container over the **pinned** extension tree and
   runs those suites inside it, so a pin bump to an unmountable revision fails
   the PR. (Before #2140 the guard ran only inside `works-after proof`, which
   fires on upgrade paths and points `CINATRA_AGENTS_DIR` at a single-agent
   fixture tree — the real agents were never mounted in CI.)

A bare `AgentSpecLoader().load_json()` of the authored standalone form **is
expected to fail** with `received a property titled '<name>', but did not expect
any properties`. That is the pinned-runtime half of the contract, not a defect in
the OAS: any consumer that mounts an agent package must go through the loader's
pre-load pipeline (`_reconcile_input_message_gates`), exactly as
`_mount_one_sync` does.

**One-string-output rule.** An `InputMessageNode` gate returns **exactly one
`string` output** — the resume payload (the renderer's JSON-encoded `onChange`
value). Do NOT declare a second gate output (e.g. a separate `excludedPromptIds`
array wired out by its own `DataFlowEdge`): pyagentspec/wayflowcore reject a
multi-output `InputMessageNode`, and the loader shim cannot repair it. Extract any
additional fields from that single resume payload in a **post-resume node** (next
section) — `{{ review_gate.<field> }}` below refers to a field parsed out of the
one resume output, never to a second declared gate output.

## The resume-mutation pattern

The interrupt returns a typed resume payload (the renderer's `onChange` value).
Apply any mutation **after** the resume in a deterministic node — do NOT mutate
from the renderer.

- To drop bare-approval rows (or any the user deselected) from autosave /
  downstream assembly, call `agent_run_hitl_prompts_exclude` from a post-resume
  `ApiNode` with the ids to exclude (or `{ excluded: false }` to re-include).
  Because it is scoped + idempotent, a resume that re-runs the node is safe.

```jsonc
// $referenced_components.apply_exclusions (post-resume)
{
  "component_type": "ApiNode",
  "id": "apply_exclusions",
  "url": "{{CINATRA_BASE_URL}}/api/agents/passthrough",
  "http_method": "POST",
  "data": {
    "tool": "agent_run_hitl_prompts_exclude",
    "input": { "ids": "{{ review_gate.excludedPromptIds }}" }, // wired from the resume payload
    "agent_run_id": "{{ agent_run_id }}"
  },
  "outputs": [{ "title": "applied", "type": "integer" }]
}
```

## Rules of thumb

- Assemble the payload in a **prep node**, not the renderer; apply mutations in a
  **post-resume node**, not the renderer.
- Never pass a `runId` / `agentPackageName` in the primitive `input` expecting it
  to scope the call — it is ignored; the run-bound frame is authoritative.
- Treat an `exclude` batch as all-or-nothing: an unknown id rejects the batch, so
  compute the id set from the same run's `list` snapshot.
- Keep exclude batches within the documented bound; the captured HITL set for one
  run is small (one row per gate).

See also: the artifact-UI boundary ADR
([`../decisions/artifact-ui-boundary-adr.md`](../decisions/artifact-ui-boundary-adr.md))
for the renderer/host boundary this pattern preserves.
