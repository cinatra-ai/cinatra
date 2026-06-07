"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

// ---------------------------------------------------------------------------
// MermaidBlock — renders a mermaid fenced code block as an SVG diagram.
// Lazy-loads mermaid on first render; falls back to plain code on error.
// ---------------------------------------------------------------------------

const MAX_CHARS = 5000;

type MermaidBlockProps = {
  source: string;
  /** Stable id unique per message+index. */
  id: string;
};

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export function MermaidBlock({ source, id }: MermaidBlockProps) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const renderingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    renderingRef.current = true;
    setError(null);
    setSvg(null);

    const capped = source.length > MAX_CHARS ? source.slice(0, MAX_CHARS) : source;
    setTruncated(source.length > MAX_CHARS);

    void (async () => {
      try {
        const mermaid = await getMermaid();
        // Re-initialize theme when next-themes changes.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "default",
        });
        const uniqueId = `mermaid-${id}-${Date.now()}`;
        const { svg: rendered } = await mermaid.render(uniqueId, capped);
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Render failed");
      } finally {
        renderingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, id, resolvedTheme]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-line bg-surface-muted p-3">
        <div className="mb-2 text-xs text-muted-foreground">Mermaid render failed — showing source</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs font-mono text-foreground">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 flex h-32 items-center justify-center rounded-lg border border-line bg-surface-muted">
        <div className="text-xs text-muted-foreground">Rendering diagram…</div>
      </div>
    );
  }

  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-line bg-surface p-3">
      {/* svg content is produced by mermaid with securityLevel:"strict" which disables raw HTML in labels */}
      {/* eslint-disable-next-line react/no-danger */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {truncated && (
        <div className="mt-2 text-xs text-muted-foreground">
          Diagram source truncated to {MAX_CHARS} characters.
        </div>
      )}
    </div>
  );
}
