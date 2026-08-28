# cinatra#3003 — a fired run of the author agent reaches its model step

A REAL run, not a fixture: a one-off schedule armed through the product's own
schedule form on a dev instance with the agent runtime up (`--profile wayflow`),
left to fire on its own clock.

Agent: `@cinatra-ai/author-agent@0.1.2` (the fix), mounted by the runtime from
the pinned extension tree.

## The trigger fired on its own clock

    run_id        d172151d-761f-4d96-947c-d5d109915069
    trigger_type  scheduled
    scheduled_at  2026-08-27 20:35:00+00
    timezone      Europe/Berlin
    enabled       t
    released_at   2026-08-27 20:35:00.307+00

307 ms after the due time. Nothing nudged it.

## The child run reached its model step and completed

    id            d172151d-761f-4d96-947c-d5d109915069
    status        completed
    created_at    2026-08-27 20:26:35.635158+00
    completed_at  2026-08-27 20:36:36.225+00
    error         (none)
    input_params  {"spec": "Author a Cinatra agent extension that summarizes an
                   RSS feed into a weekly digest."}

## The runtime ACCEPTED the start — this is the defect closing

The A2A start message the dispatcher actually sent, read back off the run's own
stored `step_results`:

    {"spec": "Author a Cinatra agent extension that summarizes an RSS feed into
      a weekly digest.", "cinatra_run_id": "d172151d-761f-4d96-947c-d5d109915069"}

`packageSlug` is ABSENT from it. That is precisely the message the runtime used
to refuse with `Cannot start conversation because of missing inputs
"packageSlug"`. With `"default": ""` on the flow input the runtime substitutes
the default and starts the conversation.

Runtime log for this agent (whole container lifetime):

    [agent_loader] backfill marker cinatra-ai/author-agent in state dir (version=0.1.2)
    [agent_loader] bridge output_schema derived cinatra-ai/author-agent: author(draft)
    [agent_loader] serve_agent validation bypassed for ApiNode-only flow: @cinatra-ai/author-agent
    [agent_loader] cinatra-ai/author-agent: ASGI accessor = server.get_app()
    [agent_loader] mounted cinatra-ai/author-agent at /agents/cinatra-ai/author-agent/
    GET  /agents/cinatra-ai/author-agent/.well-known/agent-card.json  200 OK
    POST /agents/cinatra-ai/author-agent/                             200 OK

Occurrences of `missing inputs` in the runtime log: **0**.
Agents mounted: **29 / 29**, zero mount failures.

## A real provider call was recorded

    occurred_at         2026-08-27 20:36:34.177+00
    source              llm
    provider            openai
    model               gpt-5.5-2026-04-23
    operation           generate
    agent_label         author-agent
    input_tokens        36823
    output_tokens       1660
    requested_provider  openai
    effective_provider  openai

App log: `POST /api/llm-bridge 200 in 39.7s`, then
`[wayflow] run=d172151d-… state=completed`. The stored `step_results` carry the
model's real draft output (a complete `@cinatra-ai/rss-weekly-digest-agent`
package draft). `CINATRA_TEST_LLM_PROVIDER` was unset; the provider credential
came from the instance's own encrypted store.

## The compiled schema carries the default end to end

The installed template row after the install, i.e. the compiler change proven on
a real instance rather than in a fixture:

    package_name     @cinatra-ai/author-agent
    package_version  0.1.2
    input_schema     {"type":"object","required":["spec"],"properties":{
                       "agent_run_id":{"type":"string","title":"agent_run_id",
                                       "x-hidden":true,"default":""},
                       "packageSlug":{"type":"string","title":"packageSlug",
                                      "x-hidden":true,"default":""},
                       "spec":{"type":"string","title":"spec"}}}

Before this change the compiler stripped `default`, so the pre-dispatch guard
had nothing to read.

## Picture

`run-model-step.png` — the run page at 1440x900 @2, light, full window: the rail
shows `Schedule` and `Step 1` complete, and the run reads `completed`.

## One defect this run caught that no fixture did

The first attempt at the extension fix defaulted only the StartNode's `inputs`.
The runtime refused to mount the agent at all:

    ValidationError: 1 validation error for StartNode
    If both inputs and outputs are specified for a StartNode, they must be equal.

The shipped fix defaults the `outputs` copy too. Everything above was measured
after that correction.
