// Admin-approved WIDGET-STREAM METADATA grants for runtime extensions —
// widget-stream runtime trust, slice 1 (the metadata trust axis).
//
// WHAT THIS AUTHORIZES. A runtime-installed connector may DECLARE a
// widget-stream agent (`cinatra.widgetStream`): which agent slug it serves,
// which module/factory builds its widget-chat tool, which relay agent the host
// pre-creates the OBO-carrier run for, which credential/instances stores it
// reads, and which CMS context fields are forwarded. None of that may be
// trusted from the declaration alone: this module records the declaration as a
// grant an admin must EXPLICITLY approve — the sibling of the credential-store
// ownership grant (`extension-capability-ownership-grants.ts`), same mechanism
// shape (per-`(package, agent slug)`, global scope `org_id IS NULL` in the
// pilot, admin `approved_by`, host-persisted, fail-closed, DB partial-unique on
// approved rows), distinct capability discriminator (the AGENT SLUG, not a
// token key).
//
// NO AUTO-APPROVE — EVER. Unlike ports / host DDL / credential-store ownership,
// the metadata grant is NEVER auto-approved, not even for a `trusted-signed`
// first install. Every record lands `pending` and requires an explicit
// platform-admin approval of the displayed canon. There is deliberately NO code
// path in this module that approves a canon no admin saw.
//
// THE CANONICAL BINDING (v:2). The admin approves an exact, versioned canon
// covering EVERY security- or UI-reaching field (nothing is excluded as
// "cosmetic" — `label`/`subjectNoun` reach the widget surface / tool
// description, so they are bound too). `bindingHashV2` is sha256 over a strict
// canonical JSON form: schema-validated, NFC-normalized, deterministically
// key-ordered, built from a duplicate-key-REJECTING parse of the materialized
// manifest. Any parse/validation failure means the connector declares NO
// runtime widget entry (fail closed), never a partial one.
//
// APPROVAL IS A COMPARE-AND-SWAP. Approval carries the EXACT
// `expectedBindingHashV2` the admin was shown; the write succeeds only while
// the row still holds that hash at status `pending` (single-statement CAS). An
// install that rewrites the row between display and approval yields a typed
// conflict, never a blind approval.
//
// STICKY REVOCATION + DURABLE TOMBSTONE. A `revoked` row NEVER transitions back
// to `pending`/`approved` on an install — neither a same-hash reinstall nor a
// changed-canon re-publish. Grant identity `(package, agent slug)` is durable:
// the module exposes no path that deletes an approved/revoked row, so
// recreating install history cannot launder a revocation into a fresh "first
// grant". Reconsidering a revoked grant requires the EXPLICIT admin reopen
// action below, never an install.
//
// CONJUNCTION WITH THE CREDENTIAL-STORE AXIS. Recording is refused unless the
// declaring package IS the currently-approved credential-store owner of the
// canon's `auth.tokenConfigKey` (the sibling grant's `resolveOwnershipOwner`),
// and the canon's `instancesConfigKey` must be the package's OWN instances
// namespace — package X can never mint a widget that borrows package Y's
// credential/instances store. (The same conjunction is re-asserted at every
// point of use by the runtime resolver arm — a later slice.)
//
// ALL READS FAIL CLOSED. `resolveApprovedWidgetStreamMetadataGrant` returns a
// grant ONLY for a unique `approved` row; zero or ambiguous rows (or a lookup
// error at the caller) yield null → the resolver arm 404s.
import "server-only";

import { createHash } from "node:crypto";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** Minimal async query surface (injected → unit-testable without a DB). */
export type WidgetStreamMetadataGrantQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type WidgetStreamMetadataGrantDeps = {
  query: WidgetStreamMetadataGrantQuery;
  /** The host schema the grants live in (default `cinatra`). */
  schema?: string;
};

// ---------------------------------------------------------------------------
// Lazy default DB query path (globalThis-cached pool — never a top-level pool,
// to keep `next build` page-data collection from throwing without a DB URL).
// Mirrors `extension-capability-ownership-grants`.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraWidgetStreamMetadataGrantPool: import("pg").Pool | undefined;
}

let metadataGrantPoolInstance: import("pg").Pool | undefined;
async function getMetadataGrantPool(): Promise<import("pg").Pool> {
  if (metadataGrantPoolInstance) return metadataGrantPoolInstance;
  if (globalThis.__cinatraWidgetStreamMetadataGrantPool) {
    return (metadataGrantPoolInstance = globalThis.__cinatraWidgetStreamMetadataGrantPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-widget-stream-metadata-grants");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extension-widget-stream-metadata-grants] pg pool idle client error:", err.message);
    });
  }
  metadataGrantPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraWidgetStreamMetadataGrantPool = pool;
  }
  return pool;
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getMetadataGrantPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function resolveDeps(deps?: WidgetStreamMetadataGrantDeps): Promise<{
  query: WidgetStreamMetadataGrantQuery;
  schema: string;
}> {
  return {
    query: deps?.query ?? defaultQuery,
    schema: deps?.schema ?? schemaName,
  };
}

function qualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_widget_stream_metadata_grant"`;
}

// ---------------------------------------------------------------------------
// The v:2 canon — schema, bounds, and the dangerous-value constraints
// ---------------------------------------------------------------------------

export type WidgetStreamMetadataContextField = { key: string; maxLength: number };

/**
 * The EXACT tuple an admin approves. Every field can reach a security decision
 * or the widget UI, so every field is bound — a change to ANY of them changes
 * `bindingHashV2` and re-pends the grant. `relayAgentPackage` is `null` (bound
 * as null) for a widget that declares no relay. `auth.requireUserToken` is
 * pinned `true`: a runtime declaration may not opt out of the fail-closed
 * per-user-token check (flat prohibition in the pilot — an absent flag defaults
 * to the enforcing value; an explicit `false` refuses the whole declaration).
 */
export type WidgetStreamMetadataCanonV2 = {
  v: 2;
  agentSlug: string;
  packageName: string;
  /** The `package.json` `exports` key of the widget-chat-tool module (the
   * resolved target is re-checked at load time by the runtime loader slice). */
  moduleExportKey: string;
  factory: string;
  relayAgentPackage: string | null;
  skillCapability: string;
  contextFields: WidgetStreamMetadataContextField[];
  label: string;
  subjectNoun: string;
  auth: {
    tokenConfigKey: string;
    instancesConfigKey: string;
    requiredInstanceFields: string[];
    requireUserToken: true;
  };
};

/** A validated, canonicalized declaration ready to record: the canon, its
 * canonical JSON text (stored for admin display), and its binding hash (the
 * authoritative comparison value). */
export type WidgetStreamMetadataGrantClaim = {
  agentSlug: string;
  packageName: string;
  canon: WidgetStreamMetadataCanonV2;
  canonJson: string;
  bindingHashV2: string;
};

