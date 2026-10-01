"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { ARTIFACT_TITLE_SAVED_EVENT } from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

/**
 * THE PAGE'S RE-READ AFTER A SAVED TITLE (cinatra#3886).
 *
 * The heading above a display is drawn on the server from the artifact's row at
 * request time, so a title a display saves in place leaves it stale until a
 * reload. The edit channel announces every saved title, for every display
 * alike; this listens for that announcement for its own artifact and re-reads
 * the page once, by the same road the application uses after a stored change.
 */
export function ArtifactTitleSaveRefresh({ artifactId }: { artifactId: string }) {
  const router = useRouter();

  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ artifactId?: string }>).detail;
      if (detail?.artifactId === artifactId) router.refresh();
    };
    window.addEventListener(ARTIFACT_TITLE_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(ARTIFACT_TITLE_SAVED_EVENT, onSaved);
  }, [artifactId, router]);

  return null;
}
