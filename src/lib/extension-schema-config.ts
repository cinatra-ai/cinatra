// The schema-config connector-UI vocabulary (hot-pluggable connectors
// without shipping React). PURE + IO-free, so it is unit-testable and safe to
// import on both server and client.
//
// A `schema-config` connector declares its setup/settings surface as DATA
// (`cinatra.configSchema`) instead of bundling a React page. The host renders it
// from this typed vocabulary, so the connector activates + configures at runtime
// with no rebuild. The primitive families cover the "more than a basic form"
// connector surfaces: text/secret fields, OAuth-Nango connect, repeatable
// resource lists, status probes, copyable generated credentials, named actions,
// static + ACTION-SOURCED selects, boolean toggles, numeric inputs, and
// free-form string lists. `bundled-react` connectors stay rebuild-only (the
// installer surfaces a clear "requires rebuild" state — see `requiresRebuildState`).
//
// The ROOT-level opt-in hydration read-action declaration (`hydrateAction`) is
// the SDK-owned contract key (`CONFIG_HYDRATION_SCHEMA_KEY` in
// @cinatra-ai/sdk-extensions/config-hydration). It is spelled as a LITERAL here
// (not imported): this vocabulary module sits on the reachable graph of every
// locked dev-perf route (/chat, /api/mcp, …) and the route-graph ratchet
// forbids growing those graphs by a new SDK module edge for one constant.
// No-drift is pinned functionally in extension-schema-config-hydration.test.ts,
// which builds declarations FROM the SDK constant — a divergence fails the parse.

export type SchemaConfigFieldKind =
  | "text"
  | "secret"
  | "nango-connect"
  | "repeatable-list"
  | "status-probe"
  | "copyable-credential"
  | "named-action"
  | "select"
  | "record-list"
  | "banner"
  | "advisory"
  // cinatra#782: the openai-blocking field-kind expansion — action-sourced
  // select options, boolean toggles, numeric inputs, free-form string lists.
  | "dynamic-select-options"
  | "boolean"
  | "number"
  | "free-list";

export type TextField = {
  kind: "text";
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  description?: string;
};

/** A write-only secret (rendered masked; never echoed back). */
export type SecretField = {
  kind: "secret";
  key: string;
  label: string;
  required?: boolean;
  description?: string;
};

/** OAuth / Nango connect button bound to a provider config key. */
export type NangoConnectField = {
  kind: "nango-connect";
  label: string;
  providerConfigKey: string;
  description?: string;
};

/** A repeatable list of sub-records (e.g. multiple resource entries). */
export type RepeatableListField = {
  kind: "repeatable-list";
  key: string;
  label: string;
  itemLabel?: string;
  /** Only flat text/secret item fields are allowed (no nested lists). */
  itemFields: Array<TextField | SecretField>;
  description?: string;
};

/** A status probe: invokes a named action + renders its status via StatusPill. */
export type StatusProbeField = {
  kind: "status-probe";
  label: string;
  actionId: string;
  description?: string;
};

/** A copyable generated credential (read-only, with a copy button). */
export type CopyableCredentialField = {
  kind: "copyable-credential";
  key: string;
  label: string;
  description?: string;
};

/**
 * The canonical connection-action role a `named-action` may carry (design spec:
 * app-connectors §II, "One connection" — the plug/unplug Connect / Disconnect
 * pair). A CLOSED allowlist: an EXPLICIT contract, not an inference from the
 * label (label-inference was found not merge-safe). When a named action declares
 * `role`, the host renders it as the canonical affordance instead of a generic
 * labelled button:
 *   - `connect`    → the indigo-primary Connect button (plug leadingIcon).
 *   - `disconnect` → the destructive red Disconnect button (unplug leadingIcon),
 *     disabled until the connector is connected, whose confirmation is the
 *     renderer-owned neutral AlertDialog (NOT a bare prompt).
 * The two render SIDE BY SIDE as one connection-actions row. `role` is pure UI
 * metadata: it never grants authority — the host action endpoint owns
 * authorization exactly as for a role-less named action.
 */
export type ConnectorActionRole = "connect" | "disconnect";

/**
 * A named action button (dispatched via the host action endpoint). An optional
 * `role` promotes it to a canonical connection affordance (see
 * `ConnectorActionRole`). PRECEDENCE: for `role:"disconnect"` the renderer's
 * neutral AlertDialog is the sole confirmation path, so a `confirm` string is
 * IGNORED (the two must never stack a prompt on a dialog); a role-less named
 * action keeps its `confirm` window-prompt behavior unchanged.
 */
export type NamedActionField = {
  kind: "named-action";
  label: string;
  actionId: string;
  confirm?: string;
  role?: ConnectorActionRole;
  description?: string;
};

/**
 * A single-select / enum field. `options` are the static choices; an option
 * flagged `adminOnly: true` is HOST-EVALUATED against the actor (only a platform
 * admin sees + may submit it) — the package never evaluates the actor, and the
 * host write handler re-rejects an admin-only value submitted by a non-admin
 * (defense in depth). PURE DATA: no executable code, no HTML.
 */
