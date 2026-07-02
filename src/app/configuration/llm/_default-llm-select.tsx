"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setDefaultProvidersAction } from "@/app/campaigns/actions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TriangleAlert } from "lucide-react";

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
   * The admin opt-in for uploading catalog skills to Anthropic Custom Skills.
   * DEFAULT OFF. Anthropic Custom Skills are NOT ZDR-eligible — see the
   * always-visible non-ZDR warning rendered alongside the toggle. This gates
   * every skill sync code path.
   */
  anthropicSkillSyncEnabled: boolean;
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
  anthropicSkillSyncEnabled,
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

  // Controlled opt-in. Seeded from the persisted value
  // (default OFF). `handleSave` ALWAYS submits an explicit "true"/"false"
  // string — never relies on checkbox-absence — so the operator can both
  // enable AND disable it reliably.
  const [skillSyncEnabled, setSkillSyncEnabled] = useState(
    anthropicSkillSyncEnabled === true,
  );

  const [pending, startTransition] = useTransition();

  const bothLocked = false; // classification model is always editable

  function handleSave() {
    const formData = new FormData();
    formData.set("defaultProvider", llmValue);
    formData.set("imageProvider", imageValue);
    formData.set("classificationModel", classifModel);
    // Per-purpose agent-creation override.
    formData.set("agentCreationLlmProvider", acProvider);
    if (acModel) formData.set("agentCreationModel", acModel);
    // ALWAYS an explicit string so the action can
    // distinguish on/off from a legacy caller that never sent the field.
    formData.set("anthropicSkillSyncEnabled", skillSyncEnabled ? "true" : "false");
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

      <Separator className="my-4" />

      {/* Row 4: Agent creation (preview).
          The per-purpose Anthropic selection surface. Selecting Anthropic here
          is a genuine per-purpose override wired to `agent_creation_*` settings
          — it NEVER changes the global default (Row 1 stays OpenAI). */}
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

      <Separator className="my-4" />

      {/* Anthropic skill-upload governance (cinatra#613).
          Anthropic-specific config only makes sense once the Anthropic
          connector is set up, so this section is gated on `anthropicConnected`.
          That flag derives from durable connector setup state (a saved Nango
          connection), NOT a live healthcheck — a momentary Anthropic outage
          will not make the section vanish.

          The opt-in defaults OFF and gates EVERY skill sync code path.
          The non-ZDR warning is ALWAYS rendered (visible even before opt-in)
          so the operator gives informed consent before enabling. */}
      {anthropicConnected ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <Label
                htmlFor="anthropic-skill-sync-enabled"
                className="text-sm font-medium text-foreground"
              >
                Upload skill content to Anthropic
              </Label>
              <p className="text-xs text-muted-foreground">
                Sync catalog skills to Anthropic Custom Skills so Anthropic-pinned
                agents can use them. Default off. Individual skills are excluded
                unless explicitly allowed per skill.
              </p>
            </div>
            <Switch
              id="anthropic-skill-sync-enabled"
              checked={skillSyncEnabled}
              onCheckedChange={setSkillSyncEnabled}
              aria-label="Enable Anthropic skill upload"
            />
          </div>

          <Alert variant="warning" className="rounded-control">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>Data residency — not ZDR-eligible</AlertTitle>
            <AlertDescription>
              Anthropic Custom Skills are <strong>not ZDR-eligible</strong>.
              Enabling this uploads skill bodies <strong>and their bundled
              directories</strong> off this instance to Anthropic Custom Skills
              (workspace / API-key-wide), where Anthropic <strong>retains</strong>{" "}
              them. This is materially different from OpenAI&apos;s local-shell
              skill read, where skill content never leaves the instance. Only
              skills explicitly allowed per skill are uploaded; all others stay
              local even when this is on.
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        // Connector not set up: hide the full Anthropic governance section but
        // keep a discoverable connect affordance (cinatra#613 acceptance).
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Connect Anthropic to configure Claude-powered agents and skill upload.
          </p>
          <Button asChild variant="outline">
            <Link href="/connectors/cinatra-ai/anthropic-connector/setup">
              Connect Anthropic
            </Link>
          </Button>
        </div>
      )}

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
