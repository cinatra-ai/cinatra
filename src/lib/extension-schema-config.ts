// The schema-config connector-UI vocabulary (hot-pluggable connectors
// without shipping React). PURE + IO-free, so it is unit-testable and safe to
// import on both server and client.
//
// A `schema-config` connector declares its setup/settings surface as DATA
// (`cinatra.configSchema`) instead of bundling a React page. The host renders it
// from this typed vocabulary, so the connector activates + configures at runtime
// with no rebuild. The six primitive families cover the "more than a basic form"
// connector surfaces: text/secret fields, OAuth-Nango connect, repeatable
// resource lists, status probes, copyable generated credentials, and named
// actions. `bundled-react` connectors stay rebuild-only (the installer surfaces
// a clear "requires rebuild" state — see `requiresRebuildState`).

export type SchemaConfigFieldKind =
  | "text"
  | "secret"
  | "nango-connect"
  | "repeatable-list"
  | "status-probe"
  | "copyable-credential"
  | "named-action";

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

export type SchemaConfigField =
  | TextField
  | SecretField
  | NangoConnectField
  | RepeatableListField
  | StatusProbeField
  | CopyableCredentialField
  | NamedActionField;

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
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
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
  const rawFields = raw.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { ok: false, errors: ["configSchema.fields must be a non-empty array"] };
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