export type SelectOption = {
  value: string;
  label: string;
  /** Host-evaluated: only a platform admin may see/submit this option. */
  adminOnly?: boolean;
  /**
   * Host-evaluated (cinatra#1926): only a development-mode OR preview
   * installation may see/submit this option — the single `localCliEligible`
   * predicate. Unlike `adminOnly` (a CLIENT-side visibility filter against a
   * host-provided flag), a `devPreviewOnly` option is stripped from the surface
   * SERVER-SIDE before the form reaches the browser
   * (`filterSurfaceForLocalCliEligibility`), so an ineligible installation never
   * ships the option's value/label to the client at all — and each connector's
   * write handler independently re-rejects the value server-side. The option
   * gates the provider connectors' dev/preview "Local CLI" connection mode; the
   * default `api` option carries no gate. PURE DATA.
   */
  devPreviewOnly?: boolean;
};
export type SelectField = {
  kind: "select";
  key: string;
  label: string;
  options: SelectOption[];
  defaultValue?: string;
  description?: string;
};

/**
 * A single-select whose options are ACTION-SOURCED (cinatra#782). Unlike the
 * static `select`, the choices are not known at author time: the renderer
 * invokes `optionsAction` (a host named action, host-authorized) at mount and
 * builds the `<Select>` from its result — `[{value,label}]`, or `{options:[…]}`
 * / `{items:[…]}`. Used for the openai `defaultModel` picker (fetches the live
 * model list). `defaultValue` is a plain string selected only IF the fetched
 * options contain it (membership is unknowable at parse time). PURE DATA: the
 * package supplies no server actions; the host owns the action + its scoping.
 */
export type DynamicSelectOptionsField = {
  kind: "dynamic-select-options";
  key: string;
  label: string;
  /** Host named action returning `[{value,label}]` / `{options}` / `{items}`. */
  optionsAction: string;
  defaultValue?: string;
  placeholder?: string;
  description?: string;
};

/** A boolean toggle (rendered as a Switch), persisted like other config values. */
export type BooleanField = {
  kind: "boolean";
  key: string;
  label: string;
  defaultValue?: boolean;
  description?: string;
};

/**
 * A numeric input with optional min/max/step. The renderer clamps for UX only;
 * the host write handler is the authoritative validator. `min`/`max`/`step`/
 * `defaultValue` must be finite numbers (fail-closed): `min <= max`, `step > 0`,
 * and `defaultValue` within `[min, max]` when those bounds are present.
 */
export type NumberField = {
  kind: "number";
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  placeholder?: string;
  required?: boolean;
  description?: string;
};

/**
 * An add/remove editor for a FREE-FORM string list (distinct from the
 * structured `repeatable-list` of sub-records). The renderer serializes the
 * non-empty entries as a single JSON `string[]` under one hidden `input[name=key]`
 * so it round-trips through the flat form collector; the host write handler
 * `JSON.parse`s it and re-validates it as a `string[]`.
 */
export type FreeListField = {
  kind: "free-list";
  key: string;
  label: string;
  itemLabel?: string;
  placeholder?: string;
  description?: string;
};

/** A self-describing badge variant the renderer accepts (closed allowlist). */
export type RecordListBadgeVariant =
  | "outline"
  | "secondary"
  | "destructive"
  | "success"
  | "warning"
  | "info"
  | "ghost"
  | "muted";
export type RecordListBadge = {
  /** Row field whose TRUTHY value (boolean true, or a non-empty string) shows this badge. */
  key: string;
  label: string;
  variant: RecordListBadgeVariant;
};
/**
 * A LIVE list of existing rows (distinct from the create-time `repeatable-list`).
 * The renderer invokes `listActionId` (a host named action) to load rows, renders
 * each with a title/subtitle + data-driven badges, and (when `deleteActionId` is
 * set) a per-row delete button that POSTs `{ id }` to the host delete action. All
 * dispatch is host-authorized via `/api/extensions/{installId}/actions/{actionId}`;
 * the package supplies NO server actions. PURE DATA.
 */
export type RecordListField = {
  kind: "record-list";
  label: string;
  /** Host named action returning `{ servers: Row[] }` / `{ items: Row[] }` / `Row[]`. */
  listActionId: string;
  /** Host named action the per-row delete button POSTs `{ id }` to (optional). */
  deleteActionId?: string;
  emptyState: string;
  /** Row field used as the item title. */
  itemTitleKey: string;
  /** Row field used as the item subtitle (optional). */
  itemSubtitleKey?: string;
  itemBadges: RecordListBadge[];
  description?: string;
};

/** A result banner tone (maps onto the Alert component variants). */
export type BannerTone = "default" | "destructive" | "warning" | "success" | "info";
export type BannerVariant = {
  /** Identity matched against an action RESULT `{ banner: <name> }`. */
  name: string;
  tone: BannerTone;
  message: string;
};
/**
 * A result-driven banner. It renders NOTHING until a named action returns a
 * result `{ banner: <name> }` matching one of `variants` (e.g. createServer →
 * `{ banner: "saved" }`). NOT search-param driven. PURE DATA.
 */
export type BannerField = {
  kind: "banner";
  label: string;
  variants: BannerVariant[];
};

/**
 * A conditional readiness advisory. Runs `probeActionId` (a host named action
 * returning `{ ready: boolean }`) and renders `whenReady` / `whenNotReady` copy
 * accordingly. Covers connection-service readiness + private-URL guidance.
 * PURE DATA — the copy is fixed text, the verdict is host-computed.
 */
export type AdvisoryField = {
  kind: "advisory";
  label: string;
  tone: BannerTone;
  probeActionId: string;
  whenReady: string;
  whenNotReady: string;
  description?: string;
};

export type SchemaConfigField =
  | TextField
  | SecretField
  | NangoConnectField
  | RepeatableListField
  | StatusProbeField
  | CopyableCredentialField
  | NamedActionField
  | SelectField
  | RecordListField
  | BannerField
  | AdvisoryField
  | DynamicSelectOptionsField
  | BooleanField
  | NumberField
  | FreeListField;

