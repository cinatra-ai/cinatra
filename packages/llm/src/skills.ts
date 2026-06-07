export type LlmProvider = "openai" | "gemini";

export type SkillArtifact = {
  id: string;
  kind: "package_skill" | "installed_skill" | "custom_skill";
  title: string;
  content: string;
};

export type SkillArtifactLoader = {
  load(input: {
    skillIds?: string[];
    customSkillContent?: string;
  }): Promise<SkillArtifact[]>;
};

export type SkillRenderer = {
  provider: LlmProvider;
  render(input: {
    artifacts: SkillArtifact[];
  }): string;
};

export function createSkillArtifactLoader(input: {
  resolveSkillId?: (skillId: string) => Promise<SkillArtifact | null>;
  createCustomSkillArtifact?: (content: string) => Promise<SkillArtifact | null> | SkillArtifact | null;
}): SkillArtifactLoader {
  return {
    async load(loadInput) {
      const artifacts: SkillArtifact[] = [];
      const seen = new Set<string>();

      for (const skillId of loadInput.skillIds ?? []) {
        const normalizedSkillId = String(skillId ?? "").trim();
        if (!normalizedSkillId || seen.has(normalizedSkillId)) {
          continue;
        }
        seen.add(normalizedSkillId);

        const artifact = await input.resolveSkillId?.(normalizedSkillId);
        if (artifact) {
          artifacts.push(artifact);
        }
      }

      const customSkillContent = loadInput.customSkillContent?.trim();
      if (customSkillContent) {
        const personalArtifact =
          (await input.createCustomSkillArtifact?.(customSkillContent)) ?? {
            id: "custom-skill",
            kind: "custom_skill" as const,
            title: "Custom Skill",
            content: customSkillContent,
          };
        artifacts.push(personalArtifact);
      }

      return artifacts;
    },
  };
}

function renderSkillArtifactsAsMarkdown(artifacts: SkillArtifact[], header: string) {
  if (artifacts.length === 0) {
    return "";
  }

  return [
    header,
    ...artifacts.map((artifact) =>
      [
        `## ${artifact.title}`,
        `id: ${artifact.id}`,
        `kind: ${artifact.kind}`,
        "",
        artifact.content.trim(),
      ].join("\n"),
    ),
  ].join("\n\n");
}

export const openAISkillRenderer: SkillRenderer = {
  provider: "openai",
  render({ artifacts }) {
    return renderSkillArtifactsAsMarkdown(artifacts, "Use these canonical skills as workflow instructions.");
  },
};

export const geminiSkillRenderer: SkillRenderer = {
  provider: "gemini",
  render({ artifacts }) {
    return renderSkillArtifactsAsMarkdown(artifacts, "Apply these canonical skills as workflow instructions.");
  },
};

export function renderSkillArtifacts(renderer: SkillRenderer, artifacts: SkillArtifact[]) {
  return renderer.render({ artifacts });
}
