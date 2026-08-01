# cinatra#1705 — AC1 / AC2 / AC3, the live-provider proof set

The acceptance audit (comment `5145911050`) left three "Proof lane." paragraphs
that all needed the same thing and had never been done: a **real provider turn**
that reaches the **real execution plane** on **openai** and **anthropic**, does
the three things the AC names, and leaves matching audit rows.

This directory is that walk. All six arms below come from **one invocation** of
`drivers/live-provider.walk.test.ts`, against real `api.openai.com` /
`api.anthropic.com` and a real Docker sandbox. Every artifact carries the run id
`ac123-2026-08-01T19-43-32-811Z` and a `manifest.json` with a sha256 of each
file the arm produced, so the "one invocation" claim is checkable rather than
asserted.

## Verdict, stated up front

| AC | verdict | residual |
| --- | --- | --- |
| **AC1** | **delivered**, with one clause narrowed — see §2.3 | the AC's "retain the RAW **persisted** turn" cannot be met by this lane's entry point: no assistant turn is persisted because none runs |
| **AC2** | **install-then-use clause delivered**; the "on the chat surface" binding is **NOT** re-proven here | this arm sets `surface="chat"` itself, so that field is not independent evidence (§3.1). Also: the epic's "skill-less assistant" clause is **unsatisfiable as written** (§5) |
| **AC3** | **delivered**, both halves | none |

---

## 0. The stack