const WIDGET_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FACTORY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CONFIG_KEY_RE = /^[a-z0-9_]+$/;
const CONTEXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const SCOPED_PACKAGE_RE = /^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/;
const MODULE_EXPORT_KEY_RE = /^\.\/[A-Za-z0-9._/-]+$/;
/** A context field must never name credential/secret material — the fields are
 * forwarded CMS PAGE context, and a secret-shaped key is refused outright. */
const SECRETISH_CONTEXT_KEY_RE =
  /password|passwd|secret|credential|token|apikey|api_key|private_key|access_key|bearer|session|cookie/i;

const MAX_SLUG_LENGTH = 64;
const MAX_FACTORY_LENGTH = 128;
const MAX_CONFIG_KEY_LENGTH = 64;
const MAX_PACKAGE_NAME_LENGTH = 214; // npm's own limit
const MAX_MODULE_EXPORT_KEY_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const MAX_SUBJECT_NOUN_LENGTH = 60;
const MAX_CONTEXT_FIELDS = 16;
const MAX_CONTEXT_KEY_LENGTH = 64;
const MAX_CONTEXT_FIELD_BOUND = 2000;
const MAX_REQUIRED_INSTANCE_FIELDS = 32;
const MAX_INSTANCE_FIELD_LENGTH = 64;

/**
 * First-party host/core package names a runtime widget canon may NEVER name as
 * its relay agent (`relayAgentPackage` steers which package the host pre-creates
 * the OBO-carrier agent_run for — pointing it at host infrastructure would be a
 * privilege lever). Record-time defense-in-depth: the AUTHORITATIVE gate is the
 * point-of-use re-assert (the relay target must classify as an active
 * `trusted-signed` EXTENSION — which no host workspace package ever does).
 * Snapshot of the host workspace package names (packages dir) + the app.
 */
const HOST_RESERVED_PACKAGES: ReadonlySet<string> = new Set([
  "cinatra",
  "@cinatra-ai/a2a",
  "@cinatra-ai/agent-ui-protocol",
  "@cinatra-ai/agents",
  "@cinatra-ai/artifacts",
  "@cinatra-ai/chat",
  "@cinatra-ai/cli",
  "@cinatra-ai/connectors",
  "@cinatra-ai/connectors-catalog",
  "@cinatra-ai/dashboards",
  "@cinatra-ai/design",
  "@cinatra-ai/errors",
  "@cinatra-ai/extension-types",
  "@cinatra-ai/extensions",
  "@cinatra-ai/google-oauth-connection",
  "@cinatra-ai/llm",
  "@cinatra-ai/marketplace-application-reconcile",
  "@cinatra-ai/marketplace-mcp-client",
  "@cinatra-ai/marketplace-sync",
  "@cinatra-ai/mcp-client",
  "@cinatra-ai/mcp-server",
  "@cinatra-ai/metric-contracts",
  "@cinatra-ai/metric-cost-api",
  "@cinatra-ai/metric-usage-api",
  "@cinatra-ai/migrations",
  "@cinatra-ai/notifications",
  "@cinatra-ai/objects",
  "@cinatra-ai/permissions",
  "@cinatra-ai/pm-schedule-reconcile",
  "@cinatra-ai/projects",
  "@cinatra-ai/registries",
  "@cinatra-ai/sdk-dashboard",
  "@cinatra-ai/sdk-extensions",
  "@cinatra-ai/sdk-ui",
  "@cinatra-ai/skills",
  "@cinatra-ai/streams",
  "@cinatra-ai/trigger",
  "@cinatra-ai/trigger-email-send",
  "@cinatra-ai/webhooks",
  "@cinatra-ai/workflows",
]);

function isNfc(s: string): boolean {
  return s === s.normalize("NFC");
}

/**
 * The package's OWN instances-config namespace, derived from its name (pilot
 * convention, matching every baked connector: `@scope/wordpress-mcp-connector`
 * → `wordpress`). A canon whose `instancesConfigKey` is not this exact value is
 * refused — a widget may never read another package's instances store.
 */
export function ownInstancesNamespace(packageName: string): string | null {
  const m = packageName.match(/^@[^/]+\/(.+)$/);
  if (!m) return null;
  return m[1]!.replace(/-mcp-connector$/, "").replace(/-connector$/, "").replaceAll("-", "_");
}

/** Validate a fully-built canon. Returns human-readable errors ([] = valid).
 * Strings must ALREADY be NFC (the claim builder normalizes; a non-NFC canon
 * is rejected so a hash is only ever computed over the normalized form). */
