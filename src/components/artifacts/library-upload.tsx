"use client";

/**
 * Library UPLOAD & TYPING affordances (epic #1883 slice A4, spec design@16efd8d2
 * `specs/app-artifacts.html` §VI Upload & typing + §VII inline marketplace).
 *
 * The library toolbar carries a primary Upload action; the whole list region is
 * a drop target. An upload is typed by its MIME base at the existing
 * `POST /api/artifacts/upload` route (A1/A2) — this client surface drives the
 * VISIBLE flow: idle · drag-over · uploading · typed · refused (§VI), the
 * user-meaning type picker (§VI.1), the refusal-with-recourse panel (§VI.3), and
 * the inline marketplace tab — admin install / non-admin request (§VII).
 *
 * Rows stay SERVER-rendered (the row glyph resolves through the server-only
 * dispatch spine); this file adds three client ISLANDS sharing one context —
 * `LibraryUploadProvider` (state + the hidden file input), `LibraryUploadButton`
 * (the toolbar control), and `LibraryUploadDropZone` (the list drop target,
 * overlay, progress row, typed banner + the picker/marketplace dialogs). The
 * pattern mirrors the existing `library-facet-control` island inside the
 * server-rendered toolbar.
 *
 * SCOPED OUT (honest, spec §VI.1 "Derived meaning & suggestion chips", ruling 2):
 * the classifier-derived SUGGESTION chip + auto-surface are the matcher service
 * (cinatra#1883 D1/D2, slice A3 #1891 — IN FLIGHT, not merged). The picker
 * renders the Suggested section ONLY when candidates are supplied (none until A3
 * lands the matcher); the user-sourced meaning path here is complete and does
 * not depend on it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/cinatra-toast";
import {
  ArrowLeft,
  ChevronLeft,
  ExternalLink,
  FileText,
  Sparkles,
  TriangleAlert,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  assertUploadMeaning,
  installArtifactPackInline,
  listArtifactMarketplacePacks,
  listInstalledTypesForArtifact,
  requestTypeInstall,
  type ArtifactMarketplacePack,
} from "@/app/artifacts/upload-typing-actions";
import type { InstalledMeaningType } from "@/lib/artifacts/installed-type-picker";

// ---------------------------------------------------------------------------
// Upload state machine
// ---------------------------------------------------------------------------

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; filename: string; progress: number }
  | {
      phase: "typed";
      artifactId: string;
      filename: string;
      /** Display-only MIME (browser Content-Type / ref); the AUTHORITATIVE MIME
       *  for the picker + assertion is re-derived server-side by artifactId. */
      mime: string;
    }
  | {
      phase: "refused";
      filename: string;
      mime?: string;
      marketplaceHref?: string;
      message: string;
    };

/** Which affordance opened the marketplace tab — the refusal recourse (§VI.3)
 *  or the meaning picker (§VI.1). Both open the SAME catalog: the kind-filtered
 *  set of artifact-type packs (kind: artifact). The public browse card carries
 *  NO per-type `accepts`, so the catalog is NOT narrowed to the specific base or
 *  MIME — `reach` only labels the entry point and threads the return path. */
type MarketplaceReach = "picker" | "refusal";

type UploadContextValue = {
  state: UploadState;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  startUpload: (file: File) => void;
  reset: () => void;
  openPicker: () => void;
  openMarketplace: (reach: MarketplaceReach) => void;
  dialog: "picker" | "marketplace" | null;
  marketplaceReach: MarketplaceReach;
  closeDialog: () => void;
};

const UploadContext = createContext<UploadContextValue | null>(null);