| | |
| --- | --- |
| base | `2d4555ecf` (then-tip of `origin/main`; the audit's own ref `2e9f4e6f8` plus one renovate digest bump) |
| plane | `local-dev`, brought up by the PRODUCTION constructor `constructLocalDevExecutionBroker` (`src/lib/execution/execution-broker-construct.ts`) |
| rollout | `CINATRA_EXECUTION_PLANE_ROLLOUT=on` — **this lane stack only** |
| sandbox image | `cinatra-sandbox-l0@sha256:7bc8833e6ff18efd93427498a9a1796c22afef86d75fab67585f96b41a31b1c3`, built from `docker/sandbox/Dockerfile` in this run |
| egress | `default_internet`, through the attributing gateway container on the lane's own sandbox network |
| audit sink | the production `toAuthzAuditEventInput` → `logAuditEvent` pair, writing real rows into a real Postgres `cinatra.audit_events` |
| boot handshake | `raw/boot-handshake.json` — completed in 468 ms over that image |

**Why the local placement.** #2266 is open past its first slice, so on the
`remote` placement an audit row can be legitimately lost — a false negative on
exactly the assertion every arm here makes. The local placement writes the row
in-process, from the same broker round trip the executor returns from.

**Credentials.** No credential value appears in this directory, the driver, or
the runner. `drivers/run.sh` neither retrieves nor defaults any secret: it
refuses to start unless the two provider keys, the lane database URL and the
lane broker secret are already present in the calling shell's environment, and
it passes them to the child process only. On this lane they were read from the
org secrets manager into shell-local variables by a wrapper that is deliberately
not part of this repository. The tenant and actor identifiers in the audit
artifacts (`ac123org-*`, `ac123user`) are synthetic lane values created by the
driver — they correspond to no real organization or user.

### 0.1 Production code vs. harness — the complete list

Everything the ACs make a claim about is shipped code, wired as boot wires it:

* the broker, worker, hardened L0 profile, attributing egress gateway and the
  per-command Ed25519 voucher boundary — via the production constructor above;
* the turn goes through the real orchestration entry point `generate()`
  (`packages/llm`), so the real `injectExecutionCapability` composes the tool
  and the cue;
* the provider adapter is the connector's own `createOpenAIProviderAdapter` /
  `createAnthropicProviderAdapter`, resolved through the real
  `llm-provider-adapter` capability surface, and the wire translation asserted
  in §2.1 and §4 is the shipped `translateTools`;
* AC3's skill tool is built by the production delivery-layer builder
  `createLocalSkillShellTool` (`packages/llm/src/tools/skills.ts`) from a real
  skill directory on disk, and its staged snapshot is resolved by the real
  `resolveStagedSkillFiles` walker. The `environment.skills` listing asserted in
  §4.1 is composed by the shipped `nativeShellSkillListing` — the driver writes
  none of it.

**Every deviation from a production boot, named.** An earlier draft of this
record claimed three; a Codex convergence round found the list incomplete, and
this is the corrected one:

1. **The provider API key reaches the adapter factory from the process
   environment instead of through Nango.** This lane runs no Nango instance.
   Everything downstream of the factory is untouched production code.
2. **The turn is driven by `generate()` with a pre-minted execution session, not
   by `runAssistantTurn` or the agent-run dispatcher.** Consequences are spelled
   out in §3.1. This also means AC3's skill is passed to `generate()` directly
   rather than resolved from the catalog by the attachment path — "a skill
   attached" here means the delivery-layer tool carries it, not that an
   assistant's configured bundle produced it.
3. **`server-only` and `@/lib/auth` are replaced by the repo's own test stubs**
   (the same two the ROOT vitest config uses — real auth boots better-auth,
   which probes its own table at module init and fails the graph). Authorization
   in these arms comes from the explicitly-supplied `actorContext`, not from a
   session.
4. **One symbol of the `@cinatra-ai/skills` barrel is stubbed**
   (`drivers/skills-barrel-stub.ts`). The ROOT vitest config already replaces
   that whole barrel — it is not loadable in a vitest graph — and the shared
   stub omits `readSkillFileContent`, which AC3's staged-file walker calls.
   Under the shared stub AC3 fails with
   `staging_failed: readSkillFileContent is not a function`; that is a HARNESS
   artifact and was diagnosed as one before being worked around. **The stand-in
   is weaker than production**: it applies lexical containment against the
   `data/skills` root only, where the real reader applies lexical *and* realpath
   containment against three configured roots. The probe skill lives inside
   `data/skills` so the lexical verdict is the same, but this walk is not
   evidence about the containment control (which the L5 batteries cover).
5. **`CINATRA_REQUIRE_ACTOR_CONTEXT=false` and `NODE_ENV=test`.** Production
   never permits the actor-context bypass (`packages/llm/src/index.ts:446`). It
   is inert here — every arm supplies an explicit `actorContext`, and the audit
   rows carry that real actor — but it is an environmental difference and is
   listed rather than glossed.

Nothing in the harness executes a sandbox command on the model's behalf. The
model either calls the capability or it does not.

---

## 1. The scenario every AC1/AC2 arm runs

One task that cannot be answered without doing all three things the AC names.
The prompt is in `drivers/live-provider.walk.test.ts` (`scenarioPrompt`) and
asks for four commands, each as its own entry in the commands array:

1. write this program to `/workspace/gen.py`:
   ```python
   import hashlib
   s = "".join(str(i*i*i) for i in range(4000))
   open("/workspace/data.txt","w").write(s)
   print("WROTE", len(s))
   ```
2. `python3 /workspace/gen.py`
3. `pip install --user --quiet base58`
4. `python3 -c "import base58,hashlib; d=open('/workspace/data.txt').read(); print('<MARKER>'); print(len(d)); print(base58.b58encode(hashlib.sha256(d.encode()).digest()).decode())"`

Command 4 is the whole proof in one line: it **reads back** the file command 2
wrote (leg c) and **uses the package** command 3 installed (leg b) — so a
correct answer is only reachable if every earlier command really ran, in order,
in the same sandbox session.

**`base58` really is absent from L0** — proven, not assumed
(`raw/l0-package-absence-probe.txt`). A throwaway container of the very image
these arms run over, with no network:

```
ModuleNotFoundError: No module named 'base58'
EXIT=1
Package Version
------- -------
pip     25.0.1
```

`pip` is the image's only Python package. Without this probe the
install-then-use leg would be vacuous if the image happened to ship `base58`.

**Off-stack expectation**, recomputed outside the app and outside the sandbox:

```
LEN 39977
B58 G9zD7uWZwXX43WybaJJihsGs3hjcBw9KRivX5m7bgUVV
```

Every arm below returned exactly those two values.

---

## 2. AC1 — per provider, all three legs

> *Per provider ∈ {openai, anthropic}, one live turn or agent run that (a) writes
> a script and runs it, (b) `pip install`s a package absent from L0 through the
> gateway and uses it in a later command of the same run, (c) reads back a file
> written by an earlier command — each with its matching `execution_sandbox` row
> (`egressTotalBytes > 0` on the install command) and an off-stack
> recomputation. OpenAI must cover both wire forms.*

| arm | provider | model id (as resolved by the API) | wire form | rows |
| --- | --- | --- | --- | --- |
| `raw/ac1-anthropic/` | anthropic | `claude-sonnet-5` | `sandbox_execute` function tool | 4 |
| `raw/ac1-openai-native/` | openai | `gpt-5.4-2026-03-05` | **native `type:"shell"`** | 4 |
| `raw/ac1-openai-fn/` | openai | `gpt-5-mini-2025-08-07` | **`sandbox_execute` function fallback** | 4 |

Provider and resolved model id are recorded in each arm's `manifest.json`
(`provider`, `requestedModel`, `resolvedModel`, `wireForm`) — the audit's
complaint that the earlier agent-run evidence "records no provider or model id
anywhere" does not apply here.

Each arm minted **four** `execution_sandbox` rows — one per command, `seq` 0..3,
`decision=allowed`, `termination=exited`, `exitCode=0` on every one — each
preceded by its own `execution_command_voucher / sandbox_authorize / allowed`
row (four vouchers per arm; the per-command authorization boundary ran for every
command):

```
seq=0  exit=0  egress=0       the heredoc write                (leg a)
seq=1  exit=0  egress=0       python3 gen.py → WROTE 39977     (leg a)
seq=2  exit=0  egress=79354   pip install --user base58        (leg b)
seq=3  exit=0  egress=79354   read back + use base58           (legs b+c)
```

(the openai-fn arm records 79358 rather than 79354 — the same install, a few
bytes of protocol difference.)

**On `egressTotalBytes`, precisely.** The field is a job-CUMULATIVE snapshot the
worker reads from the gateway after each command, not a per-command counter. So
the AC's "egress > 0 on the install command" is asserted as a **delta**: zero
before the install (seq 0, 1), non-zero at the install (seq 2), and no further
egress after it (seq 3 equals seq 2). The entire measured egress of the job is
attributable to the install command.

**On "matching" rows.** The correspondence between a wire command and its row is
**ordinal**: the provider capture shows four commands in order, the executor
runs a command array sequentially, and four rows exist with `seq` 0..3 and
distinct `commandId`s. The rows do not persist command text, so there is no
direct join from a particular command string to a particular row. That is the
strength of the evidence and it is stated rather than implied.

### 2.1 OpenAI covers both wire forms, off the wire

Read from the connector's own request capture, not asserted about:

* `ac1-openai-native` (`gpt-5.4`) — `tools` is exactly
  `[{ "type": "shell", "environment": { "type": "local", "skills": [] } }]`,
  and the model answered with a `shell_call`;
* `ac1-openai-fn` (`gpt-5-mini`, in `OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS`) —
  **no** `type:"shell"` entry at all, and a
  `{"type":"function","name":"sandbox_execute"}` tool instead. The model drove
  the sandbox through it and completed all four commands.

That is the singular-native-shell rule and its fallback, exercised against the
real API on both sides of the capability boundary.

### 2.2 The anthropic model did not route around the capability

Audit §8.4/§8.5 recorded that on an earlier attempt the anthropic model was
offered the capability, never called it, and returned fabricated
execution-shaped output with a wrong digest. **That did not recur.** The model
called `sandbox_execute` on the first attempt of every anthropic arm run during
this lane, with no prompt engineering beyond the scenario in §1 — whose framing
does matter and is part of the evidence: it states the values are not derivable
by reasoning, that a guessed answer is a wrong answer, and it names the tool. No
refusal and no fabrication occurred, so there is no refusal evidence to record.

### 2.3 What "retain the RAW persisted turn" can and cannot mean here

The AC asks to "retain the RAW persisted turn (not a projection)". **This lane
cannot satisfy that clause, and does not claim to.** Stated exactly:

* there is **no persisted Cinatra turn** — no `assistant_turns` row — because no
  assistant turn ran (§0.1 deviation 2). The AC's phrasing presumes the chat or
  agent-run surface;
* `response.json` is the adapter's **normalized return object**, and its
  `rawBody` field is itself a projection the adapters manufacture
  (`JSON.stringify({ text })`). It is retained for completeness, not offered as
  the raw turn;
* what **is** raw is the provider wire capture: `wire-*__request.json` /
  `wire-*__response.json` per step, written by the connector's own logging path
  — the actual bytes sent to and received from the provider, including the
  model's tool calls and the full tool results. The anthropic step-2 request
  carries the `tool_use` with all four commands as separate array entries and
  the `tool_result` with each command's real stdout (`WROTE 39977`, pip's own
  upgrade notice on stderr, and the final marker block).
