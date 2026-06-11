"use client";

// artifact-edit-binary-prompt portlet. Interactive prompt-driven regeneration
// of the parent object's binary artifact, wired to the existing generation
// primitives (config.generationPrimitive, server-side allow-listed) with
// start/cancel + polled progress. The baseline preview renders through the
// preview-safe serving route only (server-minted previewHref; allowlisted
// MIMEs only). Ref-swap modes:
//   - auto: the live pipeline swaps the parent's image refs at job
//     completion; on success the baseline simply reloads.
//   - manual: the previous {artifactId, revision} pair is snapshotted before
//     start; because the live pipeline still auto-applies on success, manual
//     mode is a post-hoc gate — "new image already applied" with
//     keep / revert-to-previous (revert goes through config.refSwapPrimitive,
//     re-validated server-side).
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  loadArtifactBaselinePortlet,
  loadBinaryGenerationStatusPortlet,
  type PortletArtifactBaseline,
  type PortletBinaryGenerationStatus,
} from "@/lib/dashboards/portlet-loaders";
import {
  startBinaryRegenerationAction,
  cancelBinaryRegenerationAction,
  applyBinaryRefSwapAction,
} from "@/lib/dashboards/portlet-actions";
import type { PortletComponentProps } from "./types";

const POLL_INTERVAL_MS = 2500;

type RefSnapshot = { artifactId: string; representationRevisionId: string };