/**
 * The reserved tab id the host always orders LAST. A connector declares its
 * setup how-to / documentation under a `{ id: "help", … }` tab and — wherever it
 * sits in the declared order — the parser normalizes it to the end, so the
 * "Help" tab is always last (design spec: app-connectors §II). Reserved id, not
 * a reserved label: the label is still connector-authored.
 */
export const HELP_TAB_ID = "help";

/**
 * A tab GROUP over the setup surface (design spec: app-connectors §II — the
 * tabbed connector setup page). PURE DATA (the same fail-closed, no
 * executable/HTML-carrier vocabulary as a flat field list). The base `fields`
 * render as the first "Setup" tab; each declared `tabs[]` entry follows in
 * declared order, and the reserved `HELP_TAB_ID` tab is always ordered LAST.
 * Connector-agnostic: core names no connector.
 */
export type TabDef = {
  id: string;
  label: string;
  fields: SchemaConfigField[];
};

export type SchemaConfigSurface = {
  title?: string;
  description?: string;
  fields: SchemaConfigField[];
  /**
   * Optional tab groups. Absent (or an empty array) → the form renders FLAT
   * (the pre-tabs behavior, unchanged). Present → the host renders a tablist
   * (`Setup` + these, Help last). Field `key`s are unique across the base
   * `fields` AND every tab's `fields` (they share one flat submit namespace).
   */
  tabs?: TabDef[];
  /**
   * The opt-in hydration read-action (owner-ratified contract; cinatra#1082
   * item 3): the id of ONE connector-registered named action the HOST invokes
   * SERVER-SIDE at setup render to pre-fill the form's `initialValues` with
   * saved NON-SECRET values. Absent → the form keeps today's blank `{}`
   * pre-fill (zero regression). Secret fields are never hydrated regardless of
   * what the action returns, and any hydration failure fail-closes to `{}`
   * (see `collectHydrationKeySets` + the host resolver). Same actionId grammar
   * as every other declared action.
   */
  hydrateAction?: string;
};

export type ParseResult =
  | { ok: true; surface: SchemaConfigSurface }
  | { ok: false; errors: string[] };

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const FIELD_KINDS = new Set<SchemaConfigFieldKind>([
  "text",
  "secret",
  "nango-connect",
  "repeatable-list",
  "status-probe",
  "copyable-credential",
  "named-action",
  "select",
  "record-list",
  "banner",
  "advisory",
  "dynamic-select-options",
  "boolean",
  "number",
  "free-list",
]);

// Exact key allowlist per field kind. The parser REJECTS any field carrying a key
// outside its kind's allowlist (fail-closed): this denies a malicious connector
// smuggling an executable/HTML carrier key (`onClick`, `html`, `dangerouslySet…`,
// `script`, …) into a field the renderer might otherwise spread. Pure-data
// invariant (security invariant 1): no field kind may carry executable code.
export const FIELD_KEY_ALLOWLIST: Record<SchemaConfigFieldKind, ReadonlySet<string>> = {
  text: new Set(["kind", "key", "label", "placeholder", "required", "description"]),
  secret: new Set(["kind", "key", "label", "required", "description"]),
  "nango-connect": new Set(["kind", "label", "providerConfigKey", "description"]),
  "repeatable-list": new Set(["kind", "key", "label", "itemLabel", "itemFields", "description"]),
  "status-probe": new Set(["kind", "label", "actionId", "description"]),
  "copyable-credential": new Set(["kind", "key", "label", "description"]),
  "named-action": new Set(["kind", "label", "actionId", "confirm", "role", "description"]),
  select: new Set(["kind", "key", "label", "options", "defaultValue", "description"]),
  "record-list": new Set([
    "kind",
    "label",
    "listActionId",
    "deleteActionId",
    "emptyState",
    "itemTitleKey",
    "itemSubtitleKey",
    "itemBadges",
    "description",
  ]),
  banner: new Set(["kind", "label", "variants"]),
  advisory: new Set([
    "kind",
    "label",
    "tone",
    "probeActionId",
    "whenReady",
    "whenNotReady",
    "description",
  ]),
  "dynamic-select-options": new Set([
    "kind",
    "key",
    "label",
    "optionsAction",
    "defaultValue",
    "placeholder",
    "description",
  ]),
  boolean: new Set(["kind", "key", "label", "defaultValue", "description"]),
  number: new Set([
    "kind",
    "key",
    "label",
    "min",
    "max",
    "step",
    "defaultValue",
    "placeholder",
    "required",
    "description",
  ]),
  "free-list": new Set(["kind", "key", "label", "itemLabel", "placeholder", "description"]),
};

// Keys allowed at the configSchema ROOT (besides `fields`). Anything else is
// rejected fail-closed (no executable/HTML carrier at the root either).
const ROOT_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  "title",
  "description",
  "fields",
  "tabs",
  // The opt-in hydration read-action declaration — the SDK contract key
  // (CONFIG_HYDRATION_SCHEMA_KEY; literal per the header note, no-drift pinned
  // by test).
  "hydrateAction",
]);

// Exact key allowlist for a tab group (fail-closed, same stance as the field
// allowlists): a tab carries ONLY an id, a label, and a nested `fields` array —
// never an executable/HTML carrier key.
const TAB_KEY_ALLOWLIST: ReadonlySet<string> = new Set(["id", "label", "fields"]);

