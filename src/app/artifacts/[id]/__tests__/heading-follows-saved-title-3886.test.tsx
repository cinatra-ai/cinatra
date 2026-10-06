// @vitest-environment jsdom
// cinatra#3886 — THE ARTIFACT PAGE'S HEADING FOLLOWS A TITLE A DISPLAY SAVES.
//
// The acceptance this file pins: "after a display has saved a new title through
// the artifact's edit road, the artifact page's heading shows the saved title
// without a reload", for every display alike, "a test pins it at the page's
// level". The heading's title follows the saved title from the edit channel's
// announcement, and the page never re-reads itself, so the text a reader has
// typed into a display survives a title save.

import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import {
  ARTIFACT_EDIT_IDLE_PAUSE_MS,
  ARTIFACT_TITLE_SAVED_EVENT,
  ARTIFACT_EDIT_TEXT_CAP_BYTES,
  saveArtifactEdit,
  saveArtifactTitleEdit,
} from "@cinatra-ai/sdk-extensions/artifact-edit-channel";
import { Textarea } from "@/components/ui/textarea";
import { grantArtifactEdit } from "@/lib/artifacts/artifact-renderer-props";

import { ArtifactHeadingTitle } from "../artifact-title-save-refresh";

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

// A DISPLAY THAT KEEPS ONE EDIT SESSION PER BASE REVISION: the typed text lives
// in local state for the session keyed by `revisionId` and is reset, during
// render, when that key changes.
function FixtureDisplay({ revisionId }: { revisionId: string }) {
  const [session, setSession] = React.useState(revisionId);
  const [typed, setTyped] = React.useState<string | null>(null);
  if (session !== revisionId) {
    setSession(revisionId);
    setTyped(null);
  }
  return (
    <Textarea
      aria-label="body"
      value={typed ?? "Original body"}
      onChange={(event) => setTyped(event.target.value)}
    />
  );
}

// A PAGE WHOSE RE-READ HANDS THE DISPLAY A NEWER BASE REVISION: its revision
// starts at rev-1 and moves to whatever the case's re-read gives it.
const pageRevision: { move: (revisionId: string) => void } = { move: () => {} };
function FixturePage({ heading }: { heading: React.ReactNode }) {
  const [revisionId, setRevisionId] = React.useState("rev-1");
  React.useEffect(() => {
    pageRevision.move = setRevisionId;
  }, []);
  return (
    <div>
      <h1>{heading}</h1>
      <FixtureDisplay revisionId={revisionId} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  nav.refresh.mockReset();
  vi.restoreAllMocks();
});

describe("the artifact page's heading follows a saved title", () => {
  it("H1 after a display saves a new title through the edit road, the heading shows it without a re-read", async () => {
    const view = render(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    expect(view.container.textContent).toBe("Old subject");
    let sent: unknown;
    await act(async () => {
      sent = await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(SAVED) });
    });
    expect(sent).toEqual(SAVED);
    expect(view.container.textContent).toBe("The subject");
    expect(nav.refresh).not.toHaveBeenCalled();
    view.rerender(<ArtifactHeadingTitle artifactId="artifact-1" title="Newer server title" untitledTitle="artifact…" />);
    expect(view.container.textContent).toBe("Newer server title");
    view.rerender(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    expect(view.container.textContent).toBe("Old subject");
  });

  it("H2 the page draws the heading's title through the element, for every artifact it opens", () => {
    const source = readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    const element = "<ArtifactHeadingTitle";
    expect(source.split(element).length - 1).toBe(1);
    const at = source.indexOf(element);
    expect(source.lastIndexOf("titleContent={", at)).toBeGreaterThan(-1);
    expect(source.indexOf("meta=", at)).toBeGreaterThan(at);
    expect(source.lastIndexOf("titleContent={", at)).toBeLessThan(at);
    expect(source.lastIndexOf("meta=", at)).toBeLessThan(source.lastIndexOf("titleContent={", at));
    expect(source).not.toContain("ArtifactTitleSaveRefresh");
    expect(source).not.toContain("<span>{title}</span>");
    const moduleSource = readFileSync(path.join(__dirname, "..", "artifact-title-save-refresh.tsx"), "utf8");
    expect(moduleSource).not.toContain("useRouter");
    expect(moduleSource).not.toContain(".refresh(");
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
    const view = render(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    for (const [body, status] of answers) {
      await act(async () => {
        await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(body, status) });
      });
    }
    expect(view.container.textContent).toBe("Old subject");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H4 no re-read when a text save is answered saved", async () => {
    const view = render(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    let sent: unknown;
    await act(async () => {
      sent = await saveArtifactEdit(ONE, "New text", { fetch: answer(SAVED) });
    });
    expect(sent).toEqual(SAVED);
    expect(view.container.textContent).toBe("Old subject");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H5 no re-read when another artifact's title is saved", async () => {
    const view = render(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    await act(async () => {
      await saveArtifactTitleEdit(TWO, "The subject", { fetch: answer(SAVED) });
    });
    expect(view.container.textContent).toBe("Old subject");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H6 no re-read for a title saved after the component was unmounted", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const view = render(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    const heading = view.container.querySelector("span");
    view.unmount();
    const listener = added.mock.calls.find(([type]) => type === ARTIFACT_TITLE_SAVED_EVENT)?.[1];
    expect(listener).toBeDefined();
    expect(removed).toHaveBeenCalledWith(ARTIFACT_TITLE_SAVED_EVENT, listener);
    await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(SAVED) });
    expect(heading?.textContent).toBe("Old subject");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H7 the announcement of a saved title carries the title", async () => {
    const details: unknown[] = [];
    const listen = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener(ARTIFACT_TITLE_SAVED_EVENT, listen);
    try {
      await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(SAVED) });
      expect(details).toEqual([{ artifactId: "artifact-1", revisionId: "rev-2", title: "The subject" }]);
    } finally {
      window.removeEventListener(ARTIFACT_TITLE_SAVED_EVENT, listen);
    }
  });

  it("H8 the text a reader typed into a display stays after a title save", async () => {
    nav.refresh.mockImplementation(() => pageRevision.move("rev-2"));
    const view = render(<FixturePage
        heading={<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />}
      />);
    const body = view.getByLabelText("body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Typed body" } });
    await act(async () => {
      await saveArtifactTitleEdit(ONE, "The subject", { fetch: answer(SAVED) });
    });
    expect((view.getByLabelText("body") as HTMLTextAreaElement).value).toBe("Typed body");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("H9 a saved title is shown trimmed, and a title that trims to nothing shows the untitled reading", async () => {
    const view = render(<ArtifactHeadingTitle artifactId="artifact-1" title="Old subject" untitledTitle="artifact…" />);
    await act(async () => {
      await saveArtifactTitleEdit(ONE, "  New subject  ", { fetch: answer(SAVED) });
    });
    expect(view.container.textContent).toBe("New subject");
    await act(async () => {
      await saveArtifactTitleEdit(ONE, "   ", { fetch: answer(SAVED) });
    });
    expect(view.container.textContent).toBe("artifact…");
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
