import { describe, it, expect } from "vitest";
// The build-time generator (.mjs) duplicates a JS validator for
// `cinatra.configSchema` because a plain build script cannot import the TS
// parser. This parity suite locks the two validators to the SAME verdict on a
// representative corpus (valid + each invalid family) so the generation-time
// gate can never silently diverge from the authoritative runtime parser the
// dispatch route renders from.
import { validateConfigSchema } from "../generate-extension-manifest.mjs";
import { parseSchemaConfig } from "@/lib/extension-schema-config";

// Each case: the raw configSchema + a human label. The two validators must AGREE
// on the ok/not-ok verdict for every one.
const CORPUS: Array<{ label: string; raw: unknown }> = [
  // ---- valid ----
  {
    label: "single text field",
    raw: { title: "T", fields: [{ kind: "text", key: "host", label: "Host" }] },
  },
  {
    label: "full vocabulary",
    raw: {
      title: "Full",
      description: "all kinds",
      fields: [
        { kind: "text", key: "host", label: "Host", placeholder: "h", required: true },
        { kind: "secret", key: "apiKey", label: "API key", required: true },
        { kind: "nango-connect", label: "Connect", providerConfigKey: "p" },
        { kind: "status-probe", label: "Status", actionId: "probe" },
        { kind: "copyable-credential", key: "cred", label: "Cred" },
        { kind: "named-action", label: "Refresh", actionId: "refresh", confirm: "Sure?" },
        {
          kind: "repeatable-list",
          key: "items",
          label: "Items",
          itemLabel: "item",
          itemFields: [
            { kind: "text", key: "name", label: "Name" },
            { kind: "secret", key: "token", label: "Token" },
          ],
        },
      ],
    },
  },
  // ---- invalid (one per validation family) ----
  { label: "not an object", raw: "nope" },
  { label: "null", raw: null },
  { label: "empty fields", raw: { fields: [] } },
  { label: "missing fields", raw: { title: "x" } },
  { label: "fields not an array", raw: { fields: { kind: "text" } } },
  { label: "unknown kind", raw: { fields: [{ kind: "frobnicate", key: "x", label: "X" }] } },
  { label: "missing label", raw: { fields: [{ kind: "text", key: "x" }] } },
  { label: "missing key", raw: { fields: [{ kind: "text", label: "X" }] } },
  { label: "invalid key (regex)", raw: { fields: [{ kind: "text", key: "1bad", label: "X" }] } },
  {
    label: "duplicate key",
    raw: {
      fields: [
        { kind: "text", key: "dup", label: "A" },
        { kind: "secret", key: "dup", label: "B" },
      ],
    },
  },
  { label: "nango missing providerConfigKey", raw: { fields: [{ kind: "nango-connect", label: "C" }] } },
  { label: "status-probe missing actionId", raw: { fields: [{ kind: "status-probe", label: "S" }] } },
  { label: "named-action invalid actionId", raw: { fields: [{ kind: "named-action", label: "N", actionId: "1x" }] } },
  {
    label: "repeatable-list empty itemFields",
    raw: { fields: [{ kind: "repeatable-list", key: "l", label: "L", itemFields: [] }] },
  },
  {
    label: "repeatable-list nested (non-flat) item",
    raw: {
      fields: [
        {
          kind: "repeatable-list",
          key: "l",
          label: "L",
          itemFields: [{ kind: "repeatable-list", key: "n", label: "N", itemFields: [] }],
        },
      ],
    },
  },
];

describe("generator validateConfigSchema ⇄ parseSchemaConfig parity", () => {
  for (const { label, raw } of CORPUS) {
    it(`agrees on the verdict: ${label}`, () => {
      const genErrors = validateConfigSchema(raw);
      const genOk = genErrors.length === 0;
      const parsed = parseSchemaConfig(raw);
      // Same ok/not-ok verdict from both validators.
      expect(genOk).toBe(parsed.ok);
      // When valid, both agree on the field count (cheap structural agreement).
      if (genOk && parsed.ok) {
        const rawFields = (raw as { fields: unknown[] }).fields;
        expect(parsed.surface.fields).toHaveLength(rawFields.length);
      }
    });
  }
});
