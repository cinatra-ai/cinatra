"use client";

import { useState, useTransition } from "react";
import {
  setDefaultLlmProviderAction,
  setDefaultProvidersAction,
} from "@/app/campaigns/actions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type DefaultProvidersCardProps = {
  defaultLlmProvider: string;
  /**
   * S3 (cinatra#2388): the FULL default-capable provider set, serialized by
   * the server page from the ABI v2 `defaultCapable` declarations. The LLM
   * provider selector is ENABLED and offers exactly this set; the change posts
   * to the EXPLICIT split action (`setDefaultLlmProviderAction`), which routes
   * through the provider-commit machine's Administration transition. Optional
   * + defaulted so existing callers keep the previous single-provider render.
   */
  defaultCapableProviders?: string[];
  defaultImageProvider: string;
  openaiConnected: boolean;
  anthropicConnected: boolean;
  geminiConnected: boolean;
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
   * server action's `AGENT_CREATION_OPENAI_MODELS` allow-list (gpt-5 family);
   * anything outside it is silently rejected by the action.
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
  defaultCapableProviders = ["openai"],
  defaultImageProvider,
  openaiConnected,
  anthropicConnected,
  geminiConnected,
  anthropicModels,
  agentCreationOpenaiModels,
  agentCreationProvider,
  agentCreationModel,
  agentCreationPinActive = false,
}: DefaultProvidersCardProps) {
  // S3 (cinatra#2388): the LLM provider selector is ENABLED with the full
  // default-capable set. The provider change is an EXPLICIT split action —
  // its own "Change provider" submit posting `setDefaultLlmProviderAction`
  // (the transactional Administration transition) — and the combined
  // "Save defaults" below never submits the provider.
  const llmOptions =
    defaultCapableProviders.length > 0 ? defaultCapableProviders : ["openai"];

  // Image generation provider — Anthropic deactivated; to re-enable: add "anthropic" back to the filter array and SelectItem below
  const imageConnected = { openai: openaiConnected, anthropic: anthropicConnected, gemini: geminiConnected };
  const imageConnectedProviders = (["openai", "gemini"] as const).filter((p) => imageConnected[p]);
  const imageLocked = imageConnectedProviders.length <= 1;
  const imageLockedValue = imageConnectedProviders[0] ?? "openai";

  const [llmValue, setLlmValue] = useState(
    llmOptions.includes(defaultLlmProvider) ? defaultLlmProvider : llmOptions[0],
  );
  const [imageValue, setImageValue] = useState(imageLocked ? imageLockedValue : defaultImageProvider);

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
  const [providerChangePending, startProviderChangeTransition] = useTransition();

  // The combined save is SETTINGS-ONLY (S3 cinatra#2388) — the provider row
  // has its own explicit submit and never rides this one. Settings are locked
  // when the image select is locked and the agent-creation row is hidden (its
  // readiness pin is inert). The "Objects classification" model row that used
  // to keep the card permanently editable is gone (cinatra#2335).
  const settingsLocked = imageLocked && !agentCreationPinActive;

  function handleSave() {
    const formData = new FormData();
    // Settings-only: the global default LLM provider is DELIBERATELY not
    // submitted here — its change is the explicit transactional action below.
    formData.set("imageProvider", imageValue);
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

  // The EXPLICIT provider change — its own intent, its own submit, routed
  // through the provider-commit machine's Administration transition.
  function handleChangeProvider() {
    const formData = new FormData();
    formData.set("provider", llmValue);
    startProviderChangeTransition(() => setDefaultLlmProviderAction(formData));
  }

  const PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Claude (Anthropic)",
    gemini: "Gemini",
  };
  const IMAGE_PROVIDER_LABELS = PROVIDER_LABELS;

  const providerDirty = llmValue !== defaultLlmProvider;

  return (
    <>
      {/* Row 1: Default LLM provider — ENABLED, full default-capable set,
          explicit split action (S3 cinatra#2388). */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">Standard</p>
          <p className="text-xs text-muted-foreground">
            Committed for this instance. Changing it is an explicit, audited
            transition.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={llmValue} onValueChange={setLlmValue}>
            <SelectTrigger className="w-48" data-testid="default-llm-provider-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {llmOptions.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABELS[p] ?? p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            onClick={handleChangeProvider}
            disabled={!providerDirty || providerChangePending}
            data-testid="default-llm-provider-change"
          >
            Change provider
          </Button>
        </div>
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

      {/* Row 3: Agent creation (preview) — HIDDEN while the readiness pin is
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

      {/* Single SETTINGS save button — hidden when no setting on the card is
          editable (image select locked AND the agent-creation row hidden).
          Never submits the provider (S3 cinatra#2388). */}
      {!settingsLocked && (
        <div className="flex justify-end mt-4">
          <Button type="button" variant="outline" onClick={handleSave} disabled={pending}>
            Save defaults
          </Button>
        </div>
      )}
    </>
  );
}
