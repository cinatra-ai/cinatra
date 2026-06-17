import { describe, expect, it } from "vitest";
import {
  EXTENSION_IMPLEMENTATION_CONFIRMATION_REQUIRED_CODE,
  buildExtensionImplementationConfirmationRequiredResult,
  hasRecentExtensionImplementationConfirmation,
  requiresExtensionImplementationConfirmation,
  type ConfirmationMessage,
} from "../extension-confirmation";

describe("chat extension implementation confirmation", () => {
  it("requires confirmation for agent and future extension authoring tools", () => {
    expect(requiresExtensionImplementationConfirmation("agent_source_write_files")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("agent_compile")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("agent_registry_publish")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("connector_source_write")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("extension_registry_publish")).toBe(true);

    expect(requiresExtensionImplementationConfirmation("agent_source_list")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("agent_source_read")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("extensions_search")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("agent_run")).toBe(false);
  });

  it("requires confirmation for workflow PACKAGE authoring (workflow_source_*), NOT workflow draft/instance tools", () => {
    // SDK-P5 (eng#167): the workflow_source_* package mutators gate exactly
    // like the agent_source_* tools.
    expect(requiresExtensionImplementationConfirmation("workflow_source_write")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("workflow_source_compile")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("workflow_source_publish")).toBe(true);
    // workflow_source_validate is read-only — it does NOT carry a write/compile/
    // publish/save/create verb, so it must NOT gate.
    expect(requiresExtensionImplementationConfirmation("workflow_source_validate")).toBe(false);
    // The workflow DRAFT/INSTANCE runtime tools are a DIFFERENT surface (a
    // proposal-only chat flow), NOT package authoring — they must NOT gate here.
    expect(requiresExtensionImplementationConfirmation("workflow_draft_create")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("workflow_draft_update")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("workflow_template_instantiate")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("workflow_validate")).toBe(false);
  });

  it("requires confirmation for artifact PACKAGE authoring (artifact_source_*), NOT the artifact INSTANCE emit", () => {
    // SDK-P5 (eng#167) vertical 2: artifact_source_* package mutators gate
    // exactly like agent_source_*/workflow_source_*.
    expect(requiresExtensionImplementationConfirmation("artifact_source_write")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("artifact_source_compile")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("artifact_source_publish")).toBe(true);
    // Read-only validate does NOT gate.
    expect(requiresExtensionImplementationConfirmation("artifact_source_validate")).toBe(false);
    // artifact_authoring_emit is an artifact INSTANCE emit (a DIFFERENT surface,
    // recursion-ledger-gated + matcher-suppressed) — it must NOT gate here.
    expect(requiresExtensionImplementationConfirmation("artifact_authoring_emit")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("artifact_extension_search")).toBe(false);
  });

  it("requires confirmation for skill PACKAGE authoring (skill_source_*), distinct from skills_* row/install gating", () => {
    // SDK-P5 (eng#167) vertical 2: the SINGULAR skill_source_* package mutators
    // gate like agent_source_*. (The PLURAL skills_* row/install mutations have
    // their own gating, asserted in the skills_* test below.)
    expect(requiresExtensionImplementationConfirmation("skill_source_write")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("skill_source_compile")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("skill_source_publish")).toBe(true);
    // Read-only validate does NOT gate.
    expect(requiresExtensionImplementationConfirmation("skill_source_validate")).toBe(false);
  });

  it("requires confirmation for skills_* authoring/install mutations exposed to chat", () => {
    // Cinatra MCP exposes skills primitives under `skills_` (plural). The matcher must catch
    // them just like it catches agent_* authoring tools — otherwise the assistant can silently
    // create or install extensions without the confirmation gate.
    expect(requiresExtensionImplementationConfirmation("skills_personal_upsert")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("skills_personal_skill_create_or_update")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("skills_installed_upsert")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("skills_packages_install_from_github")).toBe(true);

    // Read paths stay open — discovery before confirmation must remain frictionless.
    expect(requiresExtensionImplementationConfirmation("skills_personal_list")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("skills_personal_get")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("skills_packages_list")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("skills_installed_list")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("skills_catalog_list")).toBe(false);

    // Destructive ops are NOT extension-authoring (different gate, different policy).
    // Verify the install regex does not accidentally match uninstall.
    expect(requiresExtensionImplementationConfirmation("skills_packages_uninstall")).toBe(false);
    expect(requiresExtensionImplementationConfirmation("skills_personal_delete")).toBe(false);

    // Future install variants caught by the regex pattern (without needing an explicit entry).
    expect(requiresExtensionImplementationConfirmation("skills_packages_install")).toBe(true);
    expect(requiresExtensionImplementationConfirmation("skills_packages_install_from_gitlab")).toBe(true);
  });

  it("does not treat the user's initial build request as confirmation", () => {
    const messages: ConfirmationMessage[] = [
      {
        role: "user",
        content: "Go ahead and create a new agent that researches accounts.",
      },
    ];

    expect(hasRecentExtensionImplementationConfirmation(messages)).toBe(false);
  });

  it("allows implementation after an assistant double-check and explicit user approval", () => {
    const messages: ConfirmationMessage[] = [
      {
        role: "user",
        content: "Create a new account research agent.",
      },
      {
        role: "assistant",
        content:
          "I found no existing agent that matches. I can build a new account research agent with Apollo enrichment and a review gate. Should I start implementing it?",
      },
      {
        role: "user",
        content: "Yes, go ahead.",
      },
    ];

    expect(hasRecentExtensionImplementationConfirmation(messages)).toBe(true);
  });

  it("allows an option-style confirmation after the assistant asks", () => {
    const messages: ConfirmationMessage[] = [
      {
        role: "assistant",
        content:
          "I found an existing local agent, but it only covers half of the workflow. Do you want me to build something new?",
      },
      {
        role: "user",
        content: "Build something new.",
      },
    ];

    expect(hasRecentExtensionImplementationConfirmation(messages)).toBe(true);
  });

  it("rejects negative replies even after the assistant asks", () => {
    const messages: ConfirmationMessage[] = [
      {
        role: "assistant",
        content: "I can scaffold this as a new Cinatra extension. Should I proceed?",
      },
      {
        role: "user",
        content: "Not yet.",
      },
    ];

    expect(hasRecentExtensionImplementationConfirmation(messages)).toBe(false);
  });

  it("returns a structured tool result that tells the model to ask in chat", () => {
    const result = buildExtensionImplementationConfirmationRequiredResult("agent_source_write");

    expect(result.code).toBe(EXTENSION_IMPLEMENTATION_CONFIRMATION_REQUIRED_CODE);
    expect(result.error).toContain("ask the user in the conversation");
    expect(result.nextStep).toContain("Do not call implementation tools again");
  });
});