function useUpload(): UploadContextValue {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within LibraryUploadProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider — state, the hidden file input, and the shared dialogs
// ---------------------------------------------------------------------------

export function LibraryUploadProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<"picker" | "marketplace" | null>(null);
  const [marketplaceReach, setMarketplaceReach] = useState<MarketplaceReach>("picker");

  const reset = useCallback(() => {
    setState({ phase: "idle" });
    setDialog(null);
  }, []);

  const startUpload = useCallback(
    (file: File) => {
      setDragging(false);
      setState({ phase: "uploading", filename: file.name, progress: 0 });
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/artifacts/upload");
      xhr.setRequestHeader(
        "Content-Type",
        file.type && file.type.length > 0 ? file.type : "application/octet-stream",
      );
      xhr.setRequestHeader("X-Artifact-Filename", encodeHeader(file.name));
      xhr.setRequestHeader("X-Artifact-Title", encodeHeader(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setState({
            phase: "uploading",
            filename: file.name,
            progress: Math.min(99, Math.round((e.loaded / e.total) * 100)),
          });
        }
      };
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText) as Record<string, unknown>;
        } catch {
          /* non-JSON body — fall through to status handling */
        }
        if (xhr.status === 201 && body.ok === true) {
          // Display-only MIME from the response `ref` (else the browser type);
          // the picker re-derives the AUTHORITATIVE MIME + base server-side.
          const ref = body.ref as { mime?: unknown } | undefined;
          setState({
            phase: "typed",
            artifactId: String(body.artifactId ?? ""),
            filename: file.name,
            mime:
              ref && typeof ref.mime === "string"
                ? ref.mime
                : file.type || "application/octet-stream",
          });
          router.refresh();
          return;
        }
        // Refusal (§VI.3). ONLY a 415 that carries a `marketplaceHref` is the
        // base-case "no installed base accepts this MIME" refusal with install
        // recourse; every other failure (413 too-large, 500, ambiguous/no-mime
        // 415) is surfaced with its own message and NO marketplace link.
        const marketplaceHref =
          typeof body.marketplaceHref === "string" ? body.marketplaceHref : undefined;
        setState({
          phase: "refused",
          filename: file.name,
          // Only carry the refused MIME when it is the base-case (a link is
          // present); otherwise the panel must not claim "no base accepts <mime>".
          mime: marketplaceHref && typeof body.mime === "string" ? body.mime : undefined,
          marketplaceHref,
          message:
            typeof body.error === "string" && body.error.length > 0
              ? body.error
              : "The upload could not be filed.",
        });
      };
      xhr.onerror = () => {
        setState({
          phase: "refused",
          filename: file.name,
          message: "The upload failed — check your connection and try again.",
        });
      };
      xhr.send(file);
    },
    [router],
  );

  const openPicker = useCallback(() => setDialog("picker"), []);
  const openMarketplace = useCallback((reach: MarketplaceReach) => {
    setMarketplaceReach(reach);
    setDialog("marketplace");
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const value = useMemo<UploadContextValue>(
    () => ({
      state,
      dragging,
      setDragging,
      startUpload,
      reset,
      openPicker,
      openMarketplace,
      dialog,
      marketplaceReach,
      closeDialog,
    }),
    [state, dragging, startUpload, reset, openPicker, openMarketplace, dialog, marketplaceReach, closeDialog],
  );

  return (
    <UploadContext.Provider value={value}>
      <Input
        ref={inputRef}
        type="file"
        className="hidden"
        data-testid="artifacts-upload-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) startUpload(file);
          e.target.value = "";
        }}
      />
      {children}
    </UploadContext.Provider>
  );
}

function useOpenFilePicker(): () => void {
  // Read the input by test id at click time — the provider always renders it.
  return useCallback(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[data-testid="artifacts-upload-input"]',
    );
    el?.click();
  }, []);
}

// ---------------------------------------------------------------------------
// Toolbar Upload button (§VI idle)
// ---------------------------------------------------------------------------

