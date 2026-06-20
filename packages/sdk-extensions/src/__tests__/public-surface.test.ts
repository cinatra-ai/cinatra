import { describe, it, expect } from "vitest";
import * as publicRoot from "../index";
import * as internal from "../internal";

// ---------------------------------------------------------------------------
// PUBLIC-SURFACE FENCE (SDK-P2 — the types-first SDK publish boundary).
//
// The host service-bus ADDRESSING CONSTANTS — the `@cinatra-ai/host:*`
// capability ids the host registers per-concern service impls under — are
// host-internal. They must NOT be reachable from the public author root
// (`@cinatra-ai/sdk-extensions`); they live behind the host-only
// `@cinatra-ai/sdk-extensions/internal` subpath. An extension types the
// capability `impl` it resolves from `ctx.capabilities` against the public
// `Host*Service` / provider TYPES and INLINES the capability-id literal.
//
// This is the RUNTIME REACHABILITY proof: it imports the public root as a value
// module and asserts no capability-id constant is enumerable on it. A value
// constant re-added to src/index.ts turns this red. The companion static gate
// (scripts/audit/sdk-public-surface-ban.mjs) catches the same leak at the
// source-text level before tests even run.
// ---------------------------------------------------------------------------

// The exact host-internal capability-id constants that were fenced out of the
// public root. This is the explicit denylist — the fence's contract.
const FENCED_CAPABILITY_CONSTANTS = [
  "HOST_CONNECTOR_SERVICE_CAPABILITIES",
  "NANGO_CONNECTION_SAVED_CAPABILITY",
  "NANGO_CONNECTION_MATERIALIZER_CAPABILITY",
  "LLM_TOOLBOX_CAPABILITY",
  "SOCIAL_POST_CAPABILITY",
  "CRM_PROVIDER_CAPABILITY",
  "PM_PROVIDER_CAPABILITY",
  "EMAIL_SEND_CAPABILITY",
  "OBJECT_TYPE_REGISTRAR_CAPABILITY",
  "CRM_SYNC_BOOTSTRAP_CAPABILITY",
  "CRM_POINTER_WRITER_CAPABILITY",
  "DEV_TUNNEL_STATUS_CAPABILITY",
  "BLOG_SYSTEM_CAPABILITY",
  "SOCIAL_MEDIA_SYSTEM_CAPABILITY",
  "EMAIL_SYSTEM_CAPABILITY",
  "LLM_PROVIDER_SURFACE_CAPABILITY",
  "CHAT_USER_CONTEXT_CAPABILITY_ID",
  "CRM_LIST_READER_CAPABILITY_ID",
  "EMAIL_SENDER_IDENTITIES_CAPABILITY_ID",
  "APPOINTMENT_SCHEDULES_CAPABILITY_ID",
  "NANGO_SYSTEM_CAPABILITY",
] as const;

// A capability-id constant follows one of these naming shapes. Catches any
// FUTURE host capability-id accidentally re-exported through the public root,
// not just the 20 known ones above.
const CAPABILITY_KEY_PATTERN =
  /(?:_CAPABILITY|_CAPABILITY_ID)$|^HOST_CONNECTOR_SERVICE_CAPABILITIES$/;

// Walk the public-root value namespace one level deep: a top-level key, OR a key
// reachable under a namespace object (what `export * as HostBus from "…"` would
// produce). Catches the star-namespace evasion at runtime — a flat top-level scan
// (Object.keys) cannot see `publicRoot.HostBus.NANGO_SYSTEM_CAPABILITY`.
function reachableValueKeys(mod: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(mod)) {
    keys.push(k);
    // A re-exported namespace surfaces as a non-null object (an ES module
    // namespace or a plain object). Enumerate its keys too. (Functions/classes
    // are also objects but their own keys aren't a re-export surface; we still
    // scan them — harmless, and fail-closed.)
    if (v && (typeof v === "object" || typeof v === "function")) {
      for (const nestedKey of Object.keys(v as Record<string, unknown>)) {
        keys.push(nestedKey);
      }
    }
  }
  return keys;
}

describe("@cinatra-ai/sdk-extensions public surface fence", () => {
  it("does not expose any of the 20 fenced host capability-id constants on the root (incl. under any namespace)", () => {
    const keys = new Set(reachableValueKeys(publicRoot as Record<string, unknown>));
    const leaked = FENCED_CAPABILITY_CONSTANTS.filter((name) => keys.has(name));
    expect(leaked).toEqual([]);
  });

  it("exposes NO capability-id-shaped value key on the public root, flat or namespaced (fail-closed for future ids)", () => {
    const leaked = reachableValueKeys(publicRoot as Record<string, unknown>).filter((k) =>
      CAPABILITY_KEY_PATTERN.test(k),
    );
    expect(leaked).toEqual([]);
  });

  it("re-exports exactly those fenced constants through the host-only ./internal subpath", () => {
    const internalKeys = new Set(Object.keys(internal));
    const missing = FENCED_CAPABILITY_CONSTANTS.filter(
      (name) => !internalKeys.has(name),
    );
    expect(missing).toEqual([]);
    // ./internal is the host bus addressing surface ONLY — it must not widen
    // beyond the fenced constants.
    const extra = [...internalKeys].filter(
      (k) => !(FENCED_CAPABILITY_CONSTANTS as readonly string[]).includes(k),
    );
    expect(extra).toEqual([]);
  });

  it("KEEPS the legitimate types-first author value surface on the root (HOST_PORT_NAMES, register helpers)", () => {
    // Sanity: the fence removed ONLY the capability-id constants — the
    // author-facing value exports the types-first surface needs are intact.
    expect(publicRoot.HOST_PORT_NAMES).toBeTruthy();
    expect(typeof publicRoot.defineExtension).toBe("function");
    expect(typeof publicRoot.isSdkAbiRangeSatisfied).toBe("function");
    expect(publicRoot.SDK_EXTENSIONS_ABI_VERSION).toBe("2.2.0");
  });

  it("KEEPS the ABI-evolution policy metadata reachable on the root (HOST_PORT_TIER et al.)", () => {
    // The port-tier table is author-facing POLICY metadata about the
    // frozen surface, NOT a host-bus addressing constant — so it intentionally
    // lives on the public root and does NOT trip the capability-id fence above.
    expect(publicRoot.HOST_PORT_TIER).toBeTruthy();
    expect(publicRoot.HOST_PORT_TIERS).toBeTruthy();
    expect(publicRoot.RESERVED_HOST_PORTS).toBeTruthy();
    // And the fence's pattern does not (and must not) match these names.
    for (const name of ["HOST_PORT_TIER", "HOST_PORT_TIERS", "RESERVED_HOST_PORTS"]) {
      expect(CAPABILITY_KEY_PATTERN.test(name)).toBe(false);
    }
  });
});
