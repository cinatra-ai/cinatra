/**
 * normalizeManifestLogo (cinatra#1325) — the installed-extension card resolves
 * its icon tile from the extension's OWN logo (`cinatra.logo`/`manifest.logo`),
 * the same `STATIC_EXTENSION_MANIFEST` source `/connectors` uses, so a
 * connector-kind card shows the connector's logo instead of the generic kind
 * emblem. This is the pure resolution tier:
 *
 *   - logo PRESENT   → the sanitized inline-SVG data URI passes through, and
 *                      becomes the card's `iconUrl` (winning over the emblem).
 *   - logo ABSENT    → null → the card falls back to the kind emblem.
 *   - logo MALFORMED → null → the card falls back to the kind emblem (a broken
 *                      generated record never binds a broken `<img src>`).
 *
 * The runtime "present-but-unloadable" tail (an `<img>` load error degrading to
 * the emblem) is covered separately by the ExtensionCardIconImage jsdom test;
 * this file covers URL *presence*, matching the normalizeCatalogAssetUrl split.
 */
import { describe, expect, it } from "vitest";

import {
  installedCardIconUrl,
  normalizeManifestLogo,
} from "../screens/installed-card-icon";

const LOGO = "data:image/svg+xml,<svg/>";

describe("normalizeManifestLogo — logo present", () => {
  it("passes a manifest inline-SVG data URI through verbatim (the connector logo, not the emblem)", () => {
    const dataUri =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    expect(normalizeManifestLogo(dataUri)).toBe(dataUri);
  });

  it("preserves a non-empty logo without trimming its interior", () => {
    expect(normalizeManifestLogo("data:image/svg+xml,<svg id='a b'/>")).toBe(
      "data:image/svg+xml,<svg id='a b'/>",
    );
  });
});

describe("normalizeManifestLogo — logo absent (generic fallback)", () => {
  it("null → null (no manifest logo declared; card falls back to the kind emblem)", () => {
    expect(normalizeManifestLogo(null)).toBeNull();
  });

  it("undefined → null (a package with no record / no logo field)", () => {
    expect(normalizeManifestLogo(undefined)).toBeNull();
  });
});

describe("normalizeManifestLogo — malformed logo value (generic fallback)", () => {
  it("empty string → null", () => {
    expect(normalizeManifestLogo("")).toBeNull();
  });

  it("whitespace-only string → null", () => {
    expect(normalizeManifestLogo("   \t\n ")).toBeNull();
  });

  it("non-string values (number / object / array / boolean) → null", () => {
    expect(normalizeManifestLogo(42)).toBeNull();
    expect(normalizeManifestLogo({ url: "x" })).toBeNull();
    expect(normalizeManifestLogo(["data:image/svg+xml,<svg/>"])).toBeNull();
    expect(normalizeManifestLogo(true)).toBeNull();
  });
});

describe("installedCardIconUrl — greyed cards keep the muted emblem (cinatra#957)", () => {
  it("an ACTIVE card surfaces the extension's own logo", () => {
    expect(installedCardIconUrl(LOGO, { greyed: false })).toBe(LOGO);
  });

  it("a GREYED (archived / needs-review) card resolves to null → muted kind emblem", () => {
    // A full-colour logo image would defeat the fully-greyed treatment, so the
    // tile must fall back to the muted emblem on a greyed card (codex-caught).
    expect(installedCardIconUrl(LOGO, { greyed: true })).toBeNull();
  });

  it("a null logo stays null regardless of greyed state", () => {
    expect(installedCardIconUrl(null, { greyed: false })).toBeNull();
    expect(installedCardIconUrl(null, { greyed: true })).toBeNull();
  });
});
