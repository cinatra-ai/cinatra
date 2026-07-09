import { describe, it, expect } from "vitest";

import { flashHref, type FlashParams } from "../flash-href";

describe("flashHref", () => {
  it("appends a single error code to a bare path", () => {
    expect(flashHref("/setup/name", { error: "namespace-taken" })).toBe(
      "/setup/name?error=namespace-taken",
    );
  });

  it("appends a single notice code", () => {
    expect(flashHref("/connectors/acme/setup", { notice: "added" })).toBe(
      "/connectors/acme/setup?notice=added",
    );
  });

  it("writes both notice and error when both are provided", () => {
    const out = flashHref("/x", { notice: "saved", error: "partial" });
    const qs = new URL(out, "http://h.invalid").searchParams;
    expect(qs.get("notice")).toBe("saved");
    expect(qs.get("error")).toBe("partial");
  });

  it("drops undefined keys (no params returns the base unchanged)", () => {
    expect(flashHref("/setup/name", {})).toBe("/setup/name");
    expect(flashHref("/setup/name")).toBe("/setup/name");
    const partial: FlashParams = { error: undefined, notice: "ok" };
    expect(flashHref("/p", partial)).toBe("/p?notice=ok");
  });

  it("preserves an existing query string on the base", () => {
    const out = flashHref("/connectors/acme/setup?tab=connect", { error: "invalid-url" });
    const url = new URL(out, "http://h.invalid");
    expect(url.pathname).toBe("/connectors/acme/setup");
    expect(url.searchParams.get("tab")).toBe("connect");
    expect(url.searchParams.get("error")).toBe("invalid-url");
  });

  it("preserves the hash fragment", () => {
    expect(flashHref("/setup/name#section", { error: "x" })).toBe(
      "/setup/name?error=x#section",
    );
  });

  it("REPLACES a stale flash code instead of duplicating it (set, not append)", () => {
    const out = flashHref("/p?error=old", { error: "new" });
    const qs = new URL(out, "http://h.invalid").searchParams;
    // exactly one error param, and it is the new value
    expect(qs.getAll("error")).toEqual(["new"]);
  });

  it("url-encodes code values", () => {
    const out = flashHref("/p", { error: "a b/c" });
    expect(out).toBe("/p?error=a+b%2Fc");
    expect(new URL(out, "http://h.invalid").searchParams.get("error")).toBe("a b/c");
  });

  it("keeps a full absolute URL absolute (origin preserved)", () => {
    const out = flashHref("https://host.example/setup?keep=1", { notice: "done" });
    const url = new URL(out);
    expect(url.origin).toBe("https://host.example");
    expect(url.pathname).toBe("/setup");
    expect(url.searchParams.get("keep")).toBe("1");
    expect(url.searchParams.get("notice")).toBe("done");
  });

  it("is pure — does not import next/redirect (no throw, returns a string)", () => {
    // A redirect() wrapper would throw the Next redirect sentinel; flashHref
    // must simply return the string.
    expect(typeof flashHref("/x", { error: "e" })).toBe("string");
  });
});
