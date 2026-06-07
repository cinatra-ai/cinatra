// Hermetic vitest for the pure provision-decision helpers.
//
// Pure module under test. NO Docker, NO Tailscale, NO network. The
// DB-url / schema derivation cases use the REAL `deriveDevTailscaleHostname`
// (it is pure) so this suite also pins the prediction==registered contract
// against the single source of truth in connector-tailscale.
//
// Hostname-extraction semantics: input must end in `.ts.net` (after stripping any
// `https://` scheme + trailing `/`) AND have >=1 hostname label before
// a non-empty tailnet portion; otherwise → "" → fail-loud (no write).

import { describe, it, expect } from "vitest";

import {
  TailscaleProvisionError,
  extractTailscaleHostnameSegment,
  verifyRegisteredHostnameMatchesPrediction,
  shouldWritePublicBaseUrl,
} from "../src/tailscale-provision.mjs";

// --- extractTailscaleHostnameSegment --------------------------------------

describe("extractTailscaleHostnameSegment", () => {
  it("strips a trailing dot from a full Self.DNSName", () => {
    expect(
      extractTailscaleHostnameSegment("cinatra-clone-foo.tailnet000.ts.net."),
    ).toBe("cinatra-clone-foo");
  });

  it("handles a Self.DNSName with no trailing dot", () => {
    expect(
      extractTailscaleHostnameSegment("cinatra-clone-foo.tailnet000.ts.net"),
    ).toBe("cinatra-clone-foo");
  });

  it("accepts a full https:// Funnel URL form", () => {
    expect(
      extractTailscaleHostnameSegment(
        "https://cinatra-main.tailnet000.ts.net",
      ),
    ).toBe("cinatra-main");
  });

  it("strips an https:// scheme AND a trailing slash", () => {
    expect(
      extractTailscaleHostnameSegment(
        "https://cinatra-clone-foo.tailnet000.ts.net/",
      ),
    ).toBe("cinatra-clone-foo");
    expect(
      extractTailscaleHostnameSegment(
        "https://cinatra-clone-foo.tailnet000.ts.net./",
      ),
    ).toBe("cinatra-clone-foo");
  });

  it("preserves a collision -1 suffix (caller compares)", () => {
    expect(
      extractTailscaleHostnameSegment(
        "cinatra-clone-foo-1.tailnet000.ts.net",
      ),
    ).toBe("cinatra-clone-foo-1");
  });

  it("normalises a tailnet name containing dots (dotted-tailnet FQDN)", () => {
    // tailnet `acme.github` → FQDN `host.acme.github.ts.net`; the segment
    // is still everything before the FIRST dot, tailnet is NOT compared.
    expect(
      extractTailscaleHostnameSegment(
        "cinatra-clone-x.acme.github.ts.net.",
      ),
    ).toBe("cinatra-clone-x");
    expect(
      extractTailscaleHostnameSegment(
        "https://cinatra-clone-x.acme.github.ts.net",
      ),
    ).toBe("cinatra-clone-x");
  });

  it("returns '' for empty / null / undefined without throwing", () => {
    expect(extractTailscaleHostnameSegment("")).toBe("");
    expect(extractTailscaleHostnameSegment(null)).toBe("");
    expect(extractTailscaleHostnameSegment(undefined)).toBe("");
  });

  it("returns '' for a bare non-URL garbage token", () => {
    // No `.ts.net` suffix → mismatch → fail-loud (no write).
    expect(extractTailscaleHostnameSegment("garbage")).toBe("");
  });

  it("returns '' when the input has no .ts.net suffix", () => {
    expect(extractTailscaleHostnameSegment("cinatra-clone-foo.example.com")).toBe(
      "",
    );
    expect(
      extractTailscaleHostnameSegment("https://cinatra-clone-foo.fly.dev"),
    ).toBe("");
  });

  it("returns '' when there are zero hostname labels before the tailnet", () => {
    // `host.ts.net` = only a host, NO tailnet label before `.ts.net`.
    expect(extractTailscaleHostnameSegment("host.ts.net")).toBe("");
    expect(extractTailscaleHostnameSegment("host.ts.net.")).toBe("");
    expect(extractTailscaleHostnameSegment("https://host.ts.net")).toBe("");
    // Bare suffix / scheme / dot-only tokens have no segment either.
    expect(extractTailscaleHostnameSegment(".ts.net")).toBe("");
    expect(extractTailscaleHostnameSegment("ts.net")).toBe("");
    expect(extractTailscaleHostnameSegment("https://")).toBe("");
    expect(extractTailscaleHostnameSegment(".")).toBe("");
  });
});

// --- verifyRegisteredHostnameMatchesPrediction ----------------------------

