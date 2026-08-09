# cinatra#2474 PR3 — live proof: the unified "Add dashboard" popup

**49 PASS · 0 FAIL · 0 console errors · 0 page errors.**

Real Chromium against a **real running dev server** on this branch, with **real
authenticated sessions** for two identities — a scope **manager** and a plain
**member** — driving the actual surface. Every assertion is a live DOM /
computed-style / **geometry probe**; the PNGs are context, not the evidence. The
machine-readable record with each assertion's raw observation is
[`probe-results.json`](probe-results.json), and the whole battery is re-runnable
from [`battery.mjs`](battery.mjs).

**Design-spec pin:** `specs/app-artifacts.html` **§IX** @
`design@60cf789ec9b6d6455148a086cacc6ae43f447cef` — the current tip of that
file, the same revision PR1 (#2547) and PR2 (#2590) pinned.

## What it covers

| Group | Asserts |
|---|---|
| **A** — the manager surface on org / team / project | one and only one Add affordance per tab and it is the **toolbar's** (the collection panel carries none); the §IX.2 `scope-dashboards-write-access` annotation + `open-add-picker` action ride it; the popup is titled **"Add a dashboard to \<entity-named scope\>"** (§IX.1); it offers **Create + Reference-existing** and **no catalog placeholder**; the §IX.1 pool loads through the bound server action with **exactly one** server-decided offer per candidate; the recourse vocabulary is **scope-exact** (team/organization promotion request; a project's null recourse reads *Not addable*); a dashboard already present in the scope is **withheld** from its own pool; §X — the popup is bounded on both axes and scrolls inside itself |
| **B** — the Create hand-off | choosing *Create…* closes the popup and opens the preserved `EntityDashboardNameDialog` (**one** dialog mounted, not a nested pair), **focus lands in its field**, and the create really lands |
| **C** — adding a reference listing, end to end | a real Add writes the listing: the popup closes, the collection panel below gains the row **with Remove**, and the added dashboard **leaves the candidate pool** (no double-add) |
| **D** — §IX.2 on a real member session | no *Add dashboard* control, no write-access annotation and no `open-add-picker` action anywhere; **zero disabled controls** in the tab's toolbar or panel (suppression, not disabling); the member keeps the per-user create; read stays universal — every row, every Open, no Remove |
| **E / F** — the unchanged paths | with no scope source the toolbar keeps its **direct** name prompt (no one-option popup); **personal** is untouched — no Add, no annotation, same prompt |
| **G** — theme + breakpoint axes | the app's own **dark** theme really applies (the class lands, the painted surface changes, and the text/background contrast is **measured** — 16.94:1 — after resolving `lab()` into sRGB); at **390px** the popup shrinks to the viewport with **zero** horizontal page overflow, and the Add affordance is proven reachable by a **real click that really opens the popup** |
| **H / Z** | the retired standalone picker surface is gone — the §IX.1 picker exists only inside the one popup; no console errors, no page errors, and **no surface was probed before it settled** |

### Assertions that were deliberately hardened

A second Codex round called out places where a probe was weaker than its own
claim. Each is now measured rather than assumed:

- **per-row exclusivity**, not an aggregate sum — a row with two offers and a
  row with none can satisfy a sum; every `li` is checked individually;
- **the section column is anchored on a stable slot** (`data-slot=
  "add-dashboard-sections"`) and its children are asserted by name, so "no
  catalog placeholder" cannot pass by matching some other two-child element;
- **the popup's overflow really scrolls** — the viewport is squeezed to force
  the overflow, then `scrollHeight > clientHeight` and a real `scrollTop`
  movement are probed (not merely `overflow-y: auto`);
- **the member's read-universality assert runs against a NON-EMPTY collection**
  (the fixtures seed a project listing), so it cannot pass vacuously;
- **an unsettled surface is recorded**, never swallowed — an absence assertion
  on a half-rendered page would otherwise pass for the wrong reason.

## How it ran (so the proof is reproducible and its limits are explicit)

- This branch, on an isolated lane: extensions materialised at their committed
  lock SHAs, `pnpm install --frozen-lockfile`, migrations against a **dedicated
  lane database** on the local verify Postgres, `pnpm dev` on a **lane port**
  with its own queue name. `/api/health` returned `200` `readiness:ready` before
  any capture.
- Fixtures: two identities created through the app's **own auth endpoints**
  (real sign-up, real sessions, real active-organization switch through the
  app's own endpoint — the org landing's tenant fence reads exactly that axis),
  plus direct SQL for org / team / project membership and two dashboard rows —
  one org-visible (the add-able candidate) and one private (the promotion
  recourse).
- Playwright drove a real Chromium with `domcontentloaded` + selector waits
  (never `networkidle`), one browser. Assertions are live probes, not snapshots.
- The server ran with the repo's **own** e2e wizard affordance
  `CINATRA_E2E_SETUP_BYPASS=true` — the flag every suite in `tests/e2e/config/*`
  sets — because a freshly provisioned instance otherwise redirects
  authenticated routes to the setup wizard. It clears **only** the wizard gate:
  authentication and authorization stayed fully in force, and the member-role
  surfaces were reached on that member's own real session.
- No provider credential, token or secret exists on that host and none was used;
  the fixture identities are local throwaways with generated passwords that
  never left the lane scratchpad.

## What this proof deliberately does NOT cover

Concept **B** (add from the installed catalog). Its server-side read is
**PR4** and its instantiate action is **PR5**, so PR3 ships the popup's catalog
**slot** and nothing renders in it — asserted positively above (`A5`: exactly
two sections, no placeholder). There is nothing live to prove here yet, and
shipping a "catalog coming soon" section would advertise a capability the
product does not have.