export function validateWidgetStreamMetadataCanon(canon: WidgetStreamMetadataCanonV2): string[] {
  const errors: string[] = [];
  const bounded = (value: string, max: number, at: string) => {
    if (!isNfc(value)) errors.push(`${at}: must be NFC-normalized`);
    if (value.length === 0 || value.length > max) errors.push(`${at}: length must be 1..${max}`);
  };
  if (canon.v !== 2) errors.push("v: must be 2");
  bounded(canon.agentSlug, MAX_SLUG_LENGTH, "agentSlug");
  if (!WIDGET_SLUG_RE.test(canon.agentSlug)) errors.push("agentSlug: must be a kebab-case slug");
  bounded(canon.packageName, MAX_PACKAGE_NAME_LENGTH, "packageName");
  if (!SCOPED_PACKAGE_RE.test(canon.packageName)) errors.push("packageName: must be a scoped npm package name");
  bounded(canon.moduleExportKey, MAX_MODULE_EXPORT_KEY_LENGTH, "moduleExportKey");
  if (
    !MODULE_EXPORT_KEY_RE.test(canon.moduleExportKey) ||
    canon.moduleExportKey.includes("*") ||
    canon.moduleExportKey.split("/").includes("..")
  ) {
    errors.push("moduleExportKey: must be a plain './'-relative subpath (no patterns, no traversal)");
  }
  bounded(canon.factory, MAX_FACTORY_LENGTH, "factory");
  if (!FACTORY_RE.test(canon.factory)) errors.push("factory: must be a JS identifier");
  if (canon.relayAgentPackage !== null) {
    bounded(canon.relayAgentPackage, MAX_PACKAGE_NAME_LENGTH, "relayAgentPackage");
    if (!SCOPED_PACKAGE_RE.test(canon.relayAgentPackage)) {
      errors.push("relayAgentPackage: must be a scoped npm package name");
    } else {
      const ownScope = canon.packageName.split("/")[0];
      const relayScope = canon.relayAgentPackage.split("/")[0];
      if (relayScope !== ownScope) {
        errors.push("relayAgentPackage: must be in the declaring package's own scope (no cross-vendor relay delegation)");
      }
      if (HOST_RESERVED_PACKAGES.has(canon.relayAgentPackage)) {
        errors.push("relayAgentPackage: host/core packages may not be named as a relay target");
      }
      if (canon.relayAgentPackage === canon.packageName) {
        errors.push("relayAgentPackage: must name the connector's companion agent package, not the connector itself");
      }
    }
  }
  bounded(canon.skillCapability, MAX_LABEL_LENGTH, "skillCapability");
  if (canon.skillCapability !== `widget-chat.${canon.agentSlug}`) {
    errors.push("skillCapability: must be the package's own `widget-chat.<agentSlug>` namespace");
  }
  if (!Array.isArray(canon.contextFields) || canon.contextFields.length === 0) {
    errors.push("contextFields: must be a non-empty array");
  } else if (canon.contextFields.length > MAX_CONTEXT_FIELDS) {
    errors.push(`contextFields: at most ${MAX_CONTEXT_FIELDS} fields`);
  } else {
    const seen = new Set<string>();
    canon.contextFields.forEach((f, i) => {
      bounded(f.key, MAX_CONTEXT_KEY_LENGTH, `contextFields[${i}].key`);
      if (!CONTEXT_KEY_RE.test(f.key)) errors.push(`contextFields[${i}].key: must be an identifier`);
      if (SECRETISH_CONTEXT_KEY_RE.test(f.key)) {
        errors.push(`contextFields[${i}].key: must not name credential/secret material`);
      }
      if (seen.has(f.key)) errors.push(`contextFields[${i}].key: duplicate "${f.key}"`);
      seen.add(f.key);
      if (!Number.isInteger(f.maxLength) || f.maxLength <= 0 || f.maxLength > MAX_CONTEXT_FIELD_BOUND) {
        errors.push(`contextFields[${i}].maxLength: must be an integer in 1..${MAX_CONTEXT_FIELD_BOUND}`);
      }
      if (i > 0 && canon.contextFields[i - 1]!.key >= f.key) {
        errors.push("contextFields: must be sorted by key (canonical order)");
      }
    });
  }
  bounded(canon.label, MAX_LABEL_LENGTH, "label");
  bounded(canon.subjectNoun, MAX_SUBJECT_NOUN_LENGTH, "subjectNoun");
  for (const k of ["tokenConfigKey", "instancesConfigKey"] as const) {
    bounded(canon.auth[k], MAX_CONFIG_KEY_LENGTH, `auth.${k}`);
    if (!CONFIG_KEY_RE.test(canon.auth[k])) errors.push(`auth.${k}: must be a snake_case connector-config key`);
  }
  const ownNamespace = ownInstancesNamespace(canon.packageName);
  if (ownNamespace === null || canon.auth.instancesConfigKey !== ownNamespace) {
    errors.push(
      "auth.instancesConfigKey: must be the package's OWN instances namespace " +
        `("${ownNamespace ?? "?"}"), never another package's`,
    );
  }
  if (!Array.isArray(canon.auth.requiredInstanceFields)) {
    errors.push("auth.requiredInstanceFields: must be an array");
  } else if (canon.auth.requiredInstanceFields.length > MAX_REQUIRED_INSTANCE_FIELDS) {
    errors.push(`auth.requiredInstanceFields: at most ${MAX_REQUIRED_INSTANCE_FIELDS} entries`);
  } else {
    canon.auth.requiredInstanceFields.forEach((f, i) => {
      bounded(f, MAX_INSTANCE_FIELD_LENGTH, `auth.requiredInstanceFields[${i}]`);
      if (i > 0 && canon.auth.requiredInstanceFields[i - 1]! >= f) {
        errors.push("auth.requiredInstanceFields: must be sorted (canonical order)");
      }
    });
  }
  if (canon.auth.requireUserToken !== true) {
    errors.push("auth.requireUserToken: must be exactly true (runtime opt-out is prohibited)");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Strict canonical JSON + the binding hash
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical JSON: object keys sorted by UTF-16 code unit,
 * arrays in order, only JSON primitives admitted. Combined with the NFC
 * normalization + semantic sorts applied by the claim builder, one canon has
 * exactly ONE serialization — the hash input.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJsonStringify: non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(`canonicalJsonStringify: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(",")}}`;
}

/**
 * sha256 over the strict canonical JSON of a VALID v:2 canon. Throws on an
 * invalid canon — a hash is never computed over a claim the schema refused, so
 * an invalid claim can neither pend nor be approved.
 */
export function computeWidgetStreamBindingHashV2(canon: WidgetStreamMetadataCanonV2): string {
  const errors = validateWidgetStreamMetadataCanon(canon);
  if (errors.length > 0) {
    throw new Error(`computeWidgetStreamBindingHashV2: invalid canon:\n  - ${errors.join("\n  - ")}`);
  }
  return createHash("sha256").update(canonicalJsonStringify(canon)).digest("hex");
}

// ---------------------------------------------------------------------------
// Duplicate-key-rejecting JSON parse (differential-parsing defense: two
// parsers disagreeing on which duplicate wins must never disagree about what
// an admin approved — a manifest carrying ANY duplicate key is refused whole).
// ---------------------------------------------------------------------------

export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`parseJsonRejectingDuplicateKeys: ${msg} at offset ${i}`);
  };
  const skipWs = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const parseString = (): string => {
    if (text[i] !== '"') fail("expected string");
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        const raw = text.slice(start, i + 1);
        i++;
        // Delegate escape/codepoint semantics to the native parser for the
        // single scalar (no duplicate-key hazard inside one string).
        return JSON.parse(raw) as string;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if ((c as string) < " ") fail("unescaped control character in string");
      i++;
    }
    return fail("unterminated string");
  };
  const parseValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === '"') return parseString();
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      const keys = new Set<string>();
      skipWs();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipWs();
        const key = parseString();
        if (keys.has(key)) fail(`duplicate object key "${key}"`);
        keys.add(key);
        skipWs();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        obj[key] = parseValue();
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skipWs();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const numMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (numMatch) {
      i += numMatch[0].length;
      return Number(numMatch[0]);
    }
    return fail("unexpected token");
  };
  const value = parseValue();
  skipWs();
  if (i !== text.length) fail("trailing content");
  return value;
}

// ---------------------------------------------------------------------------
// Reading claims from the materialized store dir
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `moduleExportKey` must resolve, in the materialized `package.json`
 * `exports`, to a SINGLE plain string target — conditional objects, arrays,
 * patterns (`*` in key or target), and `null` are refused (the runtime loader
 * slice re-resolves the same key at load; an ambiguous mapping must never be
 * approvable).
 */
function resolveSingleStringExport(exportsField: unknown, key: string): string | null {
  if (!isObj(exportsField)) return null;
  if (key.includes("*")) return null;
  if (!Object.prototype.hasOwnProperty.call(exportsField, key)) return null;
  const target = (exportsField as Record<string, unknown>)[key];
  if (typeof target !== "string") return null;
  if (!target.startsWith("./") || target.includes("*") || target.split("/").includes("..")) return null;
  return target;
}