describe("verifyRegisteredHostnameMatchesPrediction", () => {
  it("ok:true when heavy-clone DB url matches the prediction", async () => {
    // SUPABASE_DB_URL `…/cinatra_clone_foo` → predicted `cinatra-clone-foo`.
    const res = await verifyRegisteredHostnameMatchesPrediction({
      registered: "cinatra-clone-foo.tailnet000.ts.net.",
      dbUrl: "postgres://u:p@h:5432/cinatra_clone_foo",
      schema: "cinatra",
    });
    expect(res.ok).toBe(true);
    expect(res.predicted).toBe("cinatra-clone-foo");
    expect(res.registered).toBe("cinatra-clone-foo");
    expect(res.error).toBeUndefined();
  });

  it("ok:true when light-worktree schema matches the prediction", async () => {
    // SUPABASE_SCHEMA `cinatra_wt` → predicted `cinatra-wt`.
    const res = await verifyRegisteredHostnameMatchesPrediction({
      registered: "https://cinatra-wt.tailnet000.ts.net",
      dbUrl: "postgres://u:p@h:5432/cinatra",
      schema: "cinatra_wt",
    });
    expect(res.ok).toBe(true);
    expect(res.predicted).toBe("cinatra-wt");
    expect(res.registered).toBe("cinatra-wt");
  });

  it("ok:true with a dotted tailnet — only the hostname label is compared", async () => {
    // Registered FQDN tailnet `acme.github`; prediction compares the
    // hostname label only; the tailnet is not compared.
    const res = await verifyRegisteredHostnameMatchesPrediction({
      registered: "https://cinatra-clone-foo.acme.github.ts.net",
      dbUrl: "postgres://u:p@h:5432/cinatra_clone_foo",
      schema: "cinatra",
    });
    expect(res.ok).toBe(true);
    expect(res.predicted).toBe("cinatra-clone-foo");
    expect(res.registered).toBe("cinatra-clone-foo");
  });

  it("ok:false + typed hostname_collision error on a -1 suffix mismatch", async () => {
    const res = await verifyRegisteredHostnameMatchesPrediction({
      registered: "cinatra-clone-foo-1.tailnet000.ts.net.",
      dbUrl: "postgres://u:p@h:5432/cinatra_clone_foo",
      schema: "cinatra",
    });
    expect(res.ok).toBe(false);
    expect(res.predicted).toBe("cinatra-clone-foo");
    expect(res.registered).toBe("cinatra-clone-foo-1");
    expect(res.error).toBeInstanceOf(TailscaleProvisionError);
    expect(res.error).toBeInstanceOf(Error);
    expect(res.error.code).toBe("tailscale.hostname_collision");
    // Message must name BOTH hostnames so the operator can see the drift.
    expect(res.error.message).toContain("cinatra-clone-foo");
    expect(res.error.message).toContain("cinatra-clone-foo-1");
    expect(res.error.name).toBe("TailscaleProvisionError");
  });

  it("ok:false + typed hostname_unresolved error when registered is unparseable", async () => {
    const res = await verifyRegisteredHostnameMatchesPrediction({
      registered: "",
      dbUrl: "postgres://u:p@h:5432/cinatra_clone_foo",
      schema: "cinatra",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(TailscaleProvisionError);
    expect(res.error.code).toBe("tailscale.hostname_unresolved");
    expect(res.registered).toBe("");
    expect(res.predicted).toBe("cinatra-clone-foo");
  });

  it("ok:false + hostname_unresolved when registered has no .ts.net suffix", async () => {
    const res = await verifyRegisteredHostnameMatchesPrediction({
      registered: "garbage",
      dbUrl: "postgres://u:p@h:5432/cinatra_clone_foo",
      schema: "cinatra",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(TailscaleProvisionError);
    expect(res.error.code).toBe("tailscale.hostname_unresolved");
    expect(res.registered).toBe("");
  });

  it("the returned error is ALWAYS a typed instance, never a bare Error", async () => {
    for (const registered of [
      "",
      "cinatra-clone-foo-1.x.ts.net",
      "garbage",
      "host.ts.net",
    ]) {
      const res = await verifyRegisteredHostnameMatchesPrediction({
        registered,
        dbUrl: "postgres://u:p@h:5432/cinatra_clone_foo",
        schema: "cinatra",
      });
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(TailscaleProvisionError);
        expect(typeof res.error.code).toBe("string");
        expect(res.error.code.startsWith("tailscale.")).toBe(true);
      }
    }
  });
});

// --- shouldWritePublicBaseUrl ---------------------------------------------

describe("shouldWritePublicBaseUrl truth table", () => {
  it("(url, ok) → write", () => {
    expect(
      shouldWritePublicBaseUrl({
        funnelUrl: "https://cinatra-clone-foo.taild.ts.net",
        hostnameCheck: { ok: true },
      }),
    ).toBe(true);
  });

  it("(no-url, ok) → skip", () => {
    expect(
      shouldWritePublicBaseUrl({ funnelUrl: "", hostnameCheck: { ok: true } }),
    ).toBe(false);
    expect(
      shouldWritePublicBaseUrl({
        funnelUrl: null,
        hostnameCheck: { ok: true },
      }),
    ).toBe(false);
  });

  it("(url, !ok) → skip", () => {
    expect(
      shouldWritePublicBaseUrl({
        funnelUrl: "https://cinatra-clone-foo.taild.ts.net",
        hostnameCheck: { ok: false },
      }),
    ).toBe(false);
  });

  it("(no-url, !ok) → skip", () => {
    expect(
      shouldWritePublicBaseUrl({
        funnelUrl: "",
        hostnameCheck: { ok: false },
      }),
    ).toBe(false);
  });

  it("treats a missing / malformed hostnameCheck as not-ok (defensive)", () => {
    expect(
      shouldWritePublicBaseUrl({ funnelUrl: "https://h.ts.net" }),
    ).toBe(false);
    expect(
      shouldWritePublicBaseUrl({
        funnelUrl: "https://h.ts.net",
        hostnameCheck: null,
      }),
    ).toBe(false);
  });

  // Regression guard: the function takes a SINGLE
  // object argument. If a future change threads a positional probe /
  // reachability arg in, `.length` becomes 2 and this fails the build.
  // This ensures the write stays decoupled from any cert-warmup probe.
  it("arity is exactly 1 (probe-decoupling structural lock)", () => {
    expect(shouldWritePublicBaseUrl.length).toBe(1);
  });
});