const BADGE_VARIANTS: ReadonlySet<string> = new Set([
  "outline",
  "secondary",
  "destructive",
  "success",
  "warning",
  "info",
  "ghost",
  "muted",
]);
/** The closed set of connection-action roles a `named-action` may declare. */
export const CONNECTOR_ACTION_ROLES: ReadonlySet<ConnectorActionRole> = new Set<ConnectorActionRole>([
  "connect",
  "disconnect",
]);
const BANNER_TONES: ReadonlySet<string> = new Set([
  "default",
  "destructive",
  "warning",
  "success",
  "info",
]);

/** Reject any key on `raw` not in the kind's allowlist (fail-closed). */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  at: string,
  errors: string[],
): boolean {
  let ok = true;
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      errors.push(`${at}: unexpected key ${JSON.stringify(k)}`);
      ok = false;
    }
  }
  return ok;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
/** A finite number (rejects NaN/±Infinity/non-number) — fail-closed. */
function finiteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Parse + validate a raw `cinatra.configSchema` into a typed surface. Fail-closed
 * (returns errors rather than a partial surface) — the renderer only ever
 * receives a fully-validated surface, so it never has to defend against malformed
 * declared config.
 */
export function parseSchemaConfig(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["configSchema must be an object"] };
  // Fail-closed: reject any unexpected root key (no executable/HTML carrier at
  // the root) before reading `fields`.
  rejectUnknownKeys(raw, ROOT_KEY_ALLOWLIST, "configSchema", errors);
  const rawFields = raw.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    errors.push("configSchema.fields must be a non-empty array");
    return { ok: false, errors };
  }

  // The opt-in hydration read-action DECLARATION is validated fail-closed like
  // every other declaration in this vocabulary: present-but-malformed fails the
  // whole parse (→ the invalid-schema-config state), it does NOT silently
  // degrade. (Runtime failures of the declared ACTION — missing, erroring,
  // malformed RESULT — are what map to a blank `{}` pre-fill instead; that
  // fail-closed path is the host hydration resolver's contract.)
  const rawHydrate = (raw as Record<string, unknown>).hydrateAction;
  let hydrateAction: string | undefined;
  if (rawHydrate !== undefined) {
    if (!str(rawHydrate) || !KEY_RE.test(rawHydrate)) {
      errors.push(`configSchema: "hydrateAction" must be a valid actionId string`);
    } else {
      hydrateAction = rawHydrate;
    }
  }

  const seenKeys = new Set<string>();
  const fields = parseFieldList(rawFields, "fields", errors, seenKeys);

  // Optional tab groups. Parsed with the SAME `seenKeys` set so a field key is
  // unique across the base fields AND every tab (they share one flat submit
  // namespace). Absent/empty → the surface stays flat (back-compat).
  const tabs = raw.tabs !== undefined ? parseTabs(raw.tabs, errors, seenKeys) : [];

  // Fail-closed on a malformed connection-action contract. The renderer composes
  // ONE canonical connection-actions row per surface, so: (1) each `role` value
  // is UNIQUE across the whole surface (two "connect" actions would silently drop
  // one), and (2) all role-bearing actions live in the SAME group (base `fields`
  // OR one tab) so a single row can hold the whole pair (a connect in the base
  // and a disconnect in a tab would render two incomplete rows). Reject rather
  // than silently misrender.
  const groups: SchemaConfigField[][] = [fields, ...tabs.map((t) => t.fields)];
  const roleCounts = new Map<ConnectorActionRole, number>();
  const roleGroupIdxs = new Set<number>();
  groups.forEach((group, gi) => {
    for (const f of group) {
      if (f.kind === "named-action" && f.role) {
        roleCounts.set(f.role, (roleCounts.get(f.role) ?? 0) + 1);
        roleGroupIdxs.add(gi);
      }
    }
  });
  for (const [role, n] of roleCounts) {
    if (n > 1) {
      errors.push(`configSchema: connection role ${JSON.stringify(role)} is declared ${n} times — a role must be unique across the surface`);
    }
  }
  if (roleGroupIdxs.size > 1) {
    errors.push(`configSchema: connection-action roles are split across multiple tabs/groups — the connect/disconnect pair must live in the same group`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    surface: {
      title: str(raw.title) ? raw.title : undefined,
      description: str(raw.description) ? raw.description : undefined,
      fields,
      ...(tabs.length > 0 ? { tabs } : {}),
      ...(hydrateAction !== undefined ? { hydrateAction } : {}),
    },
  };
}

