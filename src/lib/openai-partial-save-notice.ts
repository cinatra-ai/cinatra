// The OpenAI PARTIAL-SAVE flash outcome (cinatra#2094 F9) — one code, one static
// message, shared by every host surface that can receive the save's redirect.
//
// WHY THIS EXISTS. `openai-connector`'s `saveConnection` can now complete a save
// that STORED and live-validated the key while the connection-service copy did not
// complete. That is neither an error nor a clean success, so it rides the SUCCESS
// redirect as `?notice=<code>` instead of `?error=<message>`. Two host surfaces
// receive that redirect and must both render it:
//
//   * the setup wizard (`redirectTo=/setup/ai`) — src/app/setup/setup-flash.ts;
//   * the LLM admin modal (`redirectTo=/configuration/llm?modal=openai`) —
//     src/app/configuration/llm/apis-page.tsx.
//
// Without an entry on BOTH, the degraded outcome is visible only in the
// notification centre on the surface that lacks one — i.e. it reads as a clean
// success, which is the exact failure mode F9's reporting exists to prevent.
//
// CODES-ONLY PROTOCOL: the code selects a STATIC message defined here. URL-derived
// text is never rendered, so a crafted `?notice=` cannot put attacker text in a
// toast.

/**
 * Drift-pinned to `openai-connector`'s `OPENAI_PARTIAL_SAVE_NOTICE_CODE`. Core
 * cannot import from an extension, and a drift means the toast silently stops
 * firing — which is what `src/app/setup/__tests__/setup-flash-notice.test.ts`
 * exists to catch.
 */
export const OPENAI_PARTIAL_SAVE_NOTICE_CODE = "openai-connection-service-not-synced";

/**
 * Worded for what is actually KNOWN, matching the connector's own notification:
 * the key WORKS and is stored, and the remote copy is UNCONFIRMED — never
 * asserted absent (the import can commit server-side and only then have its
 * response torn, and the connector's remote cleanup is best-effort and bounded).
 */
export const OPENAI_PARTIAL_SAVE_NOTICE_MESSAGE =
  "The OpenAI key was saved and works, but it was not copied to the connection service and the remote state could not be confirmed. Finish the Connections step (or fix the connection service), then save the key again.";
