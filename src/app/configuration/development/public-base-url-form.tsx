"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { LinkIcon } from "lucide-react";
import { TailscaleLogo } from "@/components/tailscale-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldDescription } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { setMcpPublicBaseUrlAction } from "./actions";

type Props = {
  initialUrl: string;
  /** True when the Tailscale connector is configured. Drives the flyout. */
  tailscaleConnected: boolean;
  /**
   * The Tailscale-provisioned Funnel URL, when one already exists in the
   * DB. `null` when Tailscale is connected but no Funnel URL has been
   * provisioned yet.
   */
  tailscaleUrl: string | null;
};

export function PublicBaseUrlForm({ initialUrl, tailscaleConnected, tailscaleUrl }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [savedUrl, setSavedUrl] = useState(initialUrl);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const trimmed = url.trim();
  // Origin-only: protocol + host (with optional :port). No path / query / fragment.
  const valid =
    trimmed.length === 0 ||
    /^https?:\/\/[a-z0-9.\-]+(?::\d+)?\/?$/i.test(trimmed);
  const dirty = trimmed !== savedUrl.trim();

  // Close the flyout when the user clicks anywhere outside the field+flyout.
  useEffect(() => {
    if (!flyoutOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFlyoutOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [flyoutOpen]);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setMcpPublicBaseUrlAction({ url: trimmed.length > 0 ? trimmed : null });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedUrl(trimmed);
    });
  }

  function pickTailscale() {
    if (tailscaleUrl) {
      setUrl(tailscaleUrl);
      setFlyoutOpen(false);
    }
  }

  const showFlyout = flyoutOpen && tailscaleConnected;

  return (
    <>
      <CardContent className="flex flex-col gap-4">
        <Field>
          {/* No visible FieldLabel — the CardTitle already heads this card;
              aria-label keeps the input accessibly named. */}
          <div ref={containerRef} className="relative max-w-xl">
            <InputGroup>
              <InputGroupAddon>
                <LinkIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="publicBaseUrl"
                name="publicBaseUrl"
                type="text"
                aria-label="Public base URL"
                placeholder="https://my-tunnel.example.ts.net"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onFocus={() => setFlyoutOpen(true)}
                spellCheck={false}
                autoComplete="off"
              />
            </InputGroup>
            {showFlyout ? (
              <div
                className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 overflow-hidden rounded-control border border-line bg-surface shadow-md"
                role="listbox"
              >
                {tailscaleUrl ? (
                  <Button
                    type="button"
                    variant="ghost"
                    role="option"
                    aria-selected={trimmed === tailscaleUrl}
                    // onMouseDown (not onClick) so it fires before the input
                    // blur — keeps the pick from being swallowed.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickTailscale();
                    }}
                    className="flex h-auto w-full items-center justify-start gap-2 rounded-none border-0 px-3 py-2 text-left text-sm font-normal whitespace-normal hover:bg-surface-muted"
                  >
                    <TailscaleLogo className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-xs">
                      <span className="font-semibold text-muted-foreground">TAILSCALE: </span>
                      <span className="break-all">{tailscaleUrl}</span>
                    </span>
                  </Button>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                    <TailscaleLogo className="h-4 w-4 shrink-0" />
                    <span className="text-xs">
                      <span className="font-semibold">TAILSCALE: </span>
                      tailnet not resolved yet — reconnect the Tailscale
                      connector to refresh.
                    </span>
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <FieldDescription>
            Must start with https:// (or http:// for local proxies) and
            point at this dev server. Leave empty to disable external
            reachability.
            {tailscaleConnected
              ? " Click the field to pick the Tailscale Funnel URL."
              : null}
          </FieldDescription>
        </Field>

        {!valid && (
          <span className="text-sm text-destructive">
            URL must be origin-only — protocol + host (no path, query, or fragment).
            Example: <code>https://my-tunnel.example.ts.net</code>.
          </span>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <CardFooter>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!dirty || !valid || isPending}
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </CardFooter>
    </>
  );
}
