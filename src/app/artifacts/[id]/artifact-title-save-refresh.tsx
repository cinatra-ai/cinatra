"use client";

import { useEffect, useState } from "react";

import { ARTIFACT_TITLE_SAVED_EVENT } from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

/**
 * THE HEADING'S TITLE FOLLOWS A SAVED TITLE (cinatra#3886).
 *
 * The heading above a display starts from the title the server drew from the
 * artifact's row. The edit channel announces every saved title, with the title
 * itself, for every display alike; this listens for that announcement for its
 * own artifact and shows the saved title at once. The page never re-reads
 * itself under a display's edit, because a re-read hands the open display a
 * capability minted on a newer revision in the middle of its edit, and a
 * display that keys its edit session by its base revision would drop the text
 * the reader has typed. A saved title that trims to nothing shows the same
 * untitled reading the server draws.
 */
export function ArtifactHeadingTitle({
  artifactId,
  title,
  untitledTitle,
}: {
  artifactId: string;
  title: string;
  untitledTitle: string;
}) {
  // The saved title, kept with the artifact and the server title it was saved
  // over, so a later server render that hands a different title shows that
  // title instead, and the saved title is dropped for good when it does.
  const [saved, setSaved] = useState<{ artifactId: string; over: string; title: string } | null>(null);
  const current = saved !== null && saved.artifactId === artifactId && saved.over === title;
  if (saved !== null && !current) setSaved(null);

  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ artifactId?: unknown; title?: unknown }>).detail;
      if (detail?.artifactId !== artifactId || typeof detail.title !== "string") return;
      const named = detail.title.trim();
      setSaved({ artifactId, over: title, title: named === "" ? untitledTitle : named });
    };
    window.addEventListener(ARTIFACT_TITLE_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(ARTIFACT_TITLE_SAVED_EVENT, onSaved);
  }, [artifactId, title, untitledTitle]);

  return <span>{current ? saved.title : title}</span>;
}
