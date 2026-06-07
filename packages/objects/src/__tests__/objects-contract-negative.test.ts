// Canonical objects_* schemas reject legacy aliases.
// Legacy aliases (`payload`, top-level `type`, composite `{ type, id }`, bare
// `{ id }`) MUST be rejected at Zod parse time everywhere. No compatibility
// wrappers.
import { describe, it, expect } from "vitest";
import {
  objectsSaveSchema,
  objectsGetSchema,
  objectsUpdateSchema,
  objectsDeleteSchema,
  objectsClassifySchema,
} from "../mcp/schemas";

describe("legacy alias REJECTION (negative tests)", () => {
  it("objects_save rejects the `payload` alias", () => {
    expect(() => objectsSaveSchema.parse({ payload: { a: 1 } })).toThrow();
  });

  it("objects_save rejects the top-level `type` alias", () => {
    expect(() => objectsSaveSchema.parse({ rawData: { a: 1 }, type: "@cinatra-ai/x:y" })).toThrow();
  });

  it("objects_get rejects the composite `{ type, id }` identity", () => {
    expect(() => objectsGetSchema.parse({ type: "contact", id: "obj_1" })).toThrow();
  });

  it("objects_get rejects bare `{ id }` (canonical is objectId)", () => {
    expect(() => objectsGetSchema.parse({ id: "obj_1" })).toThrow();
  });

  it("objects_update rejects the `payload` alias", () => {
    expect(() => objectsUpdateSchema.parse({ objectId: "obj_1", payload: { a: 1 } })).toThrow();
  });

  it("objects_delete rejects unknown keys (strict)", () => {
    expect(() => objectsDeleteSchema.parse({ objectId: "obj_1", type: "contact" })).toThrow();
  });

  it("objects_classify rejects unknown keys (strict)", () => {
    expect(() => objectsClassifySchema.parse({ rawData: { a: 1 }, payload: { a: 1 } })).toThrow();
  });
});

describe("canonical shapes still ACCEPTED (positive controls)", () => {
  it("objects_save accepts rawData + typeHint", () => {
    expect(() => objectsSaveSchema.parse({ rawData: { a: 1 }, typeHint: "@cinatra-ai/x:y" })).not.toThrow();
  });

  it("objects_get accepts { objectId }", () => {
    expect(() => objectsGetSchema.parse({ objectId: "obj_1" })).not.toThrow();
  });

  it("objects_update accepts { objectId, data }", () => {
    expect(() => objectsUpdateSchema.parse({ objectId: "obj_1", data: { a: 1 } })).not.toThrow();
  });

  it("objects_classify accepts { objectId, typeHint }", () => {
    expect(() => objectsClassifySchema.parse({ objectId: "obj_1", typeHint: "@cinatra-ai/x:y" })).not.toThrow();
  });
});