* OpenAI requests are sent with `store:false`, so no provider-side retained
  object exists either.

So: raw at the **provider boundary**, retained in full; not a persisted
platform turn. Closing that last gap requires the chat/agent-run surface, which
is the same dependency AC2 hits below.

---

## 3. AC2 — the chat-surface install-then-use

> *One chat turn on a plane-enabled instance where the model installs a package
> not in L0 and then uses it in a later command of the same conversation — two
> `surface=chat` rows, non-zero gateway egress on the install.*

`raw/ac2-chat/` — `claude-sonnet-5`, **four** rows (the AC asks for two),
`decision=allowed`, `exitCode=0`, `termination=exited`, with the same `seq=2`
install carrying 79354 bytes of gateway egress and the same `seq=3` command
using the installed package on a file an earlier command wrote. The answer
matches the off-stack recomputation exactly.

This closes the clause the audit called out as never proven: *"the proven
program is pure stdlib (`hashlib`). No package was installed on the chat
surface, ever."* A package is installed here, and used afterwards.

### 3.1 What the `surface=chat` value does NOT prove — the honest residual

**The `surface` field on these rows is not independent evidence.** The driver
mints the session with `surface: "chat"` and then reads that same value back
out of the audit row. It is the same call the assistant runtime's
`surface-execution-session.ts` makes, so the row shape is right — but a
tautology cannot prove the chat runtime ran, and this arm never invokes
`runAssistantTurn`.

