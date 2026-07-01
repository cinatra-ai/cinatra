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

/** A named action button (dispatched via the host action endpoint). */
export type NamedActionField = {
  kind: "named-action";
  label: string;
  actionId: string;
  confirm?: string;
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

export type SchemaConfigSurface = {
  title?: string;
  description?: string;
  fields: SchemaConfigField[];
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
const FIELD_KEY_ALLOWLIST: Record<SchemaConfigFieldKind, ReadonlySet<string>> = {
  text: new Set(["kind", "key", "label", "placeholder", "required", "description"]),
  secret: new Set(["kind", "key", "label", "required", "description"]),
  "nango-connect": new Set(["kind", "label", "providerConfigKey", "description"]),
  "repeatable-list": new Set(["kind", "key", "label", "itemLabel", "itemFields", "description"]),
  "status-probe": new Set(["kind", "label", "actionId", "description"]),
  "copyable-credential": new Set(["kind", "key", "label", "description"]),
  "named-action": new Set(["kind", "label", "actionId", "confirm", "description"]),
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
const ROOT_KEY_ALLOWLIST: ReadonlySet<string> = new Set(["title", "description", "fields"]);

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

  const seenKeys = new Set<string>();
  const fields: SchemaConfigField[] = [];
  rawFields.forEach((rawField, i) => {
    const at = `fields[${i}]`;
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

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    surface: {
      title: str(raw.title) ? raw.title : undefined,
      description: str(raw.description) ? raw.description : undefined,
      fields,
    },
  };
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
      return kind === "status-probe"
        ? { kind, label, actionId: raw.actionId, description }
        : { kind, label, actionId: raw.actionId, confirm: str(raw.confirm) ? raw.confirm : undefined, description };
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
        if (!rejectUnknownKeys(optRaw, new Set(["value", "label", "adminOnly"]), optAt, errors)) {
          return;
        }
        if (!str(optRaw.value) || !str(optRaw.label)) {
          errors.push(`${optAt}: requires string "value" and "label"`);
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
  for (const f of surface.fields) {
    if (f.kind === "status-probe" || f.kind === "named-action") ids.add(f.actionId);
    else if (f.kind === "advisory") ids.add(f.probeActionId);
    else if (f.kind === "record-list") {
      ids.add(f.listActionId);
      if (f.deleteActionId) ids.add(f.deleteActionId);
    } else if (f.kind === "dynamic-select-options") ids.add(f.optionsAction);
  }
  return [...ids];
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