/** Validate a raw field array into typed fields (shared by the base list + tabs). */
function parseFieldList(
  rawFields: unknown[],
  atPrefix: string,
  errors: string[],
  seenKeys: Set<string>,
): SchemaConfigField[] {
  const fields: SchemaConfigField[] = [];
  rawFields.forEach((rawField, i) => {
    const at = `${atPrefix}[${i}]`;
    if (!isObj(rawField)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const kind = rawField.kind;
    if (typeof kind !== "string" || !FIELD_KINDS.has(kind as SchemaConfigFieldKind)) {
      errors.push(`${at}: unknown field kind ${JSON.stringify(kind)}`);
      return;
    }
    const validated = validateField(kind as SchemaConfigFieldKind, rawField, at, errors, seenKeys);
    if (validated) fields.push(validated);
  });
  return fields;
}

/**
 * Parse the optional `tabs` root key into normalized TabDefs (Help last).
 * Fail-closed: rejects a non-array, unknown per-tab keys, an invalid/missing id
 * or label, an empty `fields`, and duplicate tab ids. Field keys are threaded
 * through `seenKeys` so they stay unique across the whole surface. Returns the
 * valid tabs (possibly empty); any violation pushes an error (the caller's
 * `errors.length` check then fails the whole parse — never a partial surface).
 */
function parseTabs(raw: unknown, errors: string[], seenKeys: Set<string>): TabDef[] {
  if (!Array.isArray(raw)) {
    errors.push(`configSchema.tabs must be an array`);
    return [];
  }
  const tabs: TabDef[] = [];
  const seenTabIds = new Set<string>();
  raw.forEach((rawTab, i) => {
    const at = `tabs[${i}]`;
    if (!isObj(rawTab)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    // Fail-closed: reject any key outside the tab allowlist FIRST.
    if (!rejectUnknownKeys(rawTab, TAB_KEY_ALLOWLIST, at, errors)) return;
    const id = rawTab.id;
    if (!str(id) || !KEY_RE.test(id)) {
      errors.push(`${at}: invalid or missing "id"`);
      return;
    }
    if (seenTabIds.has(id)) {
      errors.push(`${at}: duplicate tab id ${JSON.stringify(id)}`);
      return;
    }
    seenTabIds.add(id);
    if (!str(rawTab.label)) {
      errors.push(`${at}: missing "label"`);
      return;
    }
    if (!Array.isArray(rawTab.fields) || rawTab.fields.length === 0) {
      errors.push(`${at}: tab requires a non-empty "fields" array`);
      return;
    }
    const tabFields = parseFieldList(rawTab.fields, `${at}.fields`, errors, seenKeys);
    // A tab whose fields all failed validation contributes nothing (errors were
    // already pushed, so the whole parse fails).
    if (tabFields.length === 0) return;
    tabs.push({ id, label: rawTab.label, fields: tabFields });
  });
  // Normalize: the reserved Help tab is always LAST. Array.prototype.sort is
  // stable, so every non-Help tab keeps its declared order.
  tabs.sort((a, b) => Number(a.id === HELP_TAB_ID) - Number(b.id === HELP_TAB_ID));
  return tabs;
}

function requireKey(raw: Record<string, unknown>, at: string, errors: string[], seenKeys: Set<string>): string | null {
  const key = raw.key;
  if (!str(key) || !KEY_RE.test(key)) {
    errors.push(`${at}: invalid or missing "key"`);
    return null;
  }
  if (seenKeys.has(key)) {
    errors.push(`${at}: duplicate key "${key}"`);
    return null;
  }
  seenKeys.add(key);
  return key;
}

function validateField(
  kind: SchemaConfigFieldKind,
  raw: Record<string, unknown>,
  at: string,
  errors: string[],
  seenKeys: Set<string>,
): SchemaConfigField | null {
  // Fail-closed: reject any key outside this kind's exact allowlist FIRST, so a
  // smuggled executable/HTML carrier key (onClick/html/script/…) is refused
  // before any value is read (security invariant 1: pure data only).
  if (!rejectUnknownKeys(raw, FIELD_KEY_ALLOWLIST[kind], at, errors)) {
    return null;
  }
  const label = raw.label;
  if (!str(label)) {
    errors.push(`${at}: missing "label"`);
    return null;
  }
  const description = str(raw.description) ? raw.description : undefined;

  switch (kind) {
    case "text":
    case "secret": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      const common = { key, label, required: raw.required === true, description };
      return kind === "text"
        ? { kind, ...common, placeholder: str(raw.placeholder) ? raw.placeholder : undefined }
        : { kind, ...common };
    }
    case "copyable-credential": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      return { kind, key, label, description };
    }
    case "nango-connect": {
      if (!str(raw.providerConfigKey)) {
        errors.push(`${at}: nango-connect requires "providerConfigKey"`);
        return null;
      }
      return { kind, label, providerConfigKey: raw.providerConfigKey, description };
    }
    case "status-probe":
    case "named-action": {
      if (!str(raw.actionId) || !KEY_RE.test(raw.actionId)) {
        errors.push(`${at}: ${kind} requires a valid "actionId"`);
        return null;
      }
      if (kind === "status-probe") {
        return { kind, label, actionId: raw.actionId, description };
      }
      // Optional connection-action role — a CLOSED allowlist (fail-closed on any
      // other value). Absent → a plain named action (back-compat).
      let role: ConnectorActionRole | undefined;
      if (raw.role !== undefined) {
        if (typeof raw.role !== "string" || !CONNECTOR_ACTION_ROLES.has(raw.role as ConnectorActionRole)) {
          errors.push(`${at}: named-action "role" must be one of ${[...CONNECTOR_ACTION_ROLES].map((r) => JSON.stringify(r)).join(", ")}`);
          return null;
        }
        role = raw.role as ConnectorActionRole;
      }
      return {
        kind,
        label,
        actionId: raw.actionId,
        confirm: str(raw.confirm) ? raw.confirm : undefined,
        ...(role ? { role } : {}),
        description,
      };
    }
    case "repeatable-list": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      const itemFieldsRaw = raw.itemFields;
      if (!Array.isArray(itemFieldsRaw) || itemFieldsRaw.length === 0) {
        errors.push(`${at}: repeatable-list requires a non-empty "itemFields"`);
        return null;
      }
      const itemSeen = new Set<string>();
      const itemFields: Array<TextField | SecretField> = [];
      itemFieldsRaw.forEach((itemRaw, j) => {
        const itemAt = `${at}.itemFields[${j}]`;
        if (!isObj(itemRaw) || (itemRaw.kind !== "text" && itemRaw.kind !== "secret")) {
          errors.push(`${itemAt}: must be a text or secret field`);
          return;
        }
        const sub = validateField(itemRaw.kind, itemRaw, itemAt, errors, itemSeen);
        if (sub && (sub.kind === "text" || sub.kind === "secret")) itemFields.push(sub);
      });
      if (itemFields.length === 0) return null;
      return { kind, key, label, itemLabel: str(raw.itemLabel) ? raw.itemLabel : undefined, itemFields, description };
    }
    case "select": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      const rawOptions = raw.options;
      if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        errors.push(`${at}: select requires a non-empty "options"`);
        return null;
      }
      const options: SelectOption[] = [];
      const seenValues = new Set<string>();
      rawOptions.forEach((optRaw, j) => {
        const optAt = `${at}.options[${j}]`;
        if (!isObj(optRaw)) {
          errors.push(`${optAt}: must be an object`);
          return;
        }
        if (!rejectUnknownKeys(optRaw, new Set(["value", "label", "adminOnly", "devPreviewOnly"]), optAt, errors)) {
          return;
        }
        if (!str(optRaw.value) || !str(optRaw.label)) {
          errors.push(`${optAt}: requires string "value" and "label"`);
          return;
        }
        // The `devPreviewOnly` gate (cinatra#1926) is a SECURITY flag — a
        // malformed value must FAIL CLOSED at parse time, never be silently
        // dropped (which would un-gate the local-CLI option). Only an exact
        // boolean is accepted; any other defined value is rejected.
        if (optRaw.devPreviewOnly !== undefined && typeof optRaw.devPreviewOnly !== "boolean") {
          errors.push(`${optAt}: "devPreviewOnly" must be a boolean`);
          return;
        }
        if (seenValues.has(optRaw.value)) {
          errors.push(`${optAt}: duplicate value ${JSON.stringify(optRaw.value)}`);
          return;
        }
        seenValues.add(optRaw.value);
        options.push({
          value: optRaw.value,
          label: optRaw.label,
          ...(optRaw.adminOnly === true ? { adminOnly: true } : {}),
          ...(optRaw.devPreviewOnly === true ? { devPreviewOnly: true } : {}),
        });
      });
      if (options.length === 0) return null;
      const defaultValue = str(raw.defaultValue) ? raw.defaultValue : undefined;
      if (defaultValue !== undefined && !seenValues.has(defaultValue)) {
        errors.push(`${at}: defaultValue ${JSON.stringify(defaultValue)} is not one of "options"`);
        return null;
      }
      return { kind, key, label, options, defaultValue, description };
    }
    case "record-list": {
      if (!str(raw.listActionId) || !KEY_RE.test(raw.listActionId)) {
        errors.push(`${at}: record-list requires a valid "listActionId"`);
        return null;
      }
      if (raw.deleteActionId !== undefined && (!str(raw.deleteActionId) || !KEY_RE.test(raw.deleteActionId))) {
        errors.push(`${at}: record-list "deleteActionId" must be a valid action id`);
        return null;
      }
      if (!str(raw.emptyState)) {
        errors.push(`${at}: record-list requires "emptyState"`);
        return null;
      }
      if (!str(raw.itemTitleKey)) {
        errors.push(`${at}: record-list requires "itemTitleKey"`);
        return null;
      }
      const rawBadges = raw.itemBadges;
      if (!Array.isArray(rawBadges)) {
        errors.push(`${at}: record-list requires an "itemBadges" array`);
        return null;
      }
      const itemBadges: RecordListBadge[] = [];
      let badgeOk = true;
      rawBadges.forEach((bRaw, j) => {
        const bAt = `${at}.itemBadges[${j}]`;
        if (!isObj(bRaw)) {
          errors.push(`${bAt}: must be an object`);
          badgeOk = false;
          return;
        }
        if (!rejectUnknownKeys(bRaw, new Set(["key", "label", "variant"]), bAt, errors)) {
          badgeOk = false;
          return;
        }
        if (!str(bRaw.key) || !str(bRaw.label)) {
          errors.push(`${bAt}: requires string "key" and "label"`);
          badgeOk = false;
          return;
        }
        if (!str(bRaw.variant) || !BADGE_VARIANTS.has(bRaw.variant)) {
          errors.push(`${bAt}: invalid badge variant ${JSON.stringify(bRaw.variant)}`);
          badgeOk = false;
          return;
        }
        itemBadges.push({
          key: bRaw.key,
          label: bRaw.label,
          variant: bRaw.variant as RecordListBadgeVariant,
        });
      });
      if (!badgeOk) return null;
      return {
        kind,
        label,
        listActionId: raw.listActionId,
        ...(str(raw.deleteActionId) ? { deleteActionId: raw.deleteActionId } : {}),
        emptyState: raw.emptyState,
        itemTitleKey: raw.itemTitleKey,
        ...(str(raw.itemSubtitleKey) ? { itemSubtitleKey: raw.itemSubtitleKey } : {}),
        itemBadges,
        description,
      };
    }
    case "banner": {
      const rawVariants = raw.variants;
      if (!Array.isArray(rawVariants) || rawVariants.length === 0) {
        errors.push(`${at}: banner requires a non-empty "variants"`);
        return null;
      }
      const variants: BannerVariant[] = [];
      const seenNames = new Set<string>();
      let bOk = true;
      rawVariants.forEach((vRaw, j) => {
        const vAt = `${at}.variants[${j}]`;
        if (!isObj(vRaw)) {
          errors.push(`${vAt}: must be an object`);
          bOk = false;
          return;
        }
        if (!rejectUnknownKeys(vRaw, new Set(["name", "tone", "message"]), vAt, errors)) {
          bOk = false;
          return;
        }
        if (!str(vRaw.name) || !KEY_RE.test(vRaw.name)) {
          errors.push(`${vAt}: requires a valid "name"`);
          bOk = false;
          return;
        }
        if (seenNames.has(vRaw.name)) {
          errors.push(`${vAt}: duplicate variant name ${JSON.stringify(vRaw.name)}`);
          bOk = false;
          return;
        }
        seenNames.add(vRaw.name);
        if (!str(vRaw.tone) || !BANNER_TONES.has(vRaw.tone)) {
          errors.push(`${vAt}: invalid tone ${JSON.stringify(vRaw.tone)}`);
          bOk = false;
          return;
        }
        if (!str(vRaw.message)) {
          errors.push(`${vAt}: requires a "message"`);
          bOk = false;
          return;
        }
        variants.push({ name: vRaw.name, tone: vRaw.tone as BannerTone, message: vRaw.message });
      });
      if (!bOk || variants.length === 0) return null;
      return { kind, label, variants };
    }
    case "advisory": {
      if (!str(raw.probeActionId) || !KEY_RE.test(raw.probeActionId)) {
        errors.push(`${at}: advisory requires a valid "probeActionId"`);
        return null;
      }
      if (!str(raw.tone) || !BANNER_TONES.has(raw.tone)) {
        errors.push(`${at}: advisory requires a valid "tone"`);
        return null;
      }
      if (!str(raw.whenReady) || !str(raw.whenNotReady)) {
        errors.push(`${at}: advisory requires "whenReady" and "whenNotReady"`);
        return null;
      }
      return {
        kind,
        label,
        tone: raw.tone as BannerTone,
        probeActionId: raw.probeActionId,
        whenReady: raw.whenReady,
        whenNotReady: raw.whenNotReady,
        description,
      };
    }
    case "dynamic-select-options": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      if (!str(raw.optionsAction) || !KEY_RE.test(raw.optionsAction)) {
        errors.push(`${at}: dynamic-select-options requires a valid "optionsAction"`);
        return null;
      }
      // defaultValue is a plain string; membership can't be checked at parse
      // time (options are action-sourced), so the renderer only selects it if
      // the fetched options contain it.
      return {
        kind,
        key,
        label,
        optionsAction: raw.optionsAction,
        defaultValue: str(raw.defaultValue) ? raw.defaultValue : undefined,
        placeholder: str(raw.placeholder) ? raw.placeholder : undefined,
        description,
      };
    }
    case "boolean": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      if (raw.defaultValue !== undefined && typeof raw.defaultValue !== "boolean") {
        errors.push(`${at}: boolean "defaultValue" must be a boolean`);
        return null;
      }
      return {
        kind,
        key,
        label,
        ...(typeof raw.defaultValue === "boolean" ? { defaultValue: raw.defaultValue } : {}),
        description,
      };
    }
    case "number": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      for (const prop of ["min", "max", "step", "defaultValue"] as const) {
        if (raw[prop] !== undefined && !finiteNum(raw[prop])) {
          errors.push(`${at}: number "${prop}" must be a finite number`);
          return null;
        }
      }
      const min = finiteNum(raw.min) ? raw.min : undefined;
      const max = finiteNum(raw.max) ? raw.max : undefined;
      const step = finiteNum(raw.step) ? raw.step : undefined;
      const defaultValue = finiteNum(raw.defaultValue) ? raw.defaultValue : undefined;
      if (step !== undefined && step <= 0) {
        errors.push(`${at}: number "step" must be greater than 0`);
        return null;
      }
      if (min !== undefined && max !== undefined && min > max) {
        errors.push(`${at}: number "min" must be <= "max"`);
        return null;
      }
      if (defaultValue !== undefined) {
        if ((min !== undefined && defaultValue < min) || (max !== undefined && defaultValue > max)) {
          errors.push(`${at}: number "defaultValue" is outside [min, max]`);
          return null;
        }
      }
      return {
        kind,
        key,
        label,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        placeholder: str(raw.placeholder) ? raw.placeholder : undefined,
        required: raw.required === true,
        description,
      };
    }
    case "free-list": {
      const key = requireKey(raw, at, errors, seenKeys);
      if (!key) return null;
      return {
        kind,
        key,
        label,
        itemLabel: str(raw.itemLabel) ? raw.itemLabel : undefined,
        placeholder: str(raw.placeholder) ? raw.placeholder : undefined,
        description,
      };
    }
    default:
      errors.push(`${at}: unsupported kind`);
      return null;
  }
}

