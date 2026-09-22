// ---------------------------------------------------------------------------
// THE PER-SCOPE ASSIGNMENT PAGE (cinatra#2814, per-scope assignment S2; the
// drawing's per-agent assignment page).
//
// "The page holds to the Narrow column and opens on the §II detail header,
// which names the scope being configured above the package. Beneath it the
// two-pane Skills | Artifacts strip, drawn as the §II tab strip; an
// assistant's page renders the Skills pane alone and carries no strip at all."
//
// The strip is two links on the same address (`?tab=skills|artifacts`), so a
// pane is a server render of the pane the address names: a reload, a shared
// link and the card's Settings link all land on the same pane.
//
// On the workspace page the same panes carry one group per scope of the
// reader's workspace vantage (the cross-scope editor), each with its own write
// decision; everywhere else they carry the route's own scope alone.
// ---------------------------------------------------------------------------

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { resolveAgentCardVendor } from "@/components/extensions/agent-card-vendor";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@/lib/extension-accent";
import { scopeSurfaceBase } from "@/lib/scope-surfaces";
import {
  SCOPE_ASSIGNMENT_EFFECTIVE_SKILLS_PER_RUN,
  SCOPE_ASSIGNMENT_ROOT_TEST_ID,
  SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE,
  type ScopeAssignmentActionTarget,
} from "@/lib/scope-assignment/scope-assignment-model";
import type {
  ScopeAssignmentPageModel,
  ScopeAssignmentSectionModel,
} from "@/lib/scope-assignment/scope-assignment-page.server";
import { ScopeAssignmentSkills } from "./scope-assignment-skills";
import { ScopeAssignmentSlot } from "./scope-assignment-slot";

/** The pane's own address: the page's path with `?tab=<pane>`. */
export function scopeAssignmentPaneHref(model: ScopeAssignmentPageModel, pane: "skills" | "artifacts"): string {
  const { scope, surface, vendor, name } = model.target;
  const tree = surface === "agent" ? "agents" : "assistants";
  return `${scopeSurfaceBase(scope)}/${tree}/${vendor}/${name}/settings?tab=${pane}`;
}

function sectionTarget(
  model: ScopeAssignmentPageModel,
  section: ScopeAssignmentSectionModel,
): ScopeAssignmentActionTarget {
  return model.crossScope ? { ...model.target, section: section.scope } : model.target;
}

function canWrite(model: ScopeAssignmentPageModel, section: ScopeAssignmentSectionModel): boolean {
  return model.admission.ok && section.write.allowed;
}

function readOnlyMessage(model: ScopeAssignmentPageModel, section: ScopeAssignmentSectionModel): string | null {
  if (!model.admission.ok) return model.admission.message;
  return section.write.allowed ? null : section.write.message;
}

function SectionHeading({ model, section }: { model: ScopeAssignmentPageModel; section: ScopeAssignmentSectionModel }) {
  if (!model.crossScope) return null;
  return (
    <div
      data-slot="scope-assignment-section-label"
      className="font-mono text-badge-2xs font-bold uppercase text-muted-foreground"
    >
      {section.label}
    </div>
  );
}