const DEFAULT_MODULE_EXPORT_KEY = "./widget-chat-tool";

type RawDeclarationResult =
  | { ok: true; claim: WidgetStreamMetadataGrantClaim }
  | { ok: false; error: string };

function buildClaimFromDeclaration(
  packageName: string,
  raw: unknown,
  exportsField: unknown,
): RawDeclarationResult {
  if (!isObj(raw)) return { ok: false, error: "declaration must be an object" };
  const nfc = (v: unknown): string | null => (typeof v === "string" ? v.normalize("NFC").trim() : null);
  const agentSlug = nfc(raw.agentSlug);
  const label = nfc(raw.label);
  const subjectNoun = nfc(raw.subjectNoun);
  const skillCapability = nfc(raw.skillCapability);
  const factory = nfc(raw.factory);
  if (factory === null) {
    // Runtime claims must DECLARE the factory (a materialized package ships
    // built artifacts only — there is no source tree to scan, unlike the
    // build-time generator).
    return { ok: false, error: "factory: runtime declarations must name the widget-chat-tool factory export" };
  }
  const moduleExportKey =
    raw.moduleExportKey === undefined ? DEFAULT_MODULE_EXPORT_KEY : nfc(raw.moduleExportKey);
  if (moduleExportKey === null) return { ok: false, error: "moduleExportKey: must be a string when present" };
  let relayAgentPackage: string | null;
  if (raw.relayAgentPackage === undefined || raw.relayAgentPackage === null) {
    relayAgentPackage = null;
  } else {
    relayAgentPackage = nfc(raw.relayAgentPackage);
    if (relayAgentPackage === null) return { ok: false, error: "relayAgentPackage: must be a string when present" };
  }
  if (!Array.isArray(raw.contextFields)) return { ok: false, error: "contextFields: must be an array" };
  const contextFields: WidgetStreamMetadataContextField[] = [];
  for (const f of raw.contextFields) {
    if (!isObj(f)) return { ok: false, error: "contextFields: each entry must be an object" };
    const key = nfc(f.key);
    if (key === null || typeof f.maxLength !== "number") {
      return { ok: false, error: "contextFields: each entry must be { key, maxLength }" };
    }
    contextFields.push({ key, maxLength: f.maxLength });
  }
  contextFields.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!isObj(raw.auth)) return { ok: false, error: "auth: must be an object" };
  const tokenConfigKey = nfc(raw.auth.tokenConfigKey);
  const instancesConfigKey = nfc(raw.auth.instancesConfigKey);
  if (tokenConfigKey === null || instancesConfigKey === null) {
    return { ok: false, error: "auth: tokenConfigKey + instancesConfigKey must be strings" };
  }
  if (!Array.isArray(raw.auth.requiredInstanceFields)) {
    return { ok: false, error: "auth.requiredInstanceFields: must be an array" };
  }
  const requiredInstanceFields: string[] = [];
  for (const f of raw.auth.requiredInstanceFields) {
    const v = nfc(f);
    if (v === null) return { ok: false, error: "auth.requiredInstanceFields: entries must be strings" };
    requiredInstanceFields.push(v);
  }
  requiredInstanceFields.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // FLAT PROHIBITION: `requireUserToken !== true` never pends and never
  // resolves. Absent defaults to the ENFORCING value (matching the build-time
  // default on the public widget surface); an explicit `false` is refused.
  const requireUserToken = raw.auth.requireUserToken === undefined ? true : raw.auth.requireUserToken;
  if (requireUserToken !== true) {
    return { ok: false, error: "auth.requireUserToken: false is prohibited for runtime widget declarations" };
  }
  if (agentSlug === null || label === null || subjectNoun === null || skillCapability === null) {
    return { ok: false, error: "agentSlug/label/subjectNoun/skillCapability must be strings" };
  }
  if (resolveSingleStringExport(exportsField, moduleExportKey) === null) {
    return {
      ok: false,
      error: `moduleExportKey: "${moduleExportKey}" must resolve in package.json exports to a single string target`,
    };
  }
  const canon: WidgetStreamMetadataCanonV2 = {
    v: 2,
    agentSlug,
    packageName,
    moduleExportKey,
    factory,
    relayAgentPackage,
    skillCapability,
    contextFields,
    label,
    subjectNoun,
    auth: { tokenConfigKey, instancesConfigKey, requiredInstanceFields, requireUserToken: true },
  };
  const errors = validateWidgetStreamMetadataCanon(canon);
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  const canonJson = canonicalJsonStringify(canon);
  return {
    ok: true,
    claim: {
      agentSlug,
      packageName,
      canon,
      canonJson,
      bindingHashV2: createHash("sha256").update(canonJson).digest("hex"),
    },
  };
}

/**
 * Read the widget-stream metadata claims a materialized (SRI-verified)
 * package's manifest declares. FAIL CLOSED, NEVER PARTIAL: a manifest that
 * cannot be read, carries a duplicate JSON key anywhere, or contains ANY
 * malformed/out-of-policy widgetStream entry (including a duplicate slug)
 * yields [] — the connector declares no runtime widget entry at all. The
 * refusal reason is logged (server console) so an operator can diagnose a
 * widget that never pends; the public surfaces stay opaque.
 */
export async function readWidgetStreamMetadataClaimsFromStore(
  storeDir: string,
): Promise<WidgetStreamMetadataGrantClaim[]> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    return [];
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = parseJsonRejectingDuplicateKeys(raw);
    if (!isObj(parsed)) return [];
    manifest = parsed;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[extension-widget-stream-metadata-grants] refusing manifest in ${storeDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
  const packageName = typeof manifest.name === "string" ? manifest.name.normalize("NFC") : null;
  if (packageName === null) return [];
  const cinatra = isObj(manifest.cinatra) ? manifest.cinatra : null;
  const declared = cinatra?.widgetStream;
  if (declared === undefined || declared === null) return [];
  const entries = Array.isArray(declared) ? declared : [declared];
  const claims: WidgetStreamMetadataGrantClaim[] = [];
  const slugs = new Set<string>();
  for (const entry of entries) {
    const result = buildClaimFromDeclaration(packageName, entry, manifest.exports);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[extension-widget-stream-metadata-grants] ${packageName}: refusing ALL widgetStream entries (fail closed): ${result.error}`,
      );
      return [];
    }
    if (slugs.has(result.claim.agentSlug)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[extension-widget-stream-metadata-grants] ${packageName}: duplicate agentSlug "${result.claim.agentSlug}" — refusing ALL entries`,
      );
      return [];
    }
    slugs.add(result.claim.agentSlug);
    claims.push(result.claim);
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type MetadataRow = {
  id: string;
  package_name: string;
  org_id: string | null;
  agent_slug: string;
  binding_hash_v2: string;
  canon_json: string;
  status: string;
  approved_by: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  row_version: number;
};