/** Collect every `actionId` a surface references (for the host action endpoint). */
export function collectActionIds(surface: SchemaConfigSurface): string[] {
  const ids = new Set<string>();
  const collect = (fields: SchemaConfigField[]) => {
    for (const f of fields) {
      if (f.kind === "status-probe" || f.kind === "named-action") ids.add(f.actionId);
      else if (f.kind === "advisory") ids.add(f.probeActionId);
      else if (f.kind === "record-list") {
        ids.add(f.listActionId);
        if (f.deleteActionId) ids.add(f.deleteActionId);
      } else if (f.kind === "dynamic-select-options") ids.add(f.optionsAction);
    }
  };
  collect(surface.fields);
  // Actions declared INSIDE a tab must be registered too, else the host action
  // endpoint rejects a probe/named-action/record-list/dynamic-select on a tab.
  for (const tab of surface.tabs ?? []) collect(tab.fields);
  // The root-level hydration read-action is a referenced action like any other
  // (registered via ctx.ui). Its SERVER-invoked-at-render property is a
  // call-path guarantee of the host render seam, not a dispatch ban — this
  // helper carries no dispatch authority either way.
  if (surface.hydrateAction) ids.add(surface.hydrateAction);
  return [...ids];
}

/**
 * The key sets the hydration sanitizer filters an action result against
 * (owner-ratified contract; cinatra#1082 item 3). PURE — derived entirely from
 * the validated surface:
 *
 * - `hydratableKeys`: keys of exactly the NON-SECRET, value-carrying field
 *   kinds the setup form hydrates from `initialValues` (text, select,
 *   dynamic-select-options, boolean, number, free-list, copyable-credential),
 *   across the flat `fields` AND every tab. A `repeatable-list` key is NOT
 *   hydratable (its saved rows are not representable in the flat
 *   `initialValues` string map), and a `secret` key never is.
 * - `secretKeys`: keys of every `secret` field (flat + tabs) PLUS every secret
 *   `repeatable-list` item-field key. Item keys live in a separate declared
 *   namespace, so one MAY collide with a flat hydratable key — the sanitizer
 *   refuses the colliding key entirely (secret wins; defense in depth).
 */