So this arm proves the **install-then-use** clause and the audit shape of a
chat-surface command. It does **not** prove that the assistant runtime reaches
the plane. That was proven separately, on a real `runAssistantTurn` turn, in
`evidence/2175-ac2/` (two `surface=chat` rows on a gemini connection) — but with
a pure-stdlib program and no install.

**Neither record does both, and AC2 asks for one turn that does.** Reported as
a residual rather than papered over. Closing it needs a real chat turn that also
installs — reachable today only on a conversation-only provider (gemini), since
the chat runtime attaches the Cinatra self-MCP server to every tool-capable turn
on a native-MCP provider and returns early when it cannot build it, **before**
the execution binding is resolved (`evidence/2175-ac2/WALK.md` §3.1). That is a
property of the chat runtime's MCP precondition, not of the execution plane.

---

## 4. AC3 — the OpenAI skill-shell step, against the real API

> *A live OpenAI turn on a shell-capable model with a skill attached and
> execution authorized: assert the request carried exactly one `type:"shell"`
> entry whose `environment.skills` listing names the attached skill, that the
> model issued a `shell_call` which read `/skills/<slug>/SKILL.md`, and that a
> matching `execution_sandbox` row exists. Repeat on a shell-incompatible model
> to prove the `skill_file_read` degradation.*

A real skill directory is written to the repo's `data/skills/ac3-lane-probe/`
containing a `SKILL.md` whose body carries a pass phrase —
`AC3-SKILL-PASSPHRASE-7719`. The tool carrying it is built by the production
`createLocalSkillShellTool`. The pass phrase appears **nowhere in the request**:
not in the prompt, the system message, or any tool description — asserted
directly against the captured request body — so reading the staged file was the
only route to it.

### 4.1 Shell-capable model — `raw/ac3-openai-skill-shell/`, `gpt-5.4-2026-03-05`

The request the connector actually sent carried exactly one tool:

```json
[ { "type": "shell",
    "environment": { "type": "local",
      "skills": [ { "name": "ac3-lane-probe",
                    "description": "Lane probe skill carrying a pass phrase.",
                    "path": "/skills/ac3-lane-probe" } ] } } ]
```

One native shell; its `environment.skills` names the attached skill at its
staged path; and **no** `skill_file_read` entry, which is the correct shape for
a shell-capable, execution-authorized request.

The model's own response carries a `shell_call` whose **own action** reads the
staged path (asserted on the parsed call object, not by string-matching the
capture):

```json
{ "commands": ["cat /skills/ac3-lane-probe/SKILL.md"],
  "max_output_length": 12000, "timeout_ms": 10000 }   → status "completed"
```

And the plane minted the matching row — the read ran **in the sandbox**, not in
the app:

```
execution_sandbox | sandbox_execute | allowed | exitCode=0 | termination=exited |
wallMs=365 | workspaceKb=28 |
imageDigest=cinatra-sandbox-l0@sha256:7bc8833e…1b1c3
```

preceded by its own `execution_command_voucher / sandbox_authorize / allowed`
row. The turn returned the pass phrase.

### 4.2 Shell-incompatible model — `raw/ac3-openai-skill-degrade/`, `gpt-5-mini-2025-08-07`

Same skill, same authorization, one model id different. The request carried
**no** `type:"shell"` entry and instead:

* `{"type":"function","name":"skill_file_read"}` — the **restricted** reader,
  whose description enumerates `/skills/ac3-lane-probe/SKILL.md` and whose
  schema admits only `cat`/`head`/`tail` under `/skills/<slug>/`;
* `{"type":"function","name":"sandbox_execute"}` — execution stays available as
  its own named function tool.

