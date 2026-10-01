// @vitest-environment jsdom
// cinatra#3886 — THE ARTIFACT PAGE'S HEADING FOLLOWS A TITLE A DISPLAY SAVES.
//
// The acceptance this file pins: "after a display has saved a new title through
// the artifact's edit road, the artifact page's heading shows the saved title
// without a reload", for every display alike, "a test pins it at the page's
// level". The heading is drawn on the server, so the page re-reads itself once
// after the edit channel's one title-save road answers saved.

import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  ARTIFACT_EDIT_IDLE_PAUSE_MS,
  ARTIFACT_EDIT_TEXT_CAP_BYTES,
  saveArtifactEdit,
  saveArtifactTitleEdit,
} from "@cinatra-ai/sdk-extensions/artifact-edit-channel";
import { grantArtifactEdit } from "@/lib/artifacts/artifact-renderer-props";

import { ArtifactTitleSaveRefresh } from "../artifact-title-save-refresh";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
}));

function grant(artifactId: string) {
  return grantArtifactEdit({
    artifactId,
    baseRevisionId: "rev-1",
    saveUrl: `/api/artifacts/${artifactId}/edit`,
    idlePauseMs: ARTIFACT_EDIT_IDLE_PAUSE_MS,
    capBytes: ARTIFACT_EDIT_TEXT_CAP_BYTES,
  });
}

const ONE = grant("artifact-1");
const TWO = grant("artifact-2");

function answer(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

const SAVED = { outcome: "saved", revisionId: "rev-2", revision: 2 };

afterEach(() => {
  cleanup();
  nav.refresh.mockReset();
  vi.restoreAllMocks();
});

describe("the artifact page's heading follows a saved title", () => {
  it("H1 after a display saves a new title through the edit road, the page re-reads once", async () => {
    render(<ArtifactTitleSaveRefresh artifactId="artifact-1" />);
    const sent = await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(SAVED) });
    expect(sent).toEqual(SAVED);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("H2 the page mounts the re-read in its heading, for every artifact it opens", () => {
    const source = readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    const element = "<ArtifactTitleSaveRefresh artifactId={id} />";
    expect(source.split(element).length - 1).toBe(1);
    const at = source.indexOf(element);
    expect(source.lastIndexOf("titleContent={", at)).toBeGreaterThan(-1);
    expect(source.indexOf("meta=", at)).toBeGreaterThan(at);
    expect(source.lastIndexOf("titleContent={", at)).toBeLessThan(at);
    expect(source.lastIndexOf("meta=", at)).toBeLessThan(source.lastIndexOf("titleContent={", at));
  });

  it("H3 no re-read when the title save is answered unchanged, stale, refused or with a 500 status", async () => {
    const answers: Array<[unknown, number]> = [
      [{ outcome: "unchanged", revisionId: "rev-1" }, 200],
      [
        {
          outcome: "stale",
          latestRevisionId: "rev-3",
          latestRevision: 3,
          text: "Newer",
          title: "Newer title",
        },
        200,
      ],
      [{ outcome: "refused", reason: "no-write-rights" }, 200],
      [{ outcome: "failed", reason: "server" }, 500],
    ];
    render(<ArtifactTitleSaveRefresh artifactId="artifact-1" />);
    for (const [body, status] of answers) {
      await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(body, status) });
    }
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H4 no re-read when a text save is answered saved", async () => {
    render(<ArtifactTitleSaveRefresh artifactId="artifact-1" />);
    const sent = await saveArtifactEdit(ONE, "New text", { fetch: answer(SAVED) });
    expect(sent).toEqual(SAVED);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H5 no re-read when another artifact's title is saved", async () => {
    render(<ArtifactTitleSaveRefresh artifactId="artifact-1" />);
    await saveArtifactTitleEdit(TWO, "The subject", { fetch: answer(SAVED) });
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H6 no re-read for a title saved after the component was unmounted", async () => {
    const view = render(<ArtifactTitleSaveRefresh artifactId="artifact-1" />);
    view.unmount();
    await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(SAVED) });
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