export function ArtifactEditBinaryPromptPortlet({ config, inputs }: PortletComponentProps) {
  const parentObjectField = typeof config.parentObjectField === "string" ? config.parentObjectField : "";
  const generationPrimitive = typeof config.generationPrimitive === "string" ? config.generationPrimitive : "";
  const refSwapMode = config.refSwapMode === "auto" || config.refSwapMode === "manual" ? config.refSwapMode : null;
  const refSwapPrimitive = typeof config.refSwapPrimitive === "string" ? config.refSwapPrimitive : "";
  const objectId = typeof inputs.parentObjectId === "string" ? inputs.parentObjectId : null;

  const [baseline, setBaseline] = useState<PortletArtifactBaseline | null>(null);
  const [status, setStatus] = useState<PortletBinaryGenerationStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RefSnapshot | null>(null);
  const [loading, startLoading] = useTransition();
  const [acting, startActing] = useTransition();
  const wasRunningRef = useRef(false);
  // Stale-async guard: every load/action captures the objectId it was issued
  // for and only commits state while that id is still selected — a late
  // response for item A must never populate (or get applied to) item B.
  const currentKeyRef = useRef<string | null>(null);
  currentKeyRef.current = objectId;

  const reloadBaseline = useCallback(async () => {
    const key = objectId;
    if (!key || !parentObjectField) {
      setBaseline(null);
      return;
    }
    const res = await loadArtifactBaselinePortlet({ objectId: key, parentObjectField });
    if (currentKeyRef.current === key) setBaseline(res);
  }, [objectId, parentObjectField]);

  const refreshStatus = useCallback(async () => {
    const key = objectId;
    if (!key || !generationPrimitive) {
      setStatus(null);
      return;
    }
    const res = await loadBinaryGenerationStatusPortlet({ objectId: key, generationPrimitive });
    if (currentKeyRef.current === key) setStatus(res);
  }, [objectId, generationPrimitive]);

  // Selection change: reset everything, then load baseline + status (a run
  // may already be in flight for this item, e.g. after a page reload).
  useEffect(() => {
    setBaseline(null);
    setStatus(null);
    setPrompt("");
    setError(null);
    setSnapshot(null);
    wasRunningRef.current = false;
    if (!objectId) return;
    startLoading(async () => {
      await Promise.all([reloadBaseline(), refreshStatus()]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, parentObjectField, generationPrimitive]);

  // Poll while running (each refresh yields a fresh status object, which
  // re-arms the timeout). On the running→terminal edge, reload the baseline —
  // the pipeline swaps the parent's refs at completion.
  useEffect(() => {
    const running = status?.status === "running";
    if (wasRunningRef.current && !running) void reloadBaseline();
    wasRunningRef.current = running;
    if (!running) return;
    const t = setTimeout(() => void refreshStatus(), POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [status, refreshStatus, reloadBaseline]);

  if (!parentObjectField || !refSwapMode || !generationPrimitive || (refSwapMode === "manual" && !refSwapPrimitive)) {
    return <p className="text-sm text-muted-foreground">Misconfigured: missing binary-prompt config.</p>;
  }
  if (!objectId) return <p className="text-sm text-muted-foreground">Select an item to preview its image.</p>;
  if (loading && !baseline && !status) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const running = status?.status === "running";
  const busyWithOtherPost = status?.busyWithOtherPost === true;

  function handleRegenerate() {
    const key = objectId!;
    setError(null);
    // Manual mode: snapshot the CURRENT pair before starting so the user can
    // revert after the pipeline auto-applies the new image. The first
    // snapshot wins across repeated runs — revert always returns to the
    // last explicitly kept image.
    if (refSwapMode === "manual" && !snapshot && baseline?.representationRevisionId) {
      setSnapshot({ artifactId: baseline.artifactId, representationRevisionId: baseline.representationRevisionId });
    }
    startActing(async () => {
      const res = await startBinaryRegenerationAction({
        parentObjectId: key,
        generationPrimitive,
        prompt,
      });
      if (currentKeyRef.current !== key) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      await refreshStatus();
    });
  }

  function handleCancel() {
    const key = objectId!;
    setError(null);
    startActing(async () => {
      const res = await cancelBinaryRegenerationAction({ parentObjectId: key, generationPrimitive });
      if (currentKeyRef.current !== key) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      await refreshStatus();
    });
  }

  function handleRevert(snap: RefSnapshot) {
    const key = objectId!;
    setError(null);
    startActing(async () => {
      const res = await applyBinaryRefSwapAction({
        parentObjectId: key,
        refSwapPrimitive,
        imageArtifactId: snap.artifactId,
        imageRepresentationRevisionId: snap.representationRevisionId,
      });
      if (currentKeyRef.current !== key) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setSnapshot(null);
      setStatus(null);
      await reloadBaseline();
    });
  }

  // Manual post-hoc gate: offer keep/revert only after a run WE started
  // succeeded and the parent now points at a different artifact.
  const revertOffer =
    refSwapMode === "manual" &&
    status?.status === "succeeded" &&
    snapshot &&
    baseline &&
    baseline.artifactId !== snapshot.artifactId
      ? snapshot
      : null;

  return (
    <div className="flex flex-col gap-3">
      {baseline ? (
        <>
          {baseline.previewHref && baseline.mime.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element -- preview-safe route serves gated, capped bytes; next/image optimization would bypass the session-gated route semantics.
            <img
              src={baseline.previewHref}
              alt={baseline.title ?? "Current image"}
              className="max-h-64 w-auto self-start rounded-md border border-line object-contain"
            />
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-sm text-foreground">{baseline.title ?? baseline.artifactId}</span>
            <span className="font-mono text-xs text-muted-foreground">{baseline.mime}</span>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No current representation.</p>
      )}
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="Optional prompt to steer the regeneration…"
        aria-label="Regeneration prompt"
        className="text-sm"
        disabled={running || acting}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleRegenerate} disabled={running || acting || busyWithOtherPost}>
          {running ? "Generating…" : "Regenerate"}
        </Button>
        {running ? (
          <Button type="button" variant="outline" onClick={handleCancel} disabled={acting}>
            Cancel
          </Button>
        ) : null}
        {status?.message ? (
          <span className="text-sm text-muted-foreground" role="status">
            {status.message}
          </span>
        ) : null}
        {busyWithOtherPost ? (
          <span className="text-sm text-muted-foreground" role="status">
            Another item in this project is generating an image.
          </span>
        ) : null}
      </div>
      {revertOffer ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-muted p-2">
          <span className="text-sm text-foreground">New image already applied.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setSnapshot(null)} disabled={acting}>
            Keep new image
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => handleRevert(revertOffer)} disabled={acting}>
            Revert to previous
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
