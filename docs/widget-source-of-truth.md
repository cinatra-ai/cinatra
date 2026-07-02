# CMS widget — source of truth & sync model (cinatra#411)

Normative contract for **where the WordPress / Drupal assistant widget JS lives,
where it is edited, and how a change reaches an installed site.** Read this
before authoring any widget change — in particular the #410 login UI.

## TL;DR

- **Canonical source = the two VENDORED copies** (one per CMS), NOT the host
  `bundle.js` routes:
  - `cinatra-ai/wordpress-plugin/assets/cinatra-widget.js`
  - `cinatra-ai/drupal-module/js/cinatra-widget.js`
- **Author in the WordPress copy first, then hand-mirror to the Drupal copy.**
- The two host routes
  `cinatra-ai/cinatra/src/app/api/{wordpress,drupal}/bundle.js/route.ts` are
  **DEPRECATED / dead** (pre-Option-A). They are NOT the source of truth, are NOT
  in the sync graph, and are scheduled for removal post-epic. **Never author new
  widget behavior there.**
- A change reaches an **already-installed site only via a CMS PACKAGE RELEASE**
  (WordPress.org plugin release + Drupal.org module release + the site admin
  taking the update). There is **no live push** of widget JS from a Cinatra
  instance — by design.

## Why the vendored copies are canonical (not the routes)

Loading executable JS from a per-customer Cinatra origin into `wp-admin` is the
rejected WordPress.org Guideline #8 pattern that motivated the whole security
epic. **Option A** (ratified in `cinatra-ai/wordpress-plugin#4`, shipped in
releases 0.1.0/0.1.1) is: ship the widget JS **locally inside the plugin/module**; the
Cinatra instance is a **versioned data API only**. `cinatra#220` shipped the
instance-side half (same-origin token-exchange broker + capability/contract
negotiation).

The vendored copies **are** Option A realized. Their headers note they were
originally "Built from" the host route, then manually adapted so that:

- the long-lived `apiKey` is **removed from the browser**;
- a **same-origin token broker** (`CinatraConfig.tokenEndpoint` on WordPress;
  `drupalSettings.cinatra.tokenEndpoint` on Drupal) mints a **short-lived,
  origin/audience/scope-bound** token;
- the stream is Bearer-authenticated with **that short-lived token**, never the
  raw apiKey;
- **capability + contract-version negotiation** against
  `/api/agents/<slug>/capabilities` is a **hard prerequisite** for mount (the
  routes have no equivalent).

Every install runs the LOCAL vendored copy, never the route:

- WordPress: `cinatra.php` enqueues `plugins_url('assets/cinatra-widget.js')`
  with `tokenEndpoint => rest_url('cinatra/v1/token')` and documents in-code that
  the widget JS is shipped inside the plugin and "never remote-loaded from the
  Cinatra instance."
- Drupal: `cinatra.module` attaches the local `cinatra/bundle` library
  (`js/cinatra-widget.js`); `WidgetGateTest` **asserts** the rendered page
  `responseNotContains('/api/drupal/bundle.js')` — contractually never remote.

The Cinatra app does **not** self-embed the route either. **Nothing executes the
routes.** They are the pre-Option-A artifact the epic deliberately moved away
from.

There is **no single shared module** the two vendored copies derive from. They
are vanilla-JS IIFEs with per-CMS broker idioms (`CinatraConfig.tokenEndpoint`
vs `drupalSettings.cinatra.tokenEndpoint`) and per-CMS library/asset plumbing.
They are **parallel canonical sources kept in lockstep by review**, not by a
generator.

## Sync model: manual lockstep WP → Drupal + a per-repo drift gate

There is **no route → vendored generator** and there is **no WP → Drupal
generator** — vendoring is, and stays, **manual**. A widget change is:

1. **Authored in the WordPress copy** (`wordpress-plugin/assets/cinatra-widget.js`).
2. **Hand-mirrored to the Drupal copy** (`drupal-module/js/cinatra-widget.js`).
   The two differ only in (a) the CMS-config accessor (`CinatraConfig` vs
   `drupalSettings.cinatra`) and (b) the capability/library/asset plumbing — the
   security-critical logic is identical.

### The drift / parity gate

Each plugin/module repo ships a **`tools/widget-parity-check.mjs`** CI check
(modeled on cinatra's `vendor:skills --check`) that asserts, on its OWN vendored
copy, the **security-critical invariants** that must never drift:

1. **No long-lived `apiKey` in the browser** — the widget must not read an
   apiKey from its CMS config.
2. **Same-origin token broker is used** — `tokenEndpoint` is read and a
   `getStreamToken()`-style mint exists.
3. **The stream is Bearer-authenticated with the short-lived token**, sourced
   from the broker mint — NOT from any config-derived credential.
4. **The contract-version set is declared** and matches the other CMS's set
   (the shared `{v1, v2}` marker — order may differ because the two negotiation
   loops differ by design; the SET must match).
5. **No reintroduction of `/api/wordpress/bundle.js` or `/api/drupal/bundle.js`**
   anywhere in the widget or in admin/embed/schema strings (this keeps the dead
   route from creeping back into what an install actually reads).
6. **The login-required panel gate is present** once #410 lands (a `panelMode` /
   login-gate marker) — see "For #410" below.

Cross-repo **byte parity is intentionally NOT enforced** (impossible in a
single-repo CI, and the two files legitimately differ in the CMS accessor +
plumbing). Per-repo invariant assertion + the shared contract-version marker is
the cheap, correct scope. The cross-repo lockstep itself is a **review
discipline**, documented here and reinforced by the identical gate running in
both repos.

## Propagation to installed sites = CMS package releases (NOT a live push)

The parity gate only keeps the two **source trees** in lockstep. Reaching an
**already-installed site** requires:

1. a **WordPress.org plugin release** of `cinatra-ai/wordpress-plugin`, and
2. a **Drupal.org module release** of `cinatra-ai/drupal-module`, and
3. the **site admin taking the update** (plugin/module update uptake).

The Cinatra instance never pushes widget JS to a site. Do not design or document
any flow that assumes a live instance-side widget update — there is none, by
design (that is the whole point of Option A).

## For #410 (login UI) — exact edit targets

The vendored copies currently have **no** `panelMode` / login / widget-auth /
`userToken` concept. The #410 login UI is **net-new** and MUST be authored:

1. **first** into `cinatra-ai/wordpress-plugin/assets/cinatra-widget.js` (next to
   the existing `getStreamToken()` broker call and the dual-token stream wiring),
2. **then mirrored** into `cinatra-ai/drupal-module/js/cinatra-widget.js`.

Do **not** author the login UI into either `bundle.js/route.ts` — that is a dead
path; the login UI would never ship to any install. After #410 lands, the parity
gate's "login-required panel gate present" invariant becomes active in both
repos.

## Route disposition (cinatra#411)

- **NOW:** both `src/app/api/{wordpress,drupal}/bundle.js/route.ts` are
  **deprecated in place** — a banner comment + a single static
  (non-secret) GET server-log line. **No behavior or auth change**; the raw
  `Authorization: Bearer <apiKey>` path is left frozen on purpose (touching a
  dead route's auth is needless risk and would mis-signal that it is still a live
  login surface).
- **AFTER the epic** (the vendored copies carry the new login + dual-token flow
  and installs are updated): both route files **and** the
  `/api/wordpress/bundle.js` entry in `src/lib/auth-route-guard.ts` (plus the
  matching public-path test assertion) are **removed in a dedicated cleanup PR
  with sign-off** (wp#4 acceptance: never a silent delete). Removal is deferred
  only to avoid coupling route-deletion into the security epic; it is not
  optional long-term.