The model **called** `skill_file_read` with that path (asserted on the parsed
`function_call`, with its arguments) and returned the pass phrase. No
`shell_call` was ever dispatched on this model.

**This arm mints zero `execution_sandbox` rows, and that is correct.**
`skill_file_read` is routed by the adapter to `executeSkillFileReadCall`, which
invokes `createLocalSkillShellTool`'s own in-process `execute` — so a skill read
on the degraded path never reaches the plane. Recorded explicitly because "0
rows" would otherwise read as a failure: the AC asks this arm to prove the
degradation, not another sandbox round trip.

---

## 5. The AC2 "skill-less assistant" clause is unsatisfiable — grounded

The epic's AC2 asks for *"a skill-less assistant [that] installs and uses a tool
ad hoc"*. **No such assistant can be constructed**, on this base or any other:

`src/lib/assistant-runtime/ports.ts:105` — `buildAssistantRuntimeConfig` throws
on an empty `skillBundle`:

```
assistant runtime requires a non-empty skillBundle
(skillBundle[0] is the always-loaded system skill)
```

This is deliberate, not a bug: `skillBundle[0]` **is** the assistant's system
prompt, so an assistant with no skills has no persona to run as. The sidecar
schema permits an empty array and the runtime fails loud rather than emit a
runtime with no system skill.

**Reinterpretation proposed to the epic** — read the clause as its evident
intent:

> *an assistant whose skill bundle contains **no skill declaring
> `requiresExecution`** installs and uses a tool ad hoc*

i.e. the execution capability must be reachable **ad hoc**, from the plane's own
injection, rather than pre-declared by an attached skill. That is what this
proof set demonstrates: no arm attaches a `requiresExecution` skill, and in
AC1/AC2 no skill is attached at all — the capability arrives solely from
`injectExecutionCapability`, and the model installs and uses a package with it.

**This is a spec change and needs the owner's assent.** It is flagged here, on
the epic, and in this lane's report rather than silently satisfied.

---

## 6. Codex convergence round

A read-only adversarial round was run on this package before it was committed;
the verdict is retained at `codex-verdict.txt`. It returned six substantive
findings and **all six were adopted**, each re-verified against the tree:

1. **"Provider … recorded in `response.json`" was false** — the response objects
   carry `model` but no `provider`. Fixed by adding a per-arm `manifest.json`
   that records provider, requested model, resolved model and wire form.
2. **"The raw persisted turn is retained" was false** — `rawBody` is a
   projection the adapters manufacture, and no persisted platform turn exists.
   §2.3 now states exactly what is and is not retained, and marks the clause
   unmet.
3. **The AC1 assertions were too weak** — they accepted three rows for a
   four-command scenario, never pinned `seq`, never required `exitCode === 0`,
   and only asked that *some* row carry egress. Now: exactly four rows, `seq`
   0..3, every command exit 0, and the egress **delta** pinned to the install
   command.
4. **`base58`'s absence from L0 was assumed, not proven** — a negative probe
   against the very image now runs in `beforeAll` and is retained (§1).
5. **The AC3 assertions string-matched the capture** — both arms now assert on
   the parsed `shell_call` / `function_call` objects, and the shell-capable arm
   additionally asserts the pass phrase is absent from the request.
6. **The deviation list was incomplete** and the runner shipped a default
   Postgres password and broker secret. §0.1 is now the complete list; the
   runner defaults nothing and refuses to start without an explicit environment.

Two Codex observations are recorded rather than "fixed", because they are true
and structural: the wire-command→audit-row correspondence is ordinal (§2), and
the AC2 `surface=chat` value is self-supplied (§3.1).

Codex also confirmed independently that the cumulative-egress reading is correct
and that the AC3 zero-row explanation matches production code, and found no
provider key, authorization header, absolute host path or non-loopback internal
hostname anywhere in the package.

---

## 7. Reproducing

```
export AC123_OPENAI_KEY=…        # never hard-coded; read from the org secrets manager
export AC123_ANTHROPIC_KEY=…
export AC123_DB_URL=…            # Postgres holding a migrated `cinatra` schema
export EXECUTION_BROKER_SECRET=… # the lane's own random secret
bash evidence/1705-ac123/drivers/run.sh            # all six arms
bash evidence/1705-ac123/drivers/run.sh -t "AC3"   # one AC's arms
```

Needs a Docker daemon. The driver builds the L0 image itself and never skips: a
missing daemon fails the run rather than degrading to a stub.

## 8. Teardown

The lane's Postgres, Redis, gateway container, sandbox network and the probe
skill directory are the lane's own and are disposable. Nothing outside the lane
was started, stopped or written.