export type WidgetStreamMetadataGrant = {
  id: string;
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  bindingHashV2: string;
  canonJson: string;
  status: "pending" | "approved" | "revoked";
  approvedBy: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  rowVersion: number;
};

function rowToGrant(row: MetadataRow): WidgetStreamMetadataGrant {
  return {
    id: row.id,
    packageName: row.package_name,
    orgId: row.org_id,
    agentSlug: row.agent_slug,
    bindingHashV2: row.binding_hash_v2,
    canonJson: row.canon_json,
    status: row.status as WidgetStreamMetadataGrant["status"],
    approvedBy: row.approved_by,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    rowVersion: Number(row.row_version),
  };
}

const SELECT_COLUMNS =
  "id, package_name, org_id, agent_slug, binding_hash_v2, canon_json, status, approved_by, revoked_by, revoked_at, row_version";

function orgClause(orgId: string | null, valueIndex: number): { clause: string; value: string | null } {
  return orgId === null
    ? { clause: "org_id IS NULL", value: null }
    : { clause: `org_id = $${valueIndex}`, value: orgId };
}

async function readGrantRow(
  query: WidgetStreamMetadataGrantQuery,
  schema: string,
  packageName: string,
  orgId: string | null,
  agentSlug: string,
): Promise<WidgetStreamMetadataGrant | null> {
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(orgId, 3);
  const values: unknown[] = [packageName, agentSlug];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table}
      WHERE package_name = $1 AND agent_slug = $2 AND ${clause} LIMIT 1`,
    values,
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Record-time guards (the checks that need state beyond the claim itself)
// ---------------------------------------------------------------------------

/** Guards a record/reopen MUST run with — required, so a caller can never
 * forget them (fail-closed by construction, not by convention). */
export type WidgetStreamMetadataRecordGuards = {
  /** True when the slug is served by the BUILD-TIME generated map — build wins
   * absolutely; a colliding runtime claim never becomes a row. */
  isBuildTimeWidgetSlug: (agentSlug: string) => boolean | Promise<boolean>;
  /** The currently-APPROVED credential-store owner of a token key (the sibling
   * ownership grant's `resolveOwnershipOwner`) — the conjunction axis. */
  resolveCredentialStoreOwner: (tokenConfigKey: string, orgId: string | null) => Promise<string | null>;
};

export type RecordWidgetStreamMetadataResult =
  | { outcome: "recorded"; grant: WidgetStreamMetadataGrant }
  | { outcome: "refused"; reason: string };

export type RecordWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  claim: WidgetStreamMetadataGrantClaim;
};

async function refusalFor(
  input: RecordWidgetStreamMetadataInput,
  guards: WidgetStreamMetadataRecordGuards,
): Promise<string | null> {
  const { claim } = input;
  if (claim.packageName !== input.packageName || claim.canon.packageName !== input.packageName) {
    return `claim package "${claim.packageName}" does not match the installing package "${input.packageName}"`;
  }
  const errors = validateWidgetStreamMetadataCanon(claim.canon);
  if (errors.length > 0) return `invalid canon: ${errors.join("; ")}`;
  if (claim.bindingHashV2 !== computeWidgetStreamBindingHashV2(claim.canon)) {
    return "claim bindingHashV2 does not match its canon (stale/forged claim)";
  }
  if (await guards.isBuildTimeWidgetSlug(claim.agentSlug)) {
    return `agentSlug "${claim.agentSlug}" collides with a build-time widget-stream agent (build wins absolutely)`;
  }
  const owner = await guards.resolveCredentialStoreOwner(claim.canon.auth.tokenConfigKey, input.orgId);
  if (owner !== input.packageName) {
    return (
      `package is not the approved credential-store owner of token key "${claim.canon.auth.tokenConfigKey}" ` +
      `(owner: ${owner ?? "none"}) — the metadata grant is conjoined to the ownership grant`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API — record / approve (CAS) / revoke (sticky) / reopen / read /
// resolve / restore / delete-unapproved
// ---------------------------------------------------------------------------

/**
 * Record a widget-stream metadata claim. ALWAYS `pending` — there is NO
 * auto-approve on this axis for ANY trust tier.
 *
 * - Guard refusal (package mismatch, invalid canon, build-slug collision,
 *   ownership-conjunction failure) → `{ outcome: "refused" }`, no row touched.
 * - No existing row → insert `pending` at the claim's hash.
 * - Existing `revoked` row → PRESERVED UNTOUCHED whatever the hash (sticky
 *   revocation: an install never resurrects OR silently re-pends a tombstone).
 * - Existing row, SAME hash → untouched (preserves an existing approval).
 * - Existing row, DIFFERENT hash → reset to `pending` at the new hash
 *   (re-approval required after ANY canon change). The reset UPDATE itself
 *   refuses to touch a `revoked` row (race-proof stickiness).
 */
export async function recordRequestedWidgetStreamMetadataGrant(
  input: RecordWidgetStreamMetadataInput,
  guards: WidgetStreamMetadataRecordGuards,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<RecordWidgetStreamMetadataResult> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const refusal = await refusalFor(input, guards);
  if (refusal !== null) return { outcome: "refused", reason: refusal };
  const { claim } = input;
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId, claim.agentSlug);

  if (existing && (existing.status === "revoked" || existing.bindingHashV2 === claim.bindingHashV2)) {
    return { outcome: "recorded", grant: existing };
  }

  if (existing) {
    const { clause, value } = orgClause(input.orgId, 5);
    const values: unknown[] = [claim.bindingHashV2, claim.canonJson, input.packageName, claim.agentSlug];
    if (value !== null) values.push(value);
    const rows = await query<MetadataRow>(
      `UPDATE ${table}
         SET binding_hash_v2 = $1,
             canon_json = $2,
             status = 'pending',
             approved_by = NULL,
             row_version = row_version + 1,
             updated_at = now()
       WHERE package_name = $3 AND agent_slug = $4 AND ${clause} AND status <> 'revoked'
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    // 0 rows == the row became `revoked` between the read and the write —
    // stickiness wins; return the tombstone untouched.
    if (!rows[0]) {
      const now = await readGrantRow(query, schema, input.packageName, input.orgId, claim.agentSlug);
      if (!now) throw new Error("extension_widget_stream_metadata_grant re-pend lost the row");
      return { outcome: "recorded", grant: now };
    }
    return { outcome: "recorded", grant: rowToGrant(rows[0]) };
  }

  const rows = await query<MetadataRow>(
    `INSERT INTO ${table} (package_name, org_id, agent_slug, binding_hash_v2, canon_json, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING ${SELECT_COLUMNS}`,
    [input.packageName, input.orgId, claim.agentSlug, claim.bindingHashV2, claim.canonJson],
  );
  if (!rows[0]) throw new Error("extension_widget_stream_metadata_grant insert returned no row");
  return { outcome: "recorded", grant: rowToGrant(rows[0]) };
}

