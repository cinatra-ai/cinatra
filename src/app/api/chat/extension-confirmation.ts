export type ConfirmationMessage = {
  role: "user" | "assistant";
  content: string;
};

export const EXTENSION_IMPLEMENTATION_CONFIRMATION_REQUIRED_CODE =
  "extension_implementation_confirmation_required";

const CONFIRMATION_WINDOW = 6;

const EXTENSION_IMPLEMENTATION_TOOLS = new Set([
  "agent_compile",
  "agent_save",
  "agent_registry_publish",
  "agent_source_write",
  "agent_source_write_files",
  "agent_source_compile",
  "agent_source_publish",
  // Cinatra MCP exposes skills primitives under the `skills_` (plural) prefix.
  // Authoring/install mutations require the same confirmation as agent authoring.
  "skills_personal_upsert",
  "skills_personal_skill_create_or_update",
  "skills_installed_upsert",
  "skills_packages_install_from_github",
]);

const FUTURE_EXTENSION_AUTHORING_PATTERNS = [
  // `workflow`, `artifact`, and `skill` are now LIVE (SDK-P5): the
  // {workflow,artifact,skill}_source_* package-authoring tools require the same
  // implementation-confirmation gate as the agent_source_* tools. The remaining
  // kinds (connector/asset/entity/extension) stay anticipated-but-unbuilt and
  // are matched defensively. NOTE: this matches {workflow,artifact,skill}_source_*
  // but NOT the workflow_draft_*/workflow_template_* runtime tools (which author
  // DRAFTS/INSTANCES), NOT artifact_authoring_emit (an artifact INSTANCE emit),
  // and NOT skills_personal_*/skills_installed_*/skills_packages_install (skill
  // ROW/install mutations — those have their own gating below); only the
  // `_source_` package mutators gate here. `*_source_validate` is read-only and
  // is intentionally NOT matched (no write/compile/publish/save/create verb).
  /^(agent|workflow|artifact|extension|connector|asset|entity|skill)_source_(write|write_files|compile|publish|save|create)$/,
  /^(connector|asset|entity|skill|extension)_(compile|save|publish)$/,
  /^(connector|asset|entity|skill|extension)_registry_publish$/,
  // Mirror the explicit `skills_` (plural) mutations above so future siblings are caught.
  /^skills_(personal|installed)_(upsert|create_or_update|create|save|publish)$/,
  /^skills_packages_install(_from_[a-z]+)?$/,
];

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function requiresExtensionImplementationConfirmation(toolName: string): boolean {
  if (EXTENSION_IMPLEMENTATION_TOOLS.has(toolName)) return true;
  return FUTURE_EXTENSION_AUTHORING_PATTERNS.some((pattern) => pattern.test(toolName));
}

function isExplicitUserConfirmation(content: string): boolean {
  const text = normalizeText(content);
  if (!text) return false;
  if (/\b(no|nope|don't|do not|stop|cancel|wait|hold off|not yet|pause)\b/.test(text)) {
    return false;
  }
  return (
    /\b(yes|yeah|yep|sure|ok|okay|confirmed|confirm|proceed|go ahead|do it|start|build it|implement it|make it|create it|extend it)\b/.test(text) ||
    /\b(build|create|make|implement|scaffold|author)\s+(it|this|that|one|the new one|the agent|the extension|something new)\b/.test(text)
  );
}

function assistantAskedForImplementationConfirmation(content: string): boolean {
  const text = normalizeText(content);
  if (!text) return false;

  const mentionsExtensionKind =
    /\b(agent|extension|connector|asset|entity|skill package|package)\b/.test(text);
  const mentionsImplementation =
    /\b(build|create|make|implement|author|scaffold|write|start|publish)\b/.test(text);
  const asksPermission =
    text.includes("?") &&
    /\b(should i|shall i|do you want|would you like|can i|may i|confirm|okay|ok|proceed|go ahead)\b/.test(text);

  return mentionsExtensionKind && mentionsImplementation && asksPermission;
}

export function hasRecentExtensionImplementationConfirmation(
  messages: ConfirmationMessage[],
): boolean {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return false;

  const latestUser = messages[lastUserIndex];
  if (!isExplicitUserConfirmation(latestUser.content)) return false;

  const lowerBound = Math.max(0, lastUserIndex - CONFIRMATION_WINDOW);
  for (let i = lastUserIndex - 1; i >= lowerBound; i -= 1) {
    const message = messages[i];
    if (message.role === "user") break;
    if (
      message.role === "assistant" &&
      assistantAskedForImplementationConfirmation(message.content)
    ) {
      return true;
    }
  }

  return false;
}

export function buildExtensionImplementationConfirmationRequiredResult(toolName: string) {
  return {
    error:
      "Before implementing a new Cinatra agent or extension, ask the user in the conversation to confirm the specific implementation plan, then wait for their explicit approval.",
    code: EXTENSION_IMPLEMENTATION_CONFIRMATION_REQUIRED_CODE,
    toolName,
    nextStep:
      "Reply to the user with a short summary of what you plan to build and ask if you should start implementing it. Do not call implementation tools again until the user confirms.",
  };
}

export function buildExtensionImplementationConfirmationPolicy(): string {
  return (
    "\n\nExtension implementation confirmation policy:\n" +
    "- Discovery and planning are allowed without confirmation: list/read existing agents, search the marketplace, and inspect examples.\n" +
    "- Before you implement a new Cinatra agent or any other Cinatra extension, double-check in the conversation with a short summary of what you plan to build and ask whether to start implementing it.\n" +
    "- Before the user confirms, describe the plan conditionally: say \"I would build\" or \"I can build\", not \"I am building\" or \"I will build\".\n" +
    "- Do not call implementation tools such as agent_compile, agent_save, agent_source_write_files, agent_source_write, agent_source_compile, agent_source_publish, agent_registry_publish, skills_personal_upsert, skills_personal_skill_create_or_update, skills_installed_upsert, skills_packages_install_from_github, or future extension source write/compile/publish/install tools until the latest user reply explicitly confirms your question.\n" +
    "- If a tool returns extension_implementation_confirmation_required, stop using tools, ask for confirmation in chat, and wait for the user's reply."
  );
}
