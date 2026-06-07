"use client";

import { useRouter } from "next/navigation";
import { AppDialog } from "@/components/app-dialog";
import { Button } from "@/components/ui/button";

type McpCheckResultModalProps = {
  checkResult: string;
  checkedProvider: string | null;
  rawReqDisplay: string | null;
  rawResDisplay: string | null;
  adminBasePath: string;
  statusCode?: string | null;
};

export function McpCheckResultModal({
  checkResult,
  checkedProvider,
  rawReqDisplay,
  rawResDisplay,
  adminBasePath,
  statusCode,
}: McpCheckResultModalProps) {
  const router = useRouter();

  function handleClose() {
    router.push(adminBasePath);
  }

  return (
    <AppDialog
      open={true}
      onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}
      maxWidth="max-w-2xl"
      showCloseButton={false}
      className="max-h-[85vh] overflow-y-auto p-0"
    >
      <div className="sticky top-0 bg-background border-b px-6 py-4 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-foreground">Reachability check result</h2>
        <Button variant="ghost" size="sm" onClick={handleClose}>Close</Button>
      </div>
      <div className="px-6 py-5 flex flex-col gap-5">
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          checkResult === "ok"
            ? "border-success/30 bg-success/10 text-success"
            : checkResult === "localhost" || checkResult === "wrong_status" || checkResult === "no_auth_header"
              ? "border-warning/30 bg-warning/10 text-warning"
              : "border-destructive/30 bg-destructive/10 text-destructive"
        }`}>
          {checkResult === "ok" && `✓ MCP endpoint reachable${checkedProvider ? ` for ${checkedProvider.charAt(0).toUpperCase() + checkedProvider.slice(1)}` : ""} — responded 401 with OAuth challenge.`}
          {checkResult === "no_url" && "No public URL is configured. Set one above before testing."}
          {checkResult === "localhost" && "Public URL points to localhost — not reachable from external LLM providers."}
          {checkResult === "timeout" && "Request timed out. The public URL may be unreachable from the open internet."}
          {checkResult === "no_auth_header" && "Endpoint returned 401 but is missing the WWW-Authenticate: Bearer header. MCP auth may be misconfigured."}
          {checkResult === "wrong_status" && `Endpoint returned HTTP ${statusCode ?? "?"} instead of 401. Check that the public URL points to this MCP server.`}
          {checkResult === "error" && "Connection failed. The public URL may be unreachable or the upstream tunnel/proxy is offline."}
        </div>
        {rawReqDisplay && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Request</p>
            <pre className="overflow-x-auto rounded-xl border border-line bg-surface-muted px-4 py-3 font-mono text-xs text-foreground whitespace-pre-wrap">{rawReqDisplay}</pre>
          </div>
        )}
        {rawResDisplay && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Response</p>
            <pre className="overflow-x-auto rounded-xl border border-line bg-surface-muted px-4 py-3 font-mono text-xs text-foreground whitespace-pre-wrap">{rawResDisplay}</pre>
          </div>
        )}
      </div>
    </AppDialog>
  );
}