/** Typed CAS conflict — the admin surface re-displays the CURRENT canon. */
export class WidgetStreamMetadataApprovalConflictError extends Error {
  readonly code:
    | "no-grant"
    | "not-pending-approved"
    | "not-pending-revoked"
    | "binding-hash-changed";
  constructor(code: WidgetStreamMetadataApprovalConflictError["code"], message: string) {
    super(message);
    this.name = "WidgetStreamMetadataApprovalConflictError";
    this.code = code;
  }
}

export type ApproveWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  approvedBy: string;
  /** REQUIRED: the exact hash the admin was shown. Not optional — an approval
   * without a basis would be an approval of a canon nobody verifiably saw. */
  expectedBindingHashV2: string;
};

/**
 * Approve a metadata grant — transactional COMPARE-AND-SWAP on the displayed
 * hash. The single UPDATE succeeds only while the row is still `pending` AT
 * `expectedBindingHashV2` for the named package; anything else (an install
 * re-pended the row to a new hash, a revocation landed, the row vanished)
 * throws a typed conflict and the admin must re-view the current canon. A
 * second approved grant for the same slug/scope is a DB write-time
 * impossibility (`..._approved_slug_uniq` / `..._approved_slug_global_uniq`
 * partial unique indexes) — squatting surfaces as a unique violation.
 */
export async function approveWidgetStreamMetadataGrant(
  input: ApproveWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 5);
  const values: unknown[] = [input.approvedBy, input.packageName, input.agentSlug, input.expectedBindingHashV2];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `UPDATE ${table}
       SET status = 'approved',
           approved_by = $1,
           row_version = row_version + 1,
           updated_at = now()
     WHERE package_name = $2 AND agent_slug = $3 AND binding_hash_v2 = $4
       AND status = 'pending' AND ${clause}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  if (rows[0]) return rowToGrant(rows[0]);
  const current = await readGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
  if (!current) {
    throw new WidgetStreamMetadataApprovalConflictError(
      "no-grant",
      `No widget-stream metadata grant for ${input.packageName} (slug=${input.agentSlug}, org=${input.orgId ?? "global"})`,
    );
  }
  if (current.status === "revoked") {
    throw new WidgetStreamMetadataApprovalConflictError(
      "not-pending-revoked",
      `Grant for ${input.packageName}/${input.agentSlug} is revoked (tombstoned); an explicit admin reopen is required before approval`,
    );
  }
  if (current.bindingHashV2 !== input.expectedBindingHashV2) {
    throw new WidgetStreamMetadataApprovalConflictError(
      "binding-hash-changed",
      `The widget definition for ${input.packageName}/${input.agentSlug} changed since it was displayed; re-view the current canon before approving`,
    );
  }
  throw new WidgetStreamMetadataApprovalConflictError(
    "not-pending-approved",
    `Grant for ${input.packageName}/${input.agentSlug} is not pending (status=${current.status})`,
  );
}

export type RevokeWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  revokedBy: string;
};

/**
 * Revoke a metadata grant — a DURABLE TOMBSTONE. The row keeps existing (grant
 * identity is durable); installs can neither resurrect nor silently re-pend
 * it; only the explicit admin reopen below reconsiders it.
 */
export async function revokeWidgetStreamMetadataGrant(
  input: RevokeWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 4);
  const values: unknown[] = [input.revokedBy, input.packageName, input.agentSlug];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `UPDATE ${table}
       SET status = 'revoked',
           approved_by = NULL,
           revoked_by = $1,
           revoked_at = now(),
           row_version = row_version + 1,
           updated_at = now()
     WHERE package_name = $2 AND agent_slug = $3 AND ${clause}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

export type ReopenWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  /** The CURRENT on-disk claim (re-read from the materialized store) — the
   * reopened row pends at the canon an admin will actually be shown. */
  claim: WidgetStreamMetadataGrantClaim;
};

/**
 * The EXPLICIT admin action that reconsiders a revoked grant: `revoked` →
 * `pending` at the CURRENT claim. Runs the same record-time guards as a fresh
 * record (a reopen must not admit a claim a record would refuse). Only ever
 * transitions a `revoked` row; anything else throws.
 */
