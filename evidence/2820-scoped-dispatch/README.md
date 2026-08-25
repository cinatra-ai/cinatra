# cinatra#2820 scoped dispatch: the inline run card, live

## Layout

- `inline-run-card.png` — the capture. The conversation column of `/chat` in DEFAULT
  layout, on a real signed-in session, after the canonical documented message
  `Use @cinatra-ai/code-reviewer-agent to review this code` was typed into the real
  composer and sent. The inline run card renders: "Creation progress / Queued",
  "Agentic Run Progress" carrying `running`, and the "Open the run page" link
  (`data-testid="inline-run-page-link"`).
- `inline-run-card-capture.md` — the full record of all three attempts that produced it,
  with the log line, `file:line` or pixel behind every claim. Read it for the boundaries
  that were closed on the way, and for the honest limit of what the PNG proves.

## What this evidence proves

Rows 1 and 2 rest on the dev-server log lines the record quotes; row 3 is what the pixels
themselves carry.

| # | Claim | Evidence |
| --- | --- | --- |
| 1 | The client router change works on the real surface: the message reaches the server at all | Before the fix the client answered the no-responder plan and posted nothing. The server pre-router ran. |
| 2 | `detectExplicitDispatchPackage` resolves the canonical package from the real typed message | `[assistant-runtime] explicit-dispatch pre-router HARD short-circuit: @cinatra-ai/code-reviewer-agent` |
| 3 | The HARD short-circuit queues the run and the inline card renders, with NO LLM turn | `runtime.ts:1387` sits in the success arm that `:1382` opens and `:1389` returns from, before the LLM path. The card is in the pixels. |

## What this evidence does NOT prove

The agent's own run output. The lane's WayFlow runtime carried no model credential, so
the queued run failed downstream of the card. That is a property of the lane, not of the
branch: the card renders and the run is queued before any model is called. Stated as
unproven rather than inferred.

## Reproduction note

No fixture seeding and no hand-written `installed_extension` row were used.
`@cinatra-ai/code-reviewer-agent` is a REQUIRED bundled agent
(`cinatra-required-extensions.lock.json:55`), and ordinary boot installs it. The
opt-in run gate (`packages/agents/src/runtime-install-gate.ts:152-153`, `:160-166`)
does not apply to it.
