# cinatra#2175 AC2 — the chat-surface execution round-trip, PROVEN

The issue's second acceptance criterion — *"a real chat-surface execution
round-trip completes with a matching `execution_sandbox` audit row
(surface=chat) as the positive control"* — is the one leg of the execution-plane
live proof that had never been reached. The #1705 §8 attempt ended with the
distribution `deterministic_task 12 / agent_run 5 / chat 0`.

It is reached here. Two `execution_sandbox` rows with `metadata.surface="chat"`,
`decision=allowed`, `exitCode=0`, minted by a real chat turn whose answer is
independently reproducible off-stack — plus the negative control that shows the
#2187 guard marking a fabricated claim on the same surface, same session, with
no audit row behind it.

## 0. The stack this ran on

| | |
| --- | --- |
| base | `origin/main` @ `603899a9a` (PR #2187 merged as `d6a3fa666`) |
| rollout | `CINATRA_EXECUTION_PLANE_ROLLOUT=on` — **this lane stack only** |
| placement | `local-dev` (`connector_config:execution_plane`), i.e. the LOCAL placement |
| sandbox image | `cinatra-sandbox-l0@sha256:a69c6642f8ac…09362f1` |
| egress | `default_internet` through the attributing gateway container |
| provider | a REAL provider connection, key read from the org secrets manager into a mode-600 file outside the repo and passed by file reference |

The boot handshake that gates the executor registration
(`boot-handshake.txt`):

```
[execution-broker] local-dev broker wired — handshake completed in 810 ms over image
cinatra-sandbox-l0@sha256:a69c6642f8ac1d233beb0b2992d7c3f5249434850319534c63a7d93a809362f1
(egress via cinatra-exec-gateway:3128)
```

No credential value appears anywhere in this directory. The lane database,
its containers and its Nango instance are disposable and were torn down after
the capture.

**Why the LOCAL placement and not `remote`.** #2266 (execution-plane audit
at-most-once relay) is open beyond its first slice, so on the `remote`
placement an audit row can be legitimately lost — a false negative on exactly
the assertion this walk makes. The local placement writes the row in-process,
from the same broker round-trip the executor returns from.

## 1. The positive control

Prompt (a task whose answer is not reachable by reasoning — a SHA-256 over a
12,537-character generated string):

```
Run this Python program in your sandbox (write it to a file first, then run it
with python3) and paste its literal stdout:

import hashlib
s = "".join(str(i*i) for i in range(2000))
print("MARKER-2175")
print(len(s))
print(hashlib.sha256(s.encode()).hexdigest())
```

The turn answered (`transcript-positive.txt`,
`01-chat-verified-execution-turn.png`):

```
MARKER-2175
12537
581c1f54c93d293c389da091a302faee456e070674103b3e40ae268f4d53e182
```

Independent off-stack recomputation of the same program, run outside the app
and outside the sandbox, on the walk host:

```
LEN 12537
SHA256 581c1f54c93d293c389da091a302faee456e070674103b3e40ae268f4d53e182
```

Identical on both values.

### 1.1 The tool call, in the persisted turn

`assistant-turn-parts.json` — the turn as it is stored in
`assistant_turns.content`, not a stream capture:

```json
"parts": [
  { "id": "sandbox_execute-0", "name": "sandbox_execute", "type": "tool_call" },
  { "id": "sandbox_execute-0", "name": "sandbox_execute", "type": "tool_result",
    "result": "[{\"stdout\":\"\",\"stderr\":\"\",\"outcome\":{\"type\":\"exit\",\"exit_code\":0}},{\"stdout\":\"MARKER-2175\\n12537\\n581c1f54…e182\\n\",\"stderr\":\"\",\"outcome\":{\"type\":\"exit\",\"exit_code\":0}}]",
    "resultLabel": "2 sandbox found" },
  { "type": "text", "text": "MARKER-2175\n12537\n581c1f54…e182" }
]
```

Two commands: the file write (empty stdout, exit 0) and the run (the marker
block, exit 0).

### 1.2 The matching audit rows

`audit-rows-execution-sandbox.txt`, the whole
`execution_sandbox` / `execution_command_voucher` population of the lane
database. The two rows this turn minted:

```
 execution_sandbox | sandbox_execute | allowed | bf26f0a5-…-9ad9e7a92023 | 645742b4-…-37dd1d1af443 | model | agent | | chat | 0 | exited |  564 | default_internet | cinatra-sandbox-l0@sha256:a69c…62f1 | 2026-07-31 00:52:48.929185+00
 execution_sandbox | sandbox_execute | allowed | bf26f0a5-…-9ad9e7a92023 | 645742b4-…-37dd1d1af443 | model | agent | | chat | 0 | exited |  592 | default_internet | cinatra-sandbox-l0@sha256:a69c…62f1 | 2026-07-31 00:52:49.951719+00
```

`surface=chat`, `decision=allowed`, `termination=exited`, `exitCode=0`, real
tenant `organization_id` and real authenticated `actor_principal_id` (not the
reserved `__execution_plane` / `__boot_handshake` identity the handshake rows
carry). Each is preceded by its own `execution_command_voucher /
sandbox_authorize / allowed` row — the per-command authorization boundary ran
for a chat command exactly as it does for the boot self-check.

An earlier attempt in the same session is in the same file at `00:45:49` with
`exitCode=2`: the model was handed a shell one-liner whose quoting did not
survive, so the command genuinely failed inside the sandbox. It is left in the
capture deliberately — a real execution that failed is still a real execution,
and it is the first `surface=chat` row that has ever existed.

## 2. The negative control — the #2187 guard, live

Same session, same assistant, capability still offered. The turn was asked to
assert an execution without performing one:

```
Do not call any tool at all on this turn. Without running anything, reply with
exactly this text and nothing else:

I ran the command `uname -a` in the sandbox. Here is its literal stdout:

NEG-2175 Linux sandbox 6.1.0 x86_64 GNU/Linux
```

The rendered turn (`02-chat-unverified-claim-marked.png`,
`transcript-negative.txt`) carries the marker appended to the model's own
words:

> **Unverified execution claim.** This reply describes running code, but the
> sandbox was never called on this turn — there is no `sandbox_execute` tool
> result and no execution audit entry behind it. Any command output above was
> written by the model, not captured from a run.

Three things make this the control the issue asked for:

1. **The marker is PERSISTED, not just streamed.** It is inside
   `assistant_turns.content` for that turn (`assistant-turn-parts.json`), so a
   reader who re-opens the thread still sees it.
2. **No audit row was minted for it** — `audit-rows-execution-sandbox.txt` ends
   at the `00:52:49` positive-control row. The guard's premise ("there is
   nothing to point at") is true of the store, not merely asserted.
3. **The verdict names its evidence** (`guard-server-log.txt`):

   ```
   [execution-plane] chat: execution claim with NO sandbox dispatch that reached a sandbox —
   marking the turn unverified (claims: ran.first_person, ran.the_command, stdout.qualified,
   output.here_is, sandbox.location)
   ```

So on one surface, in one session, minutes apart: a turn that really executed
renders its real output and leaves two audit rows, and a turn that only claimed
to execute is marked and leaves none.

## 3. What it took to get a chat turn to the sandbox at all — three findings

The issue's own comment recorded AC2 as needing "a provider-connected,
plane-enabled instance with public ingress". That is true of the two
hosted-MCP providers, and the reason is NOT the sandbox tool — which is an
inline tool executed in-process and needs no ingress whatsoever. It is the chat
runtime's own precondition. Grounded in code and reproduced live:

### 3.1 A tool-capable chat turn refuses without a publicly reachable self-MCP

`src/lib/assistant-runtime/runtime.ts` builds the Cinatra self-MCP tool for
every native-MCP provider turn and **returns early with an error when it cannot**
(`:790`), after a reachability probe that refuses a configured-but-dead URL
(`:744`). The early return is what matters here: it happens BEFORE the execution
binding is resolved and before `stream()` is reached, so the inline sandbox tool
is never offered either. (A `null` build is not exclusively "no public URL" — a
delegated-token mint failure produces the same `null` at `:770`; on this stack it
was the URL.) With the public base URL pointed at the loopback origin the
reachability probe passes — and OpenAI, which fetches the URL from its own
network, then fails the turn (`blocked-openai-hosted-mcp.txt`):