export async function reopenRevokedWidgetStreamMetadataGrant(
  input: ReopenWidgetStreamMetadataInput,
  guards: WidgetStreamMetadataRecordGuards,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const refusal = await refusalFor(
    { packageName: input.packageName, orgId: input.orgId, claim: input.claim },
    guards,
  );
  if (refusal !== null) {
    throw new Error(`reopenRevokedWidgetStreamMetadataGrant refused: ${refusal}`);
  }
  const { clause, value } = orgClause(input.orgId, 5);
  const values: unknown[] = [input.claim.bindingHashV2, input.claim.canonJson, input.packageName, input.agentSlug];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `UPDATE ${table}
       SET status = 'pending',
           binding_hash_v2 = $1,
           canon_json = $2,
           approved_by = NULL,
           revoked_by = NULL,
           revoked_at = NULL,
           row_version = row_version + 1,
           updated_at = now()
     WHERE package_name = $3 AND agent_slug = $4 AND ${clause} AND status = 'revoked'
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  if (!rows[0]) {
    throw new Error(
      `reopenRevokedWidgetStreamMetadataGrant: no revoked grant for ${input.packageName}/${input.agentSlug} (org=${input.orgId ?? "global"})`,
    );
  }
  return rowToGrant(rows[0]);
}

export type ReadWidgetStreamMetadataGrantInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
};

/** Read the exact-scope grant row (no global fallback) — prior-state capture
 * for durable rollback + the admin surface. */
export async function readWidgetStreamMetadataGrant(
  input: ReadWidgetStreamMetadataGrantInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  return readGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
}

export type ResolveApprovedWidgetStreamMetadataInput = {
  agentSlug: string;
  orgId: string | null;
};

/**
 * Resolve the UNIQUE `approved` metadata grant for a slug, fail-closed. An
 * org-scoped approved grant takes precedence over a global one (mirrors the
 * ownership resolver; the pilot records at global scope). Zero or ambiguous →
 * null → the runtime resolver arm 404s. This is the AUTHORITY read the
 * runtime resolver arm (a later slice) unions with the build-time map — the
 * on-disk canon re-hash, trust classification, and ownership conjunction are
 * re-asserted THERE, at every point of use.
 */
export async function resolveApprovedWidgetStreamMetadataGrant(
  input: ResolveApprovedWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  if (input.orgId !== null) {
    const orgRows = await query<MetadataRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${table}
        WHERE agent_slug = $1 AND org_id = $2 AND status = 'approved' LIMIT 2`,
      [input.agentSlug, input.orgId],
    );
    if (orgRows.length === 1) return rowToGrant(orgRows[0]!);
    if (orgRows.length > 1) return null; // defensive: index makes this impossible
  }
  const globalRows = await query<MetadataRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table}
      WHERE agent_slug = $1 AND org_id IS NULL AND status = 'approved' LIMIT 2`,
    [input.agentSlug],
  );
  if (globalRows.length === 1) return rowToGrant(globalRows[0]!);
  return null; // 0 approved (fail closed) or >1 (defensive)
}

export type RestoreWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  status: "pending" | "approved" | "revoked";
  bindingHashV2: string;
  canonJson: string;
  approvedBy: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
};

/**
 * DIRECTLY restore a grant row to a previously-captured, already-valid state
 * (durable rollback of a failed UPDATE install — mirrors the ownership grant's
 * restore). Used ONLY on the rollback path, never forward. STICKINESS GUARD:
 * a restore of a non-`revoked` captured state refuses to overwrite a row that
 * is CURRENTLY `revoked` (an admin may have revoked mid-install; a rollback
 * must never launder that revocation away) — in that case the tombstone wins
 * and is returned unchanged.
 */
export async function restoreWidgetStreamMetadataGrant(
  input: RestoreWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
  if (existing) {
    const stickiness = input.status === "revoked" ? "" : " AND status <> 'revoked'";
    const { clause, value } = orgClause(input.orgId, 9);
    const values: unknown[] = [
      input.status,
      input.bindingHashV2,
      input.canonJson,
      input.approvedBy,
      input.revokedBy,
      input.revokedAt,
      input.packageName,
      input.agentSlug,
    ];
    if (value !== null) values.push(value);
    const rows = await query<MetadataRow>(
      `UPDATE ${table}
         SET status = $1,
             binding_hash_v2 = $2,
             canon_json = $3,
             approved_by = $4,
             revoked_by = $5,
             revoked_at = $6,
             row_version = row_version + 1,
             updated_at = now()
       WHERE package_name = $7 AND agent_slug = $8 AND ${clause}${stickiness}
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    if (rows[0]) return rowToGrant(rows[0]);
    const now = await readGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
    if (!now) throw new Error("extension_widget_stream_metadata_grant restore lost the row");
    return now; // the tombstone won
  }
  const rows = await query<MetadataRow>(
    `INSERT INTO ${table} (package_name, org_id, agent_slug, binding_hash_v2, canon_json, status, approved_by, revoked_by, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.packageName,
      input.orgId,
      input.agentSlug,
      input.bindingHashV2,
      input.canonJson,
      input.status,
      input.approvedBy,
      input.revokedBy,
      input.revokedAt,
    ],
  );
  if (!rows[0]) throw new Error("extension_widget_stream_metadata_grant restore insert returned no row");
  return rowToGrant(rows[0]);
}

export type DeleteUnapprovedWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  /** Only the row THIS attempt recorded is deletable — pinned by its hash. */
  bindingHashV2: string;
};

/**
 * FRESH-install rollback: delete the still-`pending`, never-approved row this
 * attempt inserted — and ONLY that row (status `pending`, no approver, at the
 * exact hash this attempt wrote). An `approved` or `revoked` row is never
 * deletable through this module (durable grant identity: history cannot be
 * recreated to launder a revocation). Unlike the ownership grant's
 * fresh-rollback REVOKE, deleting is correct here: a pending metadata row was
 * never authority (no auto-approve exists on this axis), while revoking it
 * would fabricate an admin-meaning tombstone no admin created.
 */
export async function deleteUnapprovedWidgetStreamMetadataGrant(
  input: DeleteUnapprovedWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<boolean> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 4);
  const values: unknown[] = [input.packageName, input.agentSlug, input.bindingHashV2];
  if (value !== null) values.push(value);
  const rows = await query<Pick<MetadataRow, "id">>(
    `DELETE FROM ${table}
      WHERE package_name = $1 AND agent_slug = $2 AND binding_hash_v2 = $3 AND ${clause}
        AND status = 'pending' AND approved_by IS NULL
      RETURNING id`,
    values,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Install-pipeline integration (reached VIA `extension-capability-ownership-
// grants.ts` — the pipeline's existing grant step-helpers delegate here, so
// the pipeline itself gains no logic and no new import).
// ---------------------------------------------------------------------------

/** The install-pipeline hooks for the widget-stream metadata grant lifecycle.
 * All optional so existing pipeline unit tests can omit them (then no metadata
 * grant is recorded — a pure no-op leaving the runtime widget authority axis
 * empty, which fails closed); `makeWidgetStreamMetadataGrantInstallDeps()`
 * wires all five. */
export type WidgetStreamMetadataGrantInstallHooks = {
  /** Read the widget-stream metadata claims the materialized (SRI-verified)
   * manifest declares (`cinatra.widgetStream[]`), fail-closed-never-partial. */
  readWidgetStreamMetadataClaims?: (storeDir: string) => Promise<WidgetStreamMetadataGrantClaim[]>;
  /** Record ONE claim `pending` (guards inside; NEVER auto-approves). */
  recordWidgetStreamMetadataGrant?: (input: RecordWidgetStreamMetadataInput) => Promise<void>;
  /** Exact-scope row read — prior-state capture for durable rollback. */
  readWidgetStreamMetadataGrant?: (
    packageName: string,
    orgId: string | null,
    agentSlug: string,
  ) => Promise<CapturedWidgetStreamMetadataGrant | null>;
  /** Durable rollback: re-write the OLD grant row to its captured state
   * (revocation-sticky — see `restoreWidgetStreamMetadataGrant`). */
  restoreWidgetStreamMetadataGrant?: (input: RestoreWidgetStreamMetadataInput) => Promise<void>;
  /** FRESH-install rollback: delete the still-pending row this attempt wrote. */
  deleteUnapprovedWidgetStreamMetadataGrant?: (
    input: DeleteUnapprovedWidgetStreamMetadataInput,
  ) => Promise<void>;
};

export type CapturedWidgetStreamMetadataGrant = {
  agentSlug: string;
  status: "pending" | "approved" | "revoked";
  bindingHashV2: string;
  canonJson: string;
  approvedBy: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
};

/**
 * Capture the prior metadata grants (one per slug the NEW manifest claims) for
 * durable rollback — `recordRequestedWidgetStreamMetadataGrant` may re-pend a
 * prior approval against the new canon before a later throw, so a failed
 * update must re-pin the OLD install's grant state on the unwind paths. Empty
 * on a fresh install or when the reader is unwired.
 */
export async function capturePriorWidgetStreamMetadataGrants(
  hooks: Pick<WidgetStreamMetadataGrantInstallHooks, "readWidgetStreamMetadataGrant">,
  args: {
    isUpdate: boolean;
    packageName: string;
    orgId: string | null;
    claims: readonly WidgetStreamMetadataGrantClaim[];
  },
): Promise<CapturedWidgetStreamMetadataGrant[]> {
  if (!args.isUpdate || !hooks.readWidgetStreamMetadataGrant) return [];
  const read = hooks.readWidgetStreamMetadataGrant;
  const captured = await Promise.all(
    args.claims.map((claim) => read(args.packageName, args.orgId, claim.agentSlug)),
  );
  return captured.filter((g): g is CapturedWidgetStreamMetadataGrant => g !== null);
}

/**
 * Record every declared claim as a PENDING metadata grant. Deliberately NO
 * `autoGrantPrivileged` parameter: unlike ports / host DDL / credential-store
 * ownership, the metadata axis is NEVER auto-approved for any tier — an admin
 * must approve the displayed canon explicitly. A guard REFUSAL (slug collision,
 * ownership-conjunction failure, invalid canon) records nothing for that claim
 * and does not abort the install (the connector simply has no runtime widget
 * until fixed — fail closed); a DB error still propagates (fail loud). A pure
 * no-op when the recorder is unwired.
 */
export async function recordWidgetStreamMetadataGrants(
  hooks: Pick<WidgetStreamMetadataGrantInstallHooks, "recordWidgetStreamMetadataGrant">,
  args: {
    claims: readonly WidgetStreamMetadataGrantClaim[];
    packageName: string;
    orgId: string | null;
  },
): Promise<void> {
  if (!hooks.recordWidgetStreamMetadataGrant) return;
  for (const claim of args.claims) {
    await hooks.recordWidgetStreamMetadataGrant({
      packageName: args.packageName,
      orgId: args.orgId,
      claim,
    });
  }
}

/**
 * Undo THIS install attempt's metadata grant writes on a rollback path. For
 * each claimed slug: a captured prior row (an update) is re-pinned to its
 * EXACT state (revocation-sticky); with no prior row (a fresh install, or a
 * NEW slug this attempt added) the still-pending row this attempt inserted is
 * deleted. Best-effort + isolated per slug: a failure is reported via
 * `onFailure` and never masks the original install error.
 */
export async function unwindWidgetStreamMetadataGrants(args: {
  hooks: Pick<
    WidgetStreamMetadataGrantInstallHooks,
    "restoreWidgetStreamMetadataGrant" | "deleteUnapprovedWidgetStreamMetadataGrant"
  >;
  packageName: string;
  orgId: string | null;
  claims: readonly WidgetStreamMetadataGrantClaim[];
  priorGrants: readonly CapturedWidgetStreamMetadataGrant[];
  onFailure: (error: unknown) => void;
}): Promise<void> {
  const { hooks, packageName, orgId, claims, priorGrants, onFailure } = args;
  if (!hooks.restoreWidgetStreamMetadataGrant && !hooks.deleteUnapprovedWidgetStreamMetadataGrant) return;
  const priorBySlug = new Map(priorGrants.map((g) => [g.agentSlug, g]));
  for (const claim of claims) {
    const prior = priorBySlug.get(claim.agentSlug);
    try {
      if (prior && hooks.restoreWidgetStreamMetadataGrant) {
        await hooks.restoreWidgetStreamMetadataGrant({
          packageName,
          orgId,
          agentSlug: claim.agentSlug,
          status: prior.status,
          bindingHashV2: prior.bindingHashV2,
          canonJson: prior.canonJson,
          approvedBy: prior.approvedBy,
          revokedBy: prior.revokedBy,
          revokedAt: prior.revokedAt,
        });
      } else if (!prior && hooks.deleteUnapprovedWidgetStreamMetadataGrant) {
        await hooks.deleteUnapprovedWidgetStreamMetadataGrant({
          packageName,
          orgId,
          agentSlug: claim.agentSlug,
          bindingHashV2: claim.bindingHashV2,
        });
      }
    } catch (e) {
      onFailure(e);
    }
  }
}

/**
 * The metadata-grant lifecycle hooks for the pipeline deps factory. The
 * conjunction resolver is INJECTED by the caller (the sibling ownership-grant
 * module passes its own `resolveOwnershipOwner`) — this module never imports
 * that module, keeping the dependency direction acyclic. The build-slug guard
 * defaults to a lazy literal import of the generated map (kept out of this
 * module's static graph on purpose).
 */
export function makeWidgetStreamMetadataGrantInstallDeps(wiring: {
  resolveCredentialStoreOwner: (tokenConfigKey: string, orgId: string | null) => Promise<string | null>;
  isBuildTimeWidgetSlug?: (agentSlug: string) => boolean | Promise<boolean>;
}): WidgetStreamMetadataGrantInstallHooks {
  const guards: WidgetStreamMetadataRecordGuards = {
    resolveCredentialStoreOwner: wiring.resolveCredentialStoreOwner,
    isBuildTimeWidgetSlug:
      wiring.isBuildTimeWidgetSlug ??
      (async (agentSlug: string) =>
        Boolean(
          (await import("@/lib/generated/extensions.server")).GENERATED_WIDGET_STREAM_AGENTS[agentSlug],
        )),
  };
  return {
    readWidgetStreamMetadataClaims: (storeDir) => readWidgetStreamMetadataClaimsFromStore(storeDir),
    recordWidgetStreamMetadataGrant: async (input) => {
      const result = await recordRequestedWidgetStreamMetadataGrant(input, guards);
      if (result.outcome === "refused") {
        // Structured server-side diagnostic (the design routes detailed reasons
        // to logs/audit, never to a public response body).
        // eslint-disable-next-line no-console
        console.warn(
          `[extension-widget-stream-metadata-grants] refused claim ${input.packageName}/${input.claim.agentSlug}: ${result.reason}`,
        );
      }
    },
    readWidgetStreamMetadataGrant: async (packageName, orgId, agentSlug) => {
      const g = await readWidgetStreamMetadataGrant({ packageName, orgId, agentSlug });
      return g
        ? {
            agentSlug: g.agentSlug,
            status: g.status,
            bindingHashV2: g.bindingHashV2,
            canonJson: g.canonJson,
            approvedBy: g.approvedBy,
            revokedBy: g.revokedBy,
            revokedAt: g.revokedAt,
          }
        : null;
    },
    restoreWidgetStreamMetadataGrant: (i) => restoreWidgetStreamMetadataGrant(i).then(() => undefined),
    deleteUnapprovedWidgetStreamMetadataGrant: (i) =>
      deleteUnapprovedWidgetStreamMetadataGrant(i).then(() => undefined),
  };
}
