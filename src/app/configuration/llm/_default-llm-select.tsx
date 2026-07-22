"use client";

import { useState, useTransition } from "react";
import { setDefaultProvidersAction } from "@/app/campaigns/actions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type DefaultProvidersCardProps = {
  defaultLlmProvider: string;
  defaultImageProvider: string;
  openaiConnected: boolean;
  anthropicConnected: boolean;
  geminiConnected: boolean;
  classificationModel: string;
  availableModels: string[];
  /**
   * Agent-creation per-purpose override. These props drive the "Agent creation
   * (preview)" section — a genuine per-purpose Anthropic selection that is
   * wired to `agent_creation_*` settings and NEVER to the global default.
   * Serialized string[] is passed from the server page so the connector package
   * never enters this client bundle.
   */
  anthropicModels: string[];
  /**
   * OpenAI model option set for the agent-creation section. MUST match the
   * server action's `AGENT_CREATION_OPENAI_MODELS` allow-list (gpt-5 family) —
   * the classification `availableModels` (gpt-4*) is a DIFFERENT purpose and
   * would be silently rejected by the action.
   */
  agentCreationOpenaiModels: string[];
  agentCreationProvider: string | null;
  agentCreationModel: string | null;
  /**
   * Whether the agent-creation readiness pin is active
   * (`isAgentCreationPinActive()`). It is hardcoded `false` today, so the
   * "Agent creation (preview)" row and its form fields stay HIDDEN — the pin
   * gates an inert subsystem and no live LLM call consumes the persisted
   * `agent_creation_*` settings. When the readiness gate flips, the row and its
   * write path light up together. Optional + default-off so existing callers /
   * tests that omit it keep the safe hidden behavior.
   */
  agentCreationPinActive?: boolean;
};