function SkillsPane({ model }: { model: ScopeAssignmentPageModel }) {
  return (
    <section data-slot="scope-assignment-skills-pane" className="py-5.5">
      <h2 className="mb-1.5 text-lg font-bold text-foreground">Skills</h2>
      <p data-slot="scope-assignment-skill-limits" className="mb-3.5 text-xs text-muted-foreground">
        {`${SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE} per scope here, at most ${SCOPE_ASSIGNMENT_EFFECTIVE_SKILLS_PER_RUN} effective per run. Skills are assigned to the whole package, so every template it ships shares them.`}
      </p>
      <div className="flex flex-col gap-6">
        {model.sections.map((section) => (
          <div
            key={section.key}
            data-slot="scope-assignment-section"
            data-scope-key={section.key}
            className="flex flex-col gap-2"
          >
            <SectionHeading model={model} section={section} />
            <ScopeAssignmentSkills
              target={sectionTarget(model, section)}
              fieldId={`scope-skills-${section.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
              initialRows={section.skills ?? []}
              canWrite={canWrite(model, section)}
              readOnlyMessage={readOnlyMessage(model, section)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function ArtifactsEmpty({ model, title, description }: { model: ScopeAssignmentPageModel; title: string; description: string }) {
  return (
    <Empty data-testid="scope-assignment-artifacts-empty" data-manifest={model.manifest ?? undefined}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href={scopeAssignmentPaneHref(model, "skills")}>Go to Skills</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ArtifactsPane({ model }: { model: ScopeAssignmentPageModel }) {
  return (
    <section data-slot="scope-assignment-artifacts-pane" className="py-5.5">
      <h2 className="mb-1.5 text-lg font-bold text-foreground">Context artifacts</h2>
      <p className="mb-3.5 text-xs text-muted-foreground">
        The stored artifacts that supply background context to this agent’s runs through named slots in its manifest.
      </p>
      {model.manifest === "no-slots" ? (
        <ArtifactsEmpty
          model={model}
          title="No context slots"
          description="This agent’s manifest declares no context slots, so it takes no context artifacts."
        />
      ) : model.manifest === "unreadable" ? (
        <ArtifactsEmpty
          model={model}
          title="The manifest couldn’t be read"
          description="This agent’s installed manifest couldn’t be read, so its context slots can’t be shown right now."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {model.sections.map((section) => {
            const writable = canWrite(model, section);
            const message = readOnlyMessage(model, section);
            return (
              <div
                key={section.key}
                data-slot="scope-assignment-section"
                data-scope-key={section.key}
                className="flex flex-col"
              >
                <SectionHeading model={model} section={section} />
                {!writable && message ? (
                  <p data-slot="scope-context-read-only" className="mt-1 text-sm text-muted-foreground">
                    {message}
                  </p>
                ) : null}
                {(section.slots ?? []).map((group) => (
                  <ScopeAssignmentSlot
                    key={group.slotId}
                    target={sectionTarget(model, section)}
                    fieldId={`scope-slot-${section.key}-${group.slotId}`.replace(/[^a-zA-Z0-9_-]/g, "-")}
                    group={group}
                    canWrite={writable}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ScopeAssignmentPage({ model }: { model: ScopeAssignmentPageModel }) {
  const { bg } = ACCENT_PALETTE[deriveExtensionAccent(model.packageName)];
  const vendor = resolveAgentCardVendor({ host: "local", ref: model.packageName });
  const kindLabel = model.surface === "agent" ? "Agent" : "Assistant";
  const scopeId = "id" in model.routeScope ? model.routeScope.id : undefined;

  return (
    <div
      data-testid={SCOPE_ASSIGNMENT_ROOT_TEST_ID}
      data-surface={model.surface}
      data-package={model.packageName}
      data-scope-kind={model.routeScope.kind}
      data-scope-id={scopeId}
      data-tab={model.tab}
      data-cross-scope={model.crossScope ? "true" : "false"}
      className="mx-auto w-full max-w-[576px] px-6 py-8 sm:py-10"
    >
      {/* The §II detail header: the scope being configured, then the package. */}
      <div className="flex items-center gap-4.5">
        <div
          data-slot="scope-assignment-tile"
          className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[15px] border border-line bg-surface-strong shadow-sm"
          style={{ color: bg }}
        >
          {extensionKindEmblem("agent", "size-8.5")}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            data-slot="scope-assignment-scope"
            className="font-mono text-badge-2xs font-bold uppercase text-muted-foreground"
          >
            {model.scopeLabel}
          </div>
          <h1
            data-slot="scope-assignment-name"
            className="mt-1.5 font-display text-modal-title font-extrabold italic text-foreground"
          >
            {model.displayName}
          </h1>
          <p className="mt-2 flex items-center gap-1.25 text-sm text-muted-foreground">
            <span aria-hidden="true" className="shrink-0" style={{ color: bg }}>
              {extensionKindEmblem("agent", "size-3.5")}
            </span>
            <span className="min-w-0 truncate">
              <span className="text-foreground">{kindLabel}</span>
              {vendor.kind === "known" ? (
                <>
                  {" by "}
                  <span className="text-foreground">{vendor.displayName}</span>
                </>
              ) : null}
            </span>
          </p>
        </div>
      </div>

      {/* Double-etched header rule. */}
      <Separator major decorative className="mt-5 mb-1" />

      {model.surface === "agent" ? (
        // The §II tab strip: route links, the active pane driven by the
        // address, the etched rule running on from the last tab.
        <Tabs value={model.tab} className="mt-5">
          <div className="grid grid-cols-[auto_1fr] items-end gap-4.5">
            <TabsList aria-label="Assignment panes" className="gap-0 border-0">
              {(["skills", "artifacts"] as const).map((pane) => (
                <TabsTrigger
                  key={pane}
                  value={pane}
                  asChild
                  className="px-3.5 pt-2.25 pb-2.75 font-normal data-[state=active]:font-semibold"
                >
                  <Link data-slot={`scope-assignment-tab-${pane}`} href={scopeAssignmentPaneHref(model, pane)}>
                    {pane === "skills" ? "Skills" : "Artifacts"}
                  </Link>
                </TabsTrigger>
              ))}
            </TabsList>
            <Separator major decorative className="mb-2.75" />
          </div>
        </Tabs>
      ) : null}

      {model.surface === "agent" && model.tab === "artifacts" ? (
        <ArtifactsPane model={model} />
      ) : (
        <SkillsPane model={model} />
      )}
    </div>
  );
}
