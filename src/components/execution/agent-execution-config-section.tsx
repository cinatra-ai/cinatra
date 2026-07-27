import "server-only";

// The §V settings "Execution" section for an AGENT extension (exec-plane S3
// slice B, cinatra#1708; epic #1705).
//
// Server half: loads the view model and binds the save action, then hands both
// to the client editor. Kept out of `packages/extensions` on purpose — the
// settings screen only needs to know "render this node for kind:agent", while
// the execution-plane knowledge (authority, dormancy, promotion) stays in the
// app's execution slice next to the rest of it.

import { AgentExecutionConfigClient } from "@/components/execution/agent-execution-config-client";
import { saveAgentExecutionConfigAction } from "@/lib/execution/agent-execution-config-actions";
import { loadAgentExecutionConfig } from "@/lib/execution/agent-execution-config-load";

export async function AgentExecutionConfigSection({
  packageName,
  displayName,
}: {
  packageName: string;
  displayName: string;
}) {
  // `installedExtension: true` — this section is mounted ONLY from the
  // per-extension settings screen, which resolved this agent from the installed
  // -extension registry. That makes "no readable store record" an unreadable
  // manifest (fail closed to read-only), not an in-app agent.
  const view = await loadAgentExecutionConfig({
    packageName,
    displayName,
    installedExtension: true,
  });

  // The save action exists ONLY when the config surface genuinely owns this
  // agent's environment; a packaged agent's recipe is reviewed in its package.
  // The action re-checks authority server-side regardless.
  const save = view.editable
    ? async (input: {
        executionEnabled: "inherit" | "on" | "off";
        os: string;
        pip: string;
        npm: string;
      }) => {
        "use server";
        return saveAgentExecutionConfigAction({ packageName, submission: input });
      }
    : undefined;

  return <AgentExecutionConfigClient view={view} save={save} />;
}
