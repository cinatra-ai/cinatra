import { describe, it, expect } from "vitest";
import {
  normalizeServerModule,
  isSdkAbiRangeSatisfied,
  resolveServerEntry,
  SDK_EXTENSIONS_ABI_VERSION,
} from "../register";

describe("normalizeServerModule — preserves the WHOLE imported shape", () => {
  it("lifts top-level register/bootstrap/destroy into a server entry", () => {
    const register = () => {};
    const bootstrap = () => {};
    const destroy = () => {};
    const mod = normalizeServerModule("@cinatra-ai/a", { register, bootstrap, destroy });
    expect(mod).not.toBeNull();
    const server = resolveServerEntry(mod!);
    expect(server?.register).toBe(register);
    expect(server?.bootstrap).toBe(bootstrap);
    expect(server?.destroy).toBe(destroy);
    expect(mod!.abiVersion).toBe(SDK_EXTENSIONS_ABI_VERSION);
  });

  it("carries the config gate", () => {
    const mod = normalizeServerModule("@cinatra-ai/a", { register: () => {}, config: { enabled: false } });
    expect(mod?.config?.enabled).toBe(false);
  });

  it("preserves a split `server` entry verbatim (incl. bootstrap/destroy)", () => {
    const server = { register: () => {}, bootstrap: () => {}, destroy: () => {} };
    const mod = normalizeServerModule("@cinatra-ai/a", { server, config: { enabled: true } });
    expect(resolveServerEntry(mod!)).toBe(server);
    expect(mod?.config?.enabled).toBe(true);
  });

  it("supports a `default` export that is an ExtensionModule (defineExtension result)", () => {
    const register = () => {};
    const mod = normalizeServerModule("@cinatra-ai/a", { default: { register } });
    expect(resolveServerEntry(mod!)?.register).toBe(register);
  });

  it("returns null when no register function is resolvable", () => {
    expect(normalizeServerModule("@cinatra-ai/a", {})).toBeNull();
    expect(normalizeServerModule("@cinatra-ai/a", { register: 123 })).toBeNull();
    expect(normalizeServerModule("@cinatra-ai/a", null)).toBeNull();
    expect(normalizeServerModule("@cinatra-ai/a", "nope")).toBeNull();
  });

  it("ignores a non-function bootstrap/destroy (no crash, omitted)", () => {
    const mod = normalizeServerModule("@cinatra-ai/a", { register: () => {}, bootstrap: "no", destroy: 5 });
    const server = resolveServerEntry(mod!);
    expect(server?.bootstrap).toBeUndefined();
    expect(server?.destroy).toBeUndefined();
  });
});

describe("isSdkAbiRangeSatisfied — conservative compat policy", () => {
  const HOST = "1.0.0";
  it("permits unpinned ranges (absent / empty / *)", () => {
    expect(isSdkAbiRangeSatisfied(HOST, undefined)).toBe(true);
    expect(isSdkAbiRangeSatisfied(HOST, null)).toBe(true);
    expect(isSdkAbiRangeSatisfied(HOST, "")).toBe(true);
    expect(isSdkAbiRangeSatisfied(HOST, "  ")).toBe(true);
    expect(isSdkAbiRangeSatisfied(HOST, "*")).toBe(true);
  });
  it("permits an exact host match", () => {
    expect(isSdkAbiRangeSatisfied(HOST, "1.0.0")).toBe(true);
  });
  it("permits major-pinning forms that admit the host major", () => {
    for (const r of ["^1", "~1", ">=1", ">=1.0.0", "1.x", "1.0", "1"]) {
      expect(isSdkAbiRangeSatisfied(HOST, r)).toBe(true);
    }
  });
  it("FAILS CLOSED on a different major or an unrecognized range", () => {
    expect(isSdkAbiRangeSatisfied(HOST, "^2")).toBe(false);
    expect(isSdkAbiRangeSatisfied(HOST, "2.x")).toBe(false);
    expect(isSdkAbiRangeSatisfied(HOST, "2")).toBe(false);
    expect(isSdkAbiRangeSatisfied(HOST, "garbage")).toBe(false);
    expect(isSdkAbiRangeSatisfied(HOST, "<1.0.0")).toBe(false);
  });
  it("does NOT fail open on multi-digit majors (^10 is not host major 1)", () => {
    // Regression: a prefix check (`startsWith("^1")`) wrongly accepted ^10/~10/>=10.
    for (const r of ["^10", "~10", ">=10.0.0", "10", "10.x", "19.2"]) {
      expect(isSdkAbiRangeSatisfied(HOST, r), r).toBe(false);
    }
  });
  it("FAILS CLOSED on a SAME-MAJOR but NEWER minor/patch the host can't satisfy", () => {
    // host 1.0.0 must REFUSE ranges requiring > 1.0.0, even within major 1.
    for (const r of ["1.1.0", "^1.1", "^1.1.0", "~1.1", "1.0.1", ">=1.1.0", ">=1.0.1", ">1.0.0"]) {
      expect(isSdkAbiRangeSatisfied(HOST, r), r).toBe(false);
    }
  });
  it("is HOST-GENERIC: ^1.0.0 is satisfied by a newer same-major host; ~/exact are not", () => {
    expect(isSdkAbiRangeSatisfied("1.5.0", "^1.0.0")).toBe(true); // ^1 admits 1.5.0
    expect(isSdkAbiRangeSatisfied("1.5.0", "^1")).toBe(true);
    expect(isSdkAbiRangeSatisfied("1.5.0", ">=1.0.0")).toBe(true);
    expect(isSdkAbiRangeSatisfied("1.5.0", "~1.0")).toBe(false); // ~1.0 = [1.0.0, 1.1.0)
    expect(isSdkAbiRangeSatisfied("1.5.0", "1.0.0")).toBe(false); // exact
    expect(isSdkAbiRangeSatisfied("1.5.0", "1.5.0")).toBe(true);
    expect(isSdkAbiRangeSatisfied("2.0.0", "^1")).toBe(false); // next major
  });
});
