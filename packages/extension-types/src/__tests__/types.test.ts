// Asserts that the four types exported from @cinatra-ai/extension-types are
// importable and structurally accept canonical literals.
// Tests run as TS-level structural assertions; runtime simply confirms vitest runs.

import { describe, it, expect } from "vitest";
import type {
  PackageRef,
  ValidationResult,
  Actor,
  ExtensionTypeHandler,
} from "@cinatra-ai/extension-types";

describe("@cinatra-ai/extension-types structural assertions", () => {
  it("PackageRef accepts { registryUrl, packageName } (version optional)", () => {
    const _required: PackageRef = { registryUrl: "https://registry.example.com", packageName: "@org/pkg" };
    const _withVersion: PackageRef = { registryUrl: "https://registry.example.com", packageName: "@org/pkg", version: "1.0.0" };
    // Type-check passes if compilation reaches here
    expect(true).toBe(true);
  });

  it("ValidationResult accepts { valid: true } and { valid: false, errors: [...] }", () => {
    const _ok: ValidationResult = { valid: true };
    const _err: ValidationResult = { valid: false, errors: ["bad input"] };
    expect(true).toBe(true);
  });

  it("Actor is assignable from a PrimitiveActorContext-shaped object", () => {
    const _actor: Actor = { userId: "u1", source: "ui", actorType: "human" };
    expect(true).toBe(true);
  });

  it("an object implementing { typeId, install, update, uninstall, archive, restore } is assignable to ExtensionTypeHandler (validate is optional)", () => {
    const _handler: ExtensionTypeHandler = {
      typeId: "test",
      async install(_ref, _actor) {},
      async update(_ref, _actor) {},
      async uninstall(_ref, _actor) {},
      async archive(_ref, _actor) {},
      async restore(_ref, _actor) {},
    };
    expect(typeof _handler.typeId).toBe("string");
    expect(typeof _handler.install).toBe("function");
    expect(typeof _handler.update).toBe("function");
    expect(typeof _handler.uninstall).toBe("function");
    expect(typeof _handler.archive).toBe("function");
    expect(typeof _handler.restore).toBe("function");
    expect(_handler.validate).toBeUndefined();
  });
});