export function collectHydrationKeySets(surface: SchemaConfigSurface): {
  hydratableKeys: Set<string>;
  secretKeys: Set<string>;
} {
  const hydratableKeys = new Set<string>();
  const secretKeys = new Set<string>();
  const collect = (fields: SchemaConfigField[]) => {
    for (const f of fields) {
      switch (f.kind) {
        case "text":
        case "select":
        case "dynamic-select-options":
        case "boolean":
        case "number":
        case "free-list":
        case "copyable-credential":
          hydratableKeys.add(f.key);
          break;
        case "secret":
          secretKeys.add(f.key);
          break;
        case "repeatable-list":
          for (const item of f.itemFields) {
            if (item.kind === "secret") secretKeys.add(item.key);
          }
          break;
        default:
          break;
      }
    }
  };
  collect(surface.fields);
  for (const tab of surface.tabs ?? []) collect(tab.fields);
  // A key that is BOTH declared secret somewhere and hydratable elsewhere must
  // never hydrate: drop it from the hydratable set too (the sanitizer also
  // enforces secret-wins independently — belt and braces).
  for (const k of secretKeys) hydratableKeys.delete(k);
  return { hydratableKeys, secretKeys };
}

/**
 * Strip every `devPreviewOnly` select option from a surface when the local-CLI
 * connection mode is INELIGIBLE (cinatra#1926). This is the SERVER-SIDE gate the
 * connector setup route applies before handing the surface to the client form, so
 * an ineligible installation never ships the gated option's value/label to the
 * browser — "absent from the rendered DOM", not a client-side hide.
 *
 * PURE (returns the same reference unchanged when nothing is gated, or when
 * `eligible`): removes only gated OPTIONS; a `select` whose `defaultValue` was the
 * removed option loses the stale default (so the renderer falls to the first
 * surviving option); a `select` whose options are ALL gated is dropped entirely,
 * and a tab left with no fields is dropped so no empty tab dangles. All other
 * field kinds, keys, actions and tab order (Help still last) are untouched.
 */