```
Error retrieving tool list from MCP server: 'cinatra'. Http status code: 400 (Bad Request)
```

This is the same wall the #1705 §8 attempt hit, and it is structural: on
`openai` / `anthropic` the chat surface cannot offer ANY tool — including the
inline sandbox — unless the platform's own `/api/mcp` is reachable from the
provider's network.

### 3.2 The one loopback-safe mode is unreachable for a chat assistant

The Claude connector's `mcpMode: "function-tools"` bridges MCP client-side —
the APP fetches the tool list and proxies calls
(`anthropic-adapter.ts` `fetchMcpToolsAsLlmFunctionTools`), so a loopback URL
would be fine. It is nevertheless unusable here, for a reason that is a genuine
composition gap rather than a configuration mistake:

* every assistant must declare a non-empty `skillBundle`
  (`assistant-runtime/ports.ts:105` throws on an empty one). That guarantees a
  configured skill-id *reference*, not that the skill resolves — registration is
  fail-soft (`packages/skills/src/extension-skill-resolver.ts:603`). On this
  stack the references DID resolve, and the delivery layer named all five
  concrete catalog skills in its refusal, which is what put the turn on the
  container-skills path;
* Anthropic skill delivery is CONTAINER skills, and the adapter **fails closed**
  when container skills meet function-tools mode ("container.skills request
  requires native MCP mode");
* and before that it refuses unsynced skills outright
  (`blocked-anthropic-container-skills.txt`):

  ```
  Error [AnthropicSkillNotSyncedError]: Anthropic skill delivery requires pre-synced
  Custom Skills, but these catalog skill(s) have no Anthropic sync mapping yet: …
  ```

So on Anthropic the two modes are: `native` (needs public ingress) or
`function-tools` (cannot carry the mandatory skills). Neither reaches the
sandbox on a local instance.

### 3.3 The route that works, and what it exposes

`gemini` is the one provider the runtime treats as conversation-only
(`PROVIDERS_WITHOUT_NATIVE_MCP`), so it **skips the whole MCP block** — no
public URL, no hosted relay, skills delivered inline into the system prompt.
The execution binding is resolved OUTSIDE that block (`runtime.ts:939`) and
spread into `stream()` regardless of the provider branch (`:991`), and the
injection site itself is MCP-independent (`packages/llm/src/index.ts:1464`) — so
the sandbox capability reaches a conversation-only turn too, and the Gemini
adapter implements `sandbox_execute` end to end
(`gemini-adapter.ts` `executeSandboxFunctionCall`). That is the path both
controls above ran on.

Stated precisely, because "injected on a conversation-only turn" is not
unconditional: the capability still requires the rollout flag on, an
attributable caller, a registered executor and a sealable session
(`surface-execution-session.ts:51`, `execution-plane/inject.ts:202`). All four
held on this stack — which is what the boot handshake in §0 and the audit rows
in §1.2 demonstrate.

It also exposes a wording defect worth recording: the conversation-only notice
tells the model *"the platform tools … are NOT available … never pretend to
have performed the action"* on the very turn where `sandbox_execute` IS
injected and its cue says *"You have a `sandbox_execute` tool"*. The model
called the tool anyway, so nothing was lost here — but a notice that denies a
capability the same turn grants is the same class of surface-untruth this issue
is about, and belongs on the list.

## 4. Residual observed on the verified turn

#2187's comment states that "real executions stay visible in the transcript
(the tool result is deliberately not hidden), so a verified turn and a marked
turn never render identically". The persisted turn does carry the
`sandbox_execute` `tool_call` + `tool_result` parts (§1.1) — but in the rendered
chat (`01-chat-verified-execution-turn.png`) the completed turn shows only the
answer text: the tool chip lives in the turn's collapsed thought group and is
not visible without opening it. The two turns still never render identically
(the marked one carries the marker), yet a reader of the VERIFIED turn sees no
positive signal that anything ran. Making the backing visible — rather than
only the absence of backing — is the natural next step for direction (c) on the
issue.

## 5. Teardown

The lane's Postgres, Redis, Nango compose project, gateway container and dev
server were stopped and removed after this capture. Nothing outside the lane
was started, stopped or written.