export function DefaultProvidersCard({
  defaultLlmProvider,
  defaultImageProvider,
  openaiConnected,
  anthropicConnected,
  geminiConnected,
  classificationModel,
  availableModels,
  anthropicModels,
  agentCreationOpenaiModels,
  agentCreationProvider,
  agentCreationModel,
  agentCreationPinActive = false,
}: DefaultProvidersCardProps) {
  // LLM provider — Anthropic deactivated; to re-enable: add anthropicConnected back to the array and add SelectItem below
  const llmConnectedCount = [openaiConnected].filter(Boolean).length;
  const llmLocked = llmConnectedCount === 1;
  const llmLockedValue = "openai";

  // Image generation provider — Anthropic deactivated; to re-enable: add "anthropic" back to the filter array and SelectItem below
  const imageConnected = { openai: openaiConnected, anthropic: anthropicConnected, gemini: geminiConnected };
  const imageConnectedProviders = (["openai", "gemini"] as const).filter((p) => imageConnected[p]);
  const imageLocked = imageConnectedProviders.length <= 1;
  const imageLockedValue = imageConnectedProviders[0] ?? "openai";

  const [llmValue, setLlmValue] = useState(llmLocked ? llmLockedValue : defaultLlmProvider);
  const [imageValue, setImageValue] = useState(imageLocked ? imageLockedValue : defaultImageProvider);
  const [classifModel, setClassifModel] = useState(classificationModel);

  // Agent-creation per-purpose override.
  // Initialize coherently — a stored model is only adopted when it belongs to
  // the stored provider's option set, so `openai` is never seeded with a Claude
  // model or vice-versa.
  const acInitialProvider = agentCreationProvider ?? "openai";
  const acInitialOptions =
    acInitialProvider === "anthropic" ? anthropicModels : agentCreationOpenaiModels;
  const acInitialModel =
    agentCreationModel && acInitialOptions.includes(agentCreationModel)
      ? agentCreationModel
      : acInitialOptions[0] ?? "";
  const [acProvider, setAcProvider] = useState(acInitialProvider);
  const [acModel, setAcModel] = useState(acInitialModel);
  const acModelOptions =
    acProvider === "anthropic" ? anthropicModels : agentCreationOpenaiModels;

  const [pending, startTransition] = useTransition();

  const bothLocked = false; // classification model is always editable

  function handleSave() {
    const formData = new FormData();
    formData.set("defaultProvider", llmValue);
    formData.set("imageProvider", imageValue);
    formData.set("classificationModel", classifModel);
    // Per-purpose agent-creation override. Only submit these fields when the
    // readiness pin is active — the row is hidden while it is inert, and the
    // server action ignores them anyway, but not sending them keeps the hidden
    // surface from persisting a value no live LLM call consumes.
    if (agentCreationPinActive) {
      formData.set("agentCreationLlmProvider", acProvider);
      if (acModel) formData.set("agentCreationModel", acModel);
    }
    startTransition(() => setDefaultProvidersAction(formData));
  }

  const IMAGE_PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Claude (Anthropic)",
    gemini: "Gemini",
  };

  return (
    <>
      {/* Row 1: Default LLM provider */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm font-medium text-foreground">Standard</p>
        <Select value={llmValue} onValueChange={setLlmValue} disabled={llmLocked}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            {/* <SelectItem value="anthropic">Claude (Anthropic)</SelectItem> — deactivated */}
          </SelectContent>
        </Select>
      </div>

      <Separator className="my-4" />

      {/* Row 2: Image generation provider */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm font-medium text-foreground">Image generation</p>
        {imageLocked ? (
          <Select value={imageLockedValue} disabled>
            <SelectTrigger className="w-48">
              <SelectValue>{IMAGE_PROVIDER_LABELS[imageLockedValue] ?? imageLockedValue}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={imageLockedValue}>{IMAGE_PROVIDER_LABELS[imageLockedValue] ?? imageLockedValue}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Select value={imageValue} onValueChange={setImageValue}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI</SelectItem>
              {/* <SelectItem value="anthropic">Claude (Anthropic)</SelectItem> — deactivated */}
              <SelectItem value="gemini">Gemini</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      <Separator className="my-4" />

      {/* Row 3: Objects classification model */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm font-medium text-foreground">Objects classification</p>
        <Select value={classifModel} onValueChange={setClassifModel}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableModels.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Row 4: Agent creation (preview) — HIDDEN while the readiness pin is
          inert. `isAgentCreationPinActive()` is hardcoded false today, so this
          per-purpose Anthropic selection (wired to `agent_creation_*` settings
          that NO live LLM call consumes) is not rendered at all: operators must
          not see a control that silently does nothing. The row and its write
          path (gated on the same flag in handleSave + campaigns/actions.ts)
          light up together when the readiness gate flips. It NEVER changes the
          global default (Row 1 stays OpenAI). */}
      {agentCreationPinActive && (
        <>
          <Separator className="my-4" />

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Agent creation</p>
                <p className="text-xs text-muted-foreground">
                  Per-purpose override. Takes effect after Anthropic skill governance
                  and sync are configured. Does not change the global default.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={acProvider}
                  onValueChange={(v) => {
                    setAcProvider(v);
                    setAcModel(
                      v === "anthropic"
                        ? (anthropicModels[0] ?? "")
                        : (agentCreationOpenaiModels[0] ?? ""),
                    );
                  }}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    {anthropicConnected && (
                      <SelectItem value="anthropic">Claude (Anthropic)</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Select value={acModel} onValueChange={setAcModel}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Default model" />
                  </SelectTrigger>
                  <SelectContent>
                    {acModelOptions.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Anthropic skill-upload governance retired from core (cinatra#1104):
          the opt-in + its non-ZDR data-residency advisory now live on the
          anthropic-connector Skills tab, which persists via the
          `@cinatra-ai/host:anthropic-skill-config` write capability. Core no
          longer renders a duplicate control here. */}

      {/* Single save button — hidden when both selects are locked */}
      {!bothLocked && (
        <div className="flex justify-end mt-4">
          <Button type="button" variant="outline" onClick={handleSave} disabled={pending}>
            Save defaults
          </Button>
        </div>
      )}
    </>
  );
}
