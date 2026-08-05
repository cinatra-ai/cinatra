"use server";

/**
 * Administration → LLM diagnostics actions (cinatra#2390, epic #2385 S5).
 *
 * THE PROBE, DEMOTED — NOT DELETED. The native-skills probe used to be a
 * BLOCKING gate inside the setup readiness saga. S5 retires that gate
 * (committing Anthropic sets the connector's MCP mode to `native`, which
 * removes the misconfiguration the gate existed to catch) and re-homes the
 * probe here as a NON-BLOCKING, run-on-demand diagnostic with a CLASSIFIED
 * result: it changes nothing, gates nothing, and reports a stable code plus
 * sanitized actionable copy — never raw provider text.
 *
 * The probe references an ACTUALLY-UPLOADED revision (a synced catalog skill
 * when one exists, else a disposable throwaway that is created, probed, and
 * deleted) — probing a fabricated id would exercise the API's 404 path, not
 * the `container.skills` acceptance path.
 */

import { requireAdminSession } from "@/lib/auth-session";
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { readSyncedAnthropicSkillTargets } from "@/lib/setup-readiness-ports";
import { readAnthropicMcpMode, sanitizeReadinessMessage } from "@/lib/setup-readiness-saga";
import type { AnthropicProbeDiagnosticResult } from "@/app/configuration/llm/anthropic-diagnostics-contract";

export async function runAnthropicNativeSkillsProbeDiagnosticAction(
  _prevState: AnthropicProbeDiagnosticResult | null,
  _formData: FormData,
): Promise<AnthropicProbeDiagnosticResult> {
  await requireAdminSession();
  const at = new Date().toISOString();

  const surface = getLlmProviderSurface("anthropic");
  if (!surface?.probeNativeSkills) {
    return {
      code: "connector-unavailable",
      message:
        "The installed Anthropic connector does not expose the native-skills probe " +
        "(cinatra.llmProvider ABI v2), or is not active. Install/activate a connector " +
        "version that declares ABI v2 to run this diagnostic.",
      at,
    };
  }

  // Prefer a REAL synced revision; fall back to a disposable probe skill when
  // the synced set is legitimately empty.
  let target: { skillId: string; version: string } | undefined;
  let dispose: (() => Promise<void>) | null = null;
  let disposable = false;
  try {
    target = (await readSyncedAnthropicSkillTargets())[0];
  } catch (err) {
    // A non-derivable sync namespace usually means no key is stored.
    return {
      code: "no-key",
      message: sanitizeReadinessMessage(
        `Could not resolve the uploaded skill set for this connection: ${errMessage(err)}. ` +
          "Save an Anthropic API key (Administration → LLM) and try again.",
      ),
      at,
    };
  }

  try {
    if (!target) {
      const { createDisposableAnthropicProbeSkill } = await import(
        "@/lib/anthropic-skill-probe-service"
      );
      const created = await createDisposableAnthropicProbeSkill();
      target = { skillId: created.skillId, version: created.version };
      dispose = created.dispose;
      disposable = true;
    }

    const result = await surface.probeNativeSkills({
      skillId: target.skillId,
      version: target.version,
      timeoutMs: 30_000,
    });
    const probed = { skillId: target.skillId, version: target.version, disposable };
    if (result.accepted === true) {
      return {
        code: "accepted",
        message: "Claude accepted a container.skills request on this connection — native skill delivery works.",
        probed,
        at,
      };
    }
    if (result.mode === "function-tools" || readAnthropicMcpMode() === "function-tools") {
      return {
        code: "rejected-function-tools",
        message:
          "Anthropic rejected the container.skills request: the connector's MCP mode is " +
          "'function-tools'. Committing Anthropic through setup migrates it to 'native' " +
          "automatically; re-run AI setup, or set the mode to native and probe again.",
        probed,
        at,
      };
    }
    return {
      code: "rejected-workspace",
      message: sanitizeReadinessMessage(
        (result.reason ?? "Anthropic rejected the container.skills request.") +
          " Confirm the Anthropic workspace has custom skills enabled for this API key.",
      ),
      probed,
      at,
    };
  } catch (err) {
    return {
      code: "inconclusive",
      message: sanitizeReadinessMessage(
        `The probe did not complete: ${errMessage(err)}. This diagnostic is non-blocking — ` +
          "check the Anthropic connection and try again.",
      ),
      at,
    };
  } finally {
    if (dispose) {
      try {
        await dispose();
      } catch (err) {
        console.error(
          "[llm-diagnostics] the disposable probe skill could not be deleted — delete it manually in the Anthropic console:",
          sanitizeReadinessMessage(errMessage(err)),
        );
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