export function LibraryUploadButton() {
  const openFilePicker = useOpenFilePicker();
  return (
    <div
      className="flex items-center gap-2"
      data-conformance-id="artifacts-upload-affordance"
      data-action="upload-file -> typed"
    >
      <span className="font-mono text-badge-xs tracking-wide text-muted-foreground">
        or drop a file
      </span>
      <Button
        type="button"
        size="sm"
        onClick={openFilePicker}
        data-testid="artifacts-upload-button"
      >
        <Upload aria-hidden className="size-3.5" />
        Upload
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List drop target + overlay + progress + typed banner + dialogs (§VI/§VII)
// ---------------------------------------------------------------------------

export function LibraryUploadDropZone({ children }: { children: ReactNode }) {
  const { state, dragging, setDragging, startUpload } = useUpload();

  return (
    <div
      className="relative flex flex-col gap-3"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the zone (not a child).
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) startUpload(file);
      }}
      data-testid="artifacts-upload-dropzone"
    >
      {state.phase === "uploading" ? <UploadProgressRow state={state} /> : null}
      {state.phase === "typed" ? <UploadTypedBanner /> : null}
      {state.phase === "refused" ? <UploadRefusedPanel /> : null}
      {children}
      {dragging ? <DragOverlay /> : null}
      <UploadDialogs />
    </div>
  );
}

function DragOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-primary/[0.06] p-4 text-center"
      data-conformance-id="artifacts-upload-dragover"
    >
      <div>
        <div className="mx-auto mb-2 grid size-9 place-items-center rounded-[9px] bg-primary/10 text-primary">
          <Upload aria-hidden className="size-[17px]" />
        </div>
        <p className="font-sans text-sm font-semibold text-primary">Drop to upload</p>
        <p className="mt-1 text-xs text-muted-foreground">Typed by its file kind on drop.</p>
      </div>
    </div>
  );
}

function UploadProgressRow({
  state,
}: {
  state: Extract<UploadState, { phase: "uploading" }>;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-line bg-surface-strong px-3.5 py-3"
      data-conformance-id="artifacts-upload-progress"
      data-state="loading"
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        <FileText aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="font-sans text-sm font-semibold text-foreground">
          {state.filename}
        </span>
        <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-surface-muted">
          <div className="h-full bg-primary" style={{ width: `${state.progress}%` }} />
        </div>
      </div>
      <span className="flex-none font-mono text-badge-xs text-muted-foreground">
        {state.progress}%
      </span>
    </div>
  );
}

