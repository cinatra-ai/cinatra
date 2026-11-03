/**
 * cinatra#4223 — the screenshot tool's seam shaper.
 *
 * The CALLER names the extension the screenshot belongs to, its title, the page
 * to capture and its own node id; this shaper is where a call that names any of
 * them improperly is refused before the tool reads a site record. The url must
 * be an absolute http(s) url here; whether its origin is a connect-registered
 * site is the tool's own check.
 */
import { describe, expect, it } from "vitest";

import { shapeArtifactPageCaptureInput } from "../artifact-page-capture-shaper";

const base = {
  extension: "@cinatra-ai/screenshot-artifact",
  title: "The home page",
  url: "https://blog.example.com/about/",
  node_id: "capture_page",
};

describe("cinatra#4223 shapeArtifactPageCaptureInput", () => {
  it("shapes the extension, the title, the url and the node identity, trimmed", () => {
    expect(
      shapeArtifactPageCaptureInput({
        extension: "  @cinatra-ai/screenshot-artifact ",
        title: " The home page\n",
        url: "\thttps://blog.example.com/about/ ",
        node_id: " capture_page ",
      }),
    ).toEqual({
      extension: "@cinatra-ai/screenshot-artifact",
      title: "The home page",
      url: "https://blog.example.com/about/",
      nodeId: "capture_page",
    });
  });

  it.each(["extension", "title", "url", "node_id"])(
    "refuses a missing or blank %s by name",
    (field) => {
      const missing: Record<string, unknown> = { ...base };
      delete missing[field];
      expect(() => shapeArtifactPageCaptureInput(missing)).toThrow(
        `artifact_page_capture input.${field} must be a non-empty string (got undefined)`,
      );
      expect(() => shapeArtifactPageCaptureInput({ ...base, [field]: "   " })).toThrow(
        `artifact_page_capture input.${field} must be a non-empty string (got "   ")`,
      );
      expect(() => shapeArtifactPageCaptureInput({ ...base, [field]: 42 })).toThrow(
        `artifact_page_capture input.${field} must be a non-empty string (got 42)`,
      );
    },
  );

  it.each([
    ["a relative url", "/about/"],
    ["a scheme-relative url", "//blog.example.com/about/"],
    ["a non-http(s) scheme", "ftp://blog.example.com/about/"],
    ["a file url", "file:///etc/hosts"],
    ["a script url", "javascript:void(0)"],
  ])("refuses %s", (_label, url) => {
    expect(() => shapeArtifactPageCaptureInput({ ...base, url })).toThrow(
      "artifact_page_capture input.url must be an absolute http(s) url",
    );
  });

  it("admits an http url on a loopback origin", () => {
    expect(
      shapeArtifactPageCaptureInput({ ...base, url: "http://localhost:4223/" }).url,
    ).toBe("http://localhost:4223/");
  });
});
