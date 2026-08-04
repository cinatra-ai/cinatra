"use client";

// Administration → LLM: the on-demand Anthropic native-skills probe
// diagnostic (cinatra#2390, epic #2385 S5 — the probe demoted out of the
// setup gate). Run-on-demand, NON-BLOCKING, classified result rendered
// inline; nothing here gates setup or any commit.

import { useActionState } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { runAnthropicNativeSkillsProbeDiagnosticAction } from "@/app/configuration/llm/diagnostics-actions";
import type { AnthropicProbeDiagnosticResult } from "@/app/configuration/llm/anthropic-diagnostics-contract";

export function AnthropicDiagnosticsCard() {
  const [result, formAction, pending] = useActionState<
    AnthropicProbeDiagnosticResult | null,
    FormData
  >(runAnthropicNativeSkillsProbeDiagnosticAction, null);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-base font-semibold text-foreground">Diagnostics</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Verify that this Anthropic connection accepts native skill delivery
          (a container.skills request against an uploaded skill revision). The
          check is on-demand and blocks nothing.
        </p>
      </div>
      <form action={formAction}>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          data-testid="llm-anthropic-probe-run"
        >
          {pending ? "Probing…" : "Run native-skills probe"}
        </Button>
      </form>
      {result ? (
        <Alert
          variant={result.code === "accepted" ? "default" : "destructive"}
          data-testid="llm-anthropic-probe-result"
        >
          {result.code === "accepted" ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <TriangleAlert className="size-4" aria-hidden />
          )}
          <AlertTitle>
            {result.code === "accepted"
              ? "Native skill delivery verified"
              : `Probe result: ${result.code}`}
          </AlertTitle>
          <AlertDescription>
            <span className="block">{result.message}</span>
            {result.probed ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                Probed {result.probed.skillId}@{result.probed.version}
                {result.probed.disposable ? " (temporary probe skill, deleted after the check)" : ""}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
