// ---------------------------------------------------------------------------
// The single audience the S5 broker/user (cit_/cwu_) tokens bind to.
//
// S5 (cinatra#1221) moves the WordPress/Drupal public-site widget off the
// bespoke `/api/agents/{slug}/stream` relay onto the unified AG-UI assistant
// runtime at `POST /api/assistants/chat`. The broker `cit_` and per-user `cwu_`
// tokens are MINTED bound to THIS audience (the mint sites are unchanged — only
// the bound value moves here), and the `/api/assistants/chat` broker-auth branch
// CONSUMES them with this exact `routePath`.
//
// CUTOVER SEMANTICS (designed, owner-reviewed): once the audience moves here, a
// token presented at the LEGACY `/api/agents/{slug}/stream` route fails
// `aud_mismatch` there (that route still consumes with its own stream routePath).
// The flag-day is contained to the widget surface; the CMS bridges move onto the
// broker-auth turn in the Lane B / CMS stage. Both the mint aud and the new
// route's consume routePath reference THIS constant so they can never drift.
// ---------------------------------------------------------------------------

/** The unified assistant chat route — the S5 broker/user token audience. */
export const WIDGET_BROKER_ROUTE_PATH = "/api/assistants/chat";
