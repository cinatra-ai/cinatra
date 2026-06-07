"use client";

/**
 * Per-row "Re-evaluate" button.
 *
 * Single-pair sync evaluation: calls the admin-gated server action
 * `evaluatePairAction` (which threads through skills_match_evaluate_pair
 * MCP handler), then triggers `router.refresh()` so the page re-reads
 * the row's updated source/evaluator_version/evaluated_at metadata.
 *
 * Spinner state is local; errors surface via toast.error() to keep the
 * row markup minimal.
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { evaluatePairAction } from "./actions";
import { toast } from "@/lib/cinatra-toast";

export function MatchesRowAction({ agentId, skillId }: { agentId: string; skillId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const fd = new FormData();
          fd.set("agentId", agentId);
          fd.set("skillId", skillId);
          try {
            await evaluatePairAction(fd);
            router.refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Re-evaluation failed");
          }
        })
      }
    >
      {pending ? "Evaluating…" : "Re-evaluate"}
    </Button>
  );
}