function UploadTypedBanner() {
  const { state, openPicker, reset } = useUpload();
  if (state.phase !== "typed") return null;
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-line bg-surface-strong px-3.5 py-3"
      data-conformance-id="artifacts-upload-typed"
      data-state="kind:artifact"
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-warning/10 text-warning">
        <FileText aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-semibold text-foreground">
            {state.filename}
          </span>
          {state.mime ? (
            <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 font-mono text-badge-xs text-foreground">
              {state.mime}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Filed ·{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={openPicker}
            data-testid="artifacts-set-meaning"
          >
            Set meaning
          </Button>
        </p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={reset}>
        Dismiss
      </Button>
    </div>
  );
}

function UploadRefusedPanel() {
  const { state, openMarketplace, reset } = useUpload();
  if (state.phase !== "refused") return null;
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-4 py-3.5"
      data-conformance-id="artifacts-upload-refused"
      data-state="error"
      data-action="open-marketplace -> marketplace-open"
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-destructive/10 text-destructive">
        <TriangleAlert aria-hidden className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-sm font-semibold text-foreground">
          Can&apos;t type {state.filename}
        </p>
        <p className="mt-1 mb-2.5 text-xs leading-relaxed text-muted-foreground">
          {state.mime ? (
            <>
              No installed <b>base type</b> accepts{" "}
              <span className="rounded-full border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-badge-xs">
                {state.mime}
              </span>
              . Install a base that handles it, then re-upload.
            </>
          ) : (
            state.message
          )}
        </p>
        <div className="flex items-center gap-2">
          {/* Recourse: a real MIME no installed base accepts (marketplaceHref
              present) opens the inline marketplace tab — the kind-filtered
              artifact-type catalog (kind: artifact), NOT narrowed to the
              specific base/MIME (the public browse card carries no per-type
              accepts). An ambiguous / no-mime refusal has no install link
              (§VI.3). */}
          {state.marketplaceHref ? (
            <Button
              type="button"
              size="sm"
              onClick={() => openMarketplace("refusal")}
              data-testid="artifacts-refused-find-base"
            >
              Browse artifact types in the marketplace
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs: the type picker (§VI.1) + the inline marketplace tab (§VII)
// ---------------------------------------------------------------------------

function UploadDialogs() {
  const { dialog, closeDialog } = useUpload();
  return (
    <Dialog open={dialog !== null} onOpenChange={(o) => (o ? null : closeDialog())}>
      <DialogContent className="max-w-xl gap-0 p-0">
        {dialog === "picker" ? <TypePickerPanel /> : null}
        {dialog === "marketplace" ? <MarketplaceTabPanel /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TypePickerPanel() {
  const { state, openMarketplace, closeDialog } = useUpload();
  const router = useRouter();
  const [types, setTypes] = useState<InstalledMeaningType[] | null>(null);
  const [serverMime, setServerMime] = useState<string>("");
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const artifactId = state.phase === "typed" ? state.artifactId : "";
  const filename = state.phase === "typed" ? state.filename : "";
  // Display MIME is the server-derived one once loaded, else the display hint.
  const mime = serverMime || (state.phase === "typed" ? state.mime : "");

  // Load the candidate installed types once the picker mounts. The server
  // re-derives the artifact's AUTHORITATIVE MIME + base type by id — the client
  // never supplies the MIME (the browser type can be empty or wrong).
  useEffect(() => {
    if (!artifactId) return;
    let live = true;
    listInstalledTypesForArtifact(artifactId)
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setTypes(r.types);
          setServerMime(r.mime);
        } else setError(true);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [artifactId]);

  const confirm = useCallback(async () => {
    if (!selected || !artifactId) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof assertUploadMeaning>>;
    try {
      r = await assertUploadMeaning({ artifactId, extension: selected });
    } catch {
      setBusy(false);
      toast.error("Couldn't set the meaning — try again.");
      return;
    }
    setBusy(false);
    if (r.ok) {
      toast.success("Meaning set.");
      closeDialog();
      router.refresh();
    } else {
      toast.error(r.message);
    }
  }, [selected, artifactId, closeDialog, router]);

  return (
    <div
      data-conformance-id="artifacts-type-picker"
      data-field="type=installedTypes.accepting-mime"
      data-action="assert-meaning -> meaning-asserted"
      data-state={error ? "error" : types === null ? "loading" : undefined}
    >
      <DialogHeader className="border-b border-line px-3.5 py-3 text-left">
        <DialogTitle className="text-sm font-bold">What is this?</DialogTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Assert what <b className="text-foreground">{filename}</b> means. This sets its
          meaning, not its file kind
          {mime ? (
            <>
              {" "}
              (
              <span className="rounded-full border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-badge-2xs">
                {mime}
              </span>
              )
            </>
          ) : null}
          .
        </p>
      </DialogHeader>
      <div className="px-3.5 py-3">
        {/* Suggested (§VI.1, ruling 2) — the classifier-derived suggestion chip.
            SCOPED OUT until the matcher lands (A3 #1891): rendered only when
            candidates are present, which is never until A3. Kept structurally so
            the surface is spec-shaped and A3 fills it with zero UI change. */}
        <SuggestedMeaningChips suggestions={[]} onConfirm={() => undefined} />

        <div className="mb-2 font-mono text-badge-2xs uppercase tracking-kicker-wide text-muted-foreground">
          Installed types that accept {mimeShortLabel(mime)}
        </div>
        {error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-4 text-xs text-destructive">
            Couldn&apos;t load installed types. Close and try again.
          </p>
        ) : types === null ? (
          <p className="rounded-lg border border-line px-3 py-4 text-xs text-muted-foreground">
            Loading installed types…
          </p>
        ) : types.length === 0 ? (
          <p className="rounded-lg border border-line px-3 py-4 text-xs text-muted-foreground">
            No installed type accepts this file. Find one in the marketplace.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line">
            {types.map((t, i) => (
              <li
                key={t.objectTypeId ?? t.extension}
                className={
                  "flex cursor-pointer items-center gap-2.5 px-3 py-2.5 " +
                  (i === types.length - 1 ? "" : "border-b border-line ") +
                  (selected === t.extension ? "bg-primary/5" : "")
                }
                onClick={() => setSelected(t.extension)}
                data-testid="artifacts-picker-type"
                data-selected={selected === t.extension ? "true" : "false"}
              >
                <span className="flex-1 font-sans text-xs text-foreground">
                  {t.displayName}{" "}
                  <span className="font-mono text-badge-2xs text-muted-foreground">
                    {t.objectTypeId ?? t.extension}
                  </span>
                </span>
                <span className="rounded border border-line bg-surface-muted px-1.5 py-0.5 text-badge-2xs text-muted-foreground">
                  {t.extensionLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3.5 flex items-center justify-between gap-2.5">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => openMarketplace("picker")}
            data-action="open-marketplace-tab -> marketplace-open"
            data-testid="artifacts-picker-none-of-these"
          >
            None of these — find a type…
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={closeDialog}>
              Keep as file
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!selected || busy}
              onClick={() => void confirm()}
              data-testid="artifacts-picker-confirm"
            >
              Confirm
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SuggestedMeaningChips({
  suggestions,
  onConfirm,
}: {
  suggestions: Array<{ extension: string; label: string; confidence: number }>;
  onConfirm: (extension: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <>
      <div className="mb-2 font-mono text-badge-2xs uppercase tracking-kicker-wide text-muted-foreground">
        Suggested
      </div>
      <div className="mb-3.5 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <Button
            key={s.extension}
            type="button"
            variant="outline"
            size="sm"
            data-action="confirm-suggestion -> meaning-asserted"
            className="h-auto gap-1.5 rounded-full border-dashed border-warning/60 bg-warning/10 px-2.5 py-1 text-xs font-semibold text-warning"
            onClick={() => onConfirm(s.extension)}
          >
            <Sparkles aria-hidden className="size-3" />
            {s.label}{" "}
            <span className="font-mono text-badge-2xs opacity-75">
              {s.confidence.toFixed(2)}
            </span>
          </Button>
        ))}
      </div>
    </>
  );
}

function MarketplaceTabPanel() {
  const { state, marketplaceReach, openPicker, closeDialog } = useUpload();
  const router = useRouter();
  const [packs, setPacks] = useState<ArtifactMarketplacePack[] | null>(null);
  const [registryConnected, setRegistryConnected] = useState(true);
  const [canInstall, setCanInstall] = useState(false);
  const [error, setError] = useState(false);
  const [rowState, setRowState] = useState<Record<string, "installing" | "installed" | "requested">>({});
  const [scopeFor, setScopeFor] = useState<ArtifactMarketplacePack | null>(null);

  const contextName = state.phase === "typed" ? state.filename : state.phase === "refused" ? state.filename : "";
  // The server-provided refusal deep link (the refused-MIME advisory pointer,
  // `?accepts=<mime>`), when this tab was reached from a refusal that carried
  // one. Only surfaced to admins below — the full `/configuration/marketplace`
  // page requires an admin session, so it would be a dead end for a non-admin.
  const refusalMarketplaceHref =
    marketplaceReach === "refusal" && state.phase === "refused" ? state.marketplaceHref : undefined;

  useEffect(() => {
    let live = true;
    listArtifactMarketplacePacks()
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setPacks(r.packs);
          setRegistryConnected(r.registryConnected);
          setCanInstall(r.canInstall);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const doRequest = useCallback(async (pack: ArtifactMarketplacePack) => {
    setRowState((s) => ({ ...s, [pack.packageName]: "requested" }));
    const rollback = () =>
      setRowState((s) => {
        const next = { ...s };
        delete next[pack.packageName];
        return next;
      });
    let r: Awaited<ReturnType<typeof requestTypeInstall>>;
    try {
      r = await requestTypeInstall({
        packageName: pack.packageName,
        displayName: pack.displayName,
      });
    } catch {
      rollback();
      toast.error("Couldn't send the request — try again.");
      return;
    }
    if (r.ok) {
      toast.success(
        r.alreadyRequested
          ? "Already requested — admins were notified."
          : "Request sent — admins notified.",
      );
    } else {
      // Distinct honest failures: `no-admins` (nobody to receive it) and
      // `auth-required` both carry a message; roll the optimistic row back.
      rollback();
      toast.error(r.message);
    }
  }, []);

  const doInstall = useCallback(
    async (pack: ArtifactMarketplacePack, level: "workspace" | "admin") => {
      setScopeFor(null);
      setRowState((s) => ({ ...s, [pack.packageName]: "installing" }));
      const rollback = () =>
        setRowState((s) => {
          const next = { ...s };
          delete next[pack.packageName];
          return next;
        });
      let r: Awaited<ReturnType<typeof installArtifactPackInline>>;
      try {
        r = await installArtifactPackInline({
          packageName: pack.packageName,
          version: pack.version,
          // The action re-derives the workspace/admin id from the session and
          // discards the client id (a cross-tenant guard), so a placeholder id
          // is sufficient for the workspace-scoped install-scope choice.
          accessTarget: { level, id: level },
        });
      } catch {
        rollback();
        toast.error("The install failed — try again.");
        return;
      }
      if (r.ok) {
        setRowState((s) => ({ ...s, [pack.packageName]: "installed" }));
        toast.success("Installed — selectable once it settles.");
        router.refresh();
      } else {
        rollback();
        toast.error(r.message);
      }
    },
    [router],
  );

  const state_ = error ? "error" : packs === null ? "loading" : packs.length === 0 ? "empty" : undefined;

  return (
    <div
      data-conformance-id="artifacts-marketplace-tab"
      data-field="name=manifest.displayName"
      data-action="install-type -> installed"
      data-state={state_ ? `${state_} kind:artifact` : "kind:artifact"}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>Marketplace — install an artifact type</DialogTitle>
      </DialogHeader>
      {/* Tab strip — Marketplace beside Installed; the picker context is kept. */}
      <div className="flex items-center gap-0 border-b border-line px-3.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="tab"
          className="h-auto rounded-none border-0 px-3 py-2.5 text-xs font-normal text-muted-foreground"
          onClick={marketplaceReach === "picker" ? openPicker : closeDialog}
        >
          Installed
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="tab"
          aria-selected="true"
          className="-mb-px h-auto rounded-none border-0 border-b-2 border-primary px-3 py-2.5 text-xs font-semibold text-primary"
        >
          Marketplace
        </Button>
        <span className="ml-auto font-mono text-badge-2xs uppercase tracking-kicker-wide text-muted-foreground">
          kind: artifact
        </span>
      </div>
      {/* Context bar with a return-to-picker path (only when reached from it). */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3.5 py-2.5">
        {marketplaceReach === "picker" ? (
          <Button
            type="button"
            variant="link"
            className="h-auto gap-1 p-0 text-badge-xs"
            onClick={openPicker}
            data-action="return-to-picker -> picker-open"
            data-testid="artifacts-marketplace-back"
          >
            <ChevronLeft aria-hidden className="size-3" />
            Back to picker
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 text-badge-xs text-muted-foreground">
            <ArrowLeft aria-hidden className="size-3" />
            {marketplaceReach === "refusal" ? "browse artifact types" : ""}
          </span>
        )}
        {contextName ? (
          <span className="font-mono text-badge-2xs text-muted-foreground">
            typing {contextName}
          </span>
        ) : null}
        {/* Consume the server-provided refusal deep link (not a dead boolean):
            an ADMIN-only escape hatch to the full marketplace, keyed by the
            refused MIME (`?accepts=`). Admin-gated because the marketplace page
            requires an admin session — a non-admin uses the inline tab + the
            Request path instead. */}
        {refusalMarketplaceHref && canInstall ? (
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto gap-1 p-0 text-badge-xs"
            onClick={() => router.push(refusalMarketplaceHref)}
            data-testid="artifacts-marketplace-open-full"
          >
            Open full marketplace
            <ExternalLink aria-hidden className="size-3" />
          </Button>
        ) : null}
      </div>

      <div className="max-h-[50vh] overflow-y-auto">
        {error ? (
          <p className="px-3.5 py-8 text-center text-xs text-destructive">
            The marketplace catalog failed to load. Close and try again.
          </p>
        ) : packs === null ? (
          <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">
            Loading the marketplace…
          </p>
        ) : !registryConnected ? (
          <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">
            The extension registry isn&apos;t connected. Ask an admin to connect it, then
            browse artifact types here.
          </p>
        ) : packs.length === 0 ? (
          <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">
            No installable artifact types are available in the marketplace yet.
          </p>
        ) : (
          <ul className="list-none">
            {packs.map((pack, i) => {
              const st = rowState[pack.packageName];
              return (
                <li
                  key={pack.packageName}
                  className={
                    "flex items-center gap-3 px-3.5 py-3 " +
                    (i === packs.length - 1 ? "" : "border-b border-line")
                  }
                  data-testid="artifacts-marketplace-pack"
                >
                  <span className="grid size-8 flex-none place-items-center rounded-lg bg-success/10 text-success">
                    <FileText aria-hidden className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-sans text-sm font-semibold text-foreground">
                      {pack.displayName}
                    </span>
                    <p className="mt-0.5 text-badge-xs text-muted-foreground">
                      {canInstall
                        ? (pack.description ?? `Installs ${pack.packageName}`)
                        : "Needs a platform admin to install."}
                    </p>
                  </div>
                  {st === "installing" ? (
                    <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-badge-xs font-medium text-primary">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      Installing
                    </span>
                  ) : st === "installed" ? (
                    <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-badge-xs font-medium text-success">
                      Installed
                    </span>
                  ) : st === "requested" ? (
                    <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-badge-xs font-medium text-warning">
                      <span className="size-1.5 rounded-full bg-warning" />
                      Request sent
                    </span>
                  ) : canInstall ? (
                    <Button
                      type="button"
                      size="sm"
                      className="flex-none"
                      onClick={() => setScopeFor(pack)}
                      data-testid="artifacts-marketplace-install"
                    >
                      Install
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-none"
                      onClick={() => void doRequest(pack)}
                      data-testid="artifacts-marketplace-request"
                      data-conformance-id="artifacts-marketplace-request"
                      data-action="request-install -> request-sent"
                      data-field="name=manifest.displayName"
                    >
                      Request install
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* §VII install-scope dialog — a platform admin picks the visibility scope,
          then the pack installs inline (no redirect). */}
      <InstallScopeConfirm
        pack={scopeFor}
        onCancel={() => setScopeFor(null)}
        onConfirm={(level) => scopeFor && void doInstall(scopeFor, level)}
      />
    </div>
  );
}

function InstallScopeConfirm({
  pack,
  onCancel,
  onConfirm,
}: {
  pack: ArtifactMarketplacePack | null;
  onCancel: () => void;
  onConfirm: (level: "workspace" | "admin") => void;
}) {
  const [level, setLevel] = useState<"workspace" | "admin">("workspace");
  return (
    <Dialog open={pack !== null} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Install {pack?.displayName}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Who can use this type once installed?</p>
        <RadioGroup
          value={level}
          onValueChange={(v) => setLevel(v as "workspace" | "admin")}
          className="flex flex-col gap-2"
        >
          {(["workspace", "admin"] as const).map((l) => (
            <label
              key={l}
              htmlFor={`install-scope-${l}`}
              className={
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs " +
                (level === l ? "border-primary bg-primary/5" : "border-line")
              }
            >
              <RadioGroupItem id={`install-scope-${l}`} value={l} />
              {l === "workspace" ? "Everyone in the workspace" : "Platform admins only"}
            </label>
          ))}
        </RadioGroup>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onConfirm(level)}
            data-testid="artifacts-install-scope-confirm"
          >
            Install
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Header values must be latin1-safe; a filename with characters above U+00FF
 *  would throw in setRequestHeader. Percent-encode those so a non-latin1
 *  filename cannot crash the upload. */
function encodeHeader(value: string): string {
  return /[^\u0020-\u00FF]/.test(value) ? encodeURIComponent(value) : value;
}

/** A short human label for a MIME in the picker / tab chrome ("PDF" from
 *  application/pdf; the subtype upper-cased otherwise). */
function mimeShortLabel(mime: string | undefined): string {
  if (!mime) return "this file";
  const sub = mime.split("/")[1] ?? mime;
  return sub.split("+")[0]?.toUpperCase() ?? mime.toUpperCase();
}
