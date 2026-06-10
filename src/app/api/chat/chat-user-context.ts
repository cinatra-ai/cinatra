import "server-only";

// Chat user-context sections, resolved REGISTRATION-DRIVEN from the generic
// capability registry instead of the chat runner importing connector packages
// by name. Connectors register a `chat-user-context` provider in their own
// `register(ctx)` (activated through the serverEntry loader; the pre-#75
// transitional host-boot bridge is gone), and this consumer appends whatever
// the live providers contribute. Adding or removing a contributing connector
// requires NO edit here or in runner.ts.
//
// Consumer-side hardening (see the trust-boundary note in the SDK contract):
//   - deterministic order: providers sorted by packageName;
//   - shape validation: only string sections are accepted;
//   - failure isolation: a throwing/rejecting provider is skipped with a
//     warning — it must never fail the chat turn (during the transport
//     registration cutover a provider's underlying deps may legitimately be
//     unwired in some boot configurations).

import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import {
  CHAT_USER_CONTEXT_CAPABILITY_ID,
  type ChatUserContextContributor,
} from "@cinatra-ai/sdk-extensions";

/**
 * Resolve the live chat-user-context providers and collect their sections for
 * `userId`. Fail-soft per provider; deterministic provider order; non-string
 * section values are dropped (with a warning).
 */
export async function buildChatUserContextSections(userId?: string): Promise<string[]> {
  const providers = [...resolveCapabilityProviders(CHAT_USER_CONTEXT_CAPABILITY_ID)].sort(
    (a, b) => a.packageName.localeCompare(b.packageName),
  );
  const sections: string[] = [];
  for (const provider of providers) {
    const impl = provider.impl as Partial<ChatUserContextContributor> | null | undefined;
    if (typeof impl?.buildSections !== "function") {
      console.warn(
        `[chat] chat-user-context provider ${provider.packageName} has no buildSections() — skipped`,
      );
      continue;
    }
    try {
      const result = await impl.buildSections({ userId });
      if (!Array.isArray(result)) {
        console.warn(
          `[chat] chat-user-context provider ${provider.packageName} returned a non-array — skipped`,
        );
        continue;
      }
      for (const section of result) {
        if (typeof section === "string" && section.length > 0) {
          sections.push(section);
        } else if (typeof section !== "string") {
          console.warn(
            `[chat] chat-user-context provider ${provider.packageName} returned a non-string section — dropped`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[chat] chat-user-context provider ${provider.packageName} failed — skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return sections;
}
