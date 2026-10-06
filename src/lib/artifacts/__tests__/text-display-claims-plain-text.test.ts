// @vitest-environment node
/**
 * THE TEXT DISPLAY CLAIMS PLAIN TEXT (cinatra#3319, acceptance item 4: "the text
 * pack declares `text/plain` beside `text/csv`").
 *
 * The pack half is the Text extension's own declaration — its manifest's
 * `cinatra.artifact.ui.renderers.detail.representations` — made in the Text
 * extension's own repository. This suite is the application half: it reads the
 * claim where the host consumes it, through the generated build map the generator
 * copies the manifest into and through the boot registrar that binds every
 * `required` entry's representations to the exact allowlisted MIMEs. It asserts no
 * claim of its own beyond the package id and the two MIME names.
 */
import { describe, expect, it } from "vitest";

import { systemRepresentationProviderSpecs } from "@/lib/artifacts/system-artifact-renderer-registrar";
import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

const TEXT_PKG = "@cinatra-ai/text-artifact";
const TEXT_KEY = `${TEXT_PKG}::detail`;
const PLAIN = "text/plain";
const CSV = "text/csv";

describe("cinatra#3319 item 4 — the text display claims plain text beside CSV", () => {
  it("the build map's text detail entry declares text/plain beside text/csv as a required base", () => {
    const entry = GENERATED_ARTIFACT_RENDERERS[TEXT_KEY];
    expect(entry).toBeDefined();
    expect(entry.representations).toEqual([PLAIN, CSV]);
    expect(entry.resolution).toBe("required");
  });

  it("exactly one build-map entry claims text/plain, and it is the text detail entry", () => {
    const claimants = Object.entries(GENERATED_ARTIFACT_RENDERERS)
      .filter(([, entry]) => entry.representations.includes(PLAIN))
      .map(([key]) => key);
    expect(claimants).toEqual([TEXT_KEY]);
  });

  it("the boot registrar binds exactly one text/plain provider, the text base's detail slot", () => {
    const plainSpecs = systemRepresentationProviderSpecs().filter((spec) => spec.pattern === PLAIN);
    expect(plainSpecs).toEqual([{ packageName: TEXT_PKG, pattern: PLAIN, slot: "detail" }]);
  });
});