export function filterSurfaceForLocalCliEligibility(
  surface: SchemaConfigSurface,
  eligible: boolean,
): SchemaConfigSurface {
  if (eligible) return surface;

  let changed = false;
  const filterField = (f: SchemaConfigField): SchemaConfigField | null => {
    if (f.kind !== "select") return f;
    const kept = f.options.filter((o) => o.devPreviewOnly !== true);
    if (kept.length === f.options.length) return f;
    changed = true;
    // Every option gated → the field carries no valid choice; drop it.
    if (kept.length === 0) return null;
    const defaultSurvives =
      f.defaultValue !== undefined && kept.some((o) => o.value === f.defaultValue);
    const next: SelectField = { ...f, options: kept };
    if (!defaultSurvives) delete next.defaultValue;
    return next;
  };
  const filterList = (fields: SchemaConfigField[]): SchemaConfigField[] => {
    const out: SchemaConfigField[] = [];
    for (const f of fields) {
      const nf = filterField(f);
      if (nf) out.push(nf);
    }
    return out;
  };

  const fields = filterList(surface.fields);
  const tabs = surface.tabs
    ? surface.tabs
        .map((t) => ({ ...t, fields: filterList(t.fields) }))
        .filter((t) => t.fields.length > 0)
    : undefined;

  if (!changed) return surface;
  // Explicitly REPLACE `fields`/`tabs` rather than spread-then-conditionally-add:
  // if EVERY tab was stripped (all its fields gated away), a conditional add
  // would leave `...surface`'s ORIGINAL (ungated) tabs in place — a fail-OPEN
  // that would re-expose the gated option. So when the surface declared tabs,
  // always overwrite them with the filtered set, dropping the key entirely when
  // nothing survives.
  const next: SchemaConfigSurface = { ...surface, fields };
  if (surface.tabs) {
    if (tabs && tabs.length > 0) {
      next.tabs = tabs;
    } else {
      delete next.tabs;
    }
  }
  return next;
}

/** The installer state for a connector whose UI cannot hot-install. */
export type RequiresRebuildState = {
  uiSurface: "bundled-react";
  requiresRebuild: true;
  message: string;
};

/**
 * The "requires rebuild" state the installer surfaces for a `bundled-react`
 * connector (App Router RSC limitation — its React page is base-image-only).
 */
export function requiresRebuildState(packageName: string): RequiresRebuildState {
  return {
    uiSurface: "bundled-react",
    requiresRebuild: true,
    message:
      `"${packageName}" ships a bundled React setup page, which cannot be hot-installed at runtime. ` +
      `It is available after a base-image rebuild that includes this connector.`,
  };
}
