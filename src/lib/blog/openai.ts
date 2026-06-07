import "server-only";

import { uploadFile, deleteFile, generateWithFileInput, resolveConfiguredLlmRuntime, runResolvedSkillAwareDeterministicLlmTask, parseStructuredJson } from "@cinatra-ai/llm";
import type { LlmFileReference } from "@cinatra-ai/llm";
import { createDeterministicSkillsClient } from "@cinatra-ai/skills/mcp-client";
import { ensureSkillForCapability } from "@cinatra-ai/skills";
import type { AvailableTranscriptOption } from "./store";

// ---------------------------------------------------------------------------
// Blog generation resolves its skills by stable, package-OWNED capability key
// (declared in the providing extension's `cinatra.capabilities`), never by a
// hardcoded extension package name or on-disk SKILL.md path. The generic
// `ensureSkillForCapability` resolver maps the key → the active extension's
// skillId AND lazily registers its SKILL.md body into the catalog. This is the
// true-IoC contract: core names a capability; whichever installed extension
// declares it provides the skill.
// ---------------------------------------------------------------------------

const BLOG_IDEAS_CAPABILITY = "blog.generate-ideas";
const BLOG_DRAFT_CAPABILITY = "blog.generate-post-draft";
const BLOG_LINKEDIN_CAPABILITY = "blog.generate-linkedin-post";

const skillPromptCache = new Map<string, string>();

async function getSystemPrompt(capabilityKey: string): Promise<string> {
  const skillId = await ensureSkillForCapability(capabilityKey);

  const cached = skillPromptCache.get(skillId);
  if (cached !== undefined) return cached;

  const client = createDeterministicSkillsClient({
    actor: { actorType: "system", source: "worker" },
  });
  const skill = await client.installed.get(skillId);
  if (!skill) throw new Error(`Skill not found: ${skillId}`);
  const body = skill.body ?? skill.content ?? "";
  skillPromptCache.set(skillId, body);
  return body;
}

type UploadedFile = {
  ref: LlmFileReference;
  transcriptId: string;
  transcriptTitle: string;
};

type BlogIdeaResponse = {
  ideas?: Array<{
    transcriptId?: string;
    title?: string;
    summary?: string;
  }>;
};

type BlogPostDraftResponse = {
  excerpt?: string;
  content?: string;
};

type LinkedInPostDraftResponse = {
  content?: string;
};

async function uploadTranscriptFile(input: {
  transcriptId: string;
  title: string;
  transcript: string;
}) {
  const filename = `${input.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "transcript"}.txt`;
  const content = new TextEncoder().encode(input.transcript);

  return uploadFile({
    content,
    filename,
    mimeType: "text/plain",
    purpose: "user_data",
  });
}

export async function deleteUploadedFile(fileRef: LlmFileReference) {
  await deleteFile(fileRef).catch(() => null);
}

export async function uploadTranscriptFiles(transcripts: AvailableTranscriptOption[]) {
  const uploaded: UploadedFile[] = [];
  for (const transcript of transcripts) {
    const ref = await uploadTranscriptFile({
      transcriptId: transcript.id,
      title: transcript.title,
      transcript: transcript.transcript,
    });
    uploaded.push({
      ref,
      transcriptId: transcript.id,
      transcriptTitle: transcript.title,
    });
  }
  return uploaded;
}

export async function generateBlogPostIdeasWithOpenAI(input: {
  projectName: string;
  companyUrl: string;
  ideasPerTranscript: number;
  transcripts: AvailableTranscriptOption[];
  uploadedFiles: UploadedFile[];
}) {
  const transcriptManifest = input.uploadedFiles
    .map((file, index) => `${index + 1}. transcriptId=${file.transcriptId} | title=${file.transcriptTitle}`)
    .join("\n");

  const systemPrompt = await getSystemPrompt(BLOG_IDEAS_CAPABILITY);

  // For multi-file input, use the first file's ID and include all file references in the prompt
  // TODO: When the adapter supports multiple file_ids, pass them all
  const primaryFileId = input.uploadedFiles[0]?.ref.id;
  if (!primaryFileId) {
    throw new Error("No uploaded transcript files provided.");
  }

  const detailed = await generateWithFileInput({
    system: systemPrompt,
    prompt: [
      `Project name: ${input.projectName}`,
      `Target company URL: ${input.companyUrl}`,
      `Create exactly ${input.ideasPerTranscript} blog post ideas per transcript file.`,
      "For each idea, write a concise title and a short summary describing the angle.",
      "Transcript manifest:",
      transcriptManifest,
    ].join("\n\n"),
    fileId: primaryFileId,
    maxTokens: 3000,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ideas"],
      properties: {
        ideas: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["transcriptId", "title", "summary"],
            properties: {
              transcriptId: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
            },
          },
        },
      },
    },
    logLabel: "blog-post-ideas",
  });

  const parsed = parseStructuredJson<BlogIdeaResponse>(detailed?.text ?? "");
  const ideas = Array.isArray(parsed?.ideas)
    ? parsed.ideas
        .map((idea) => ({
          transcriptId: String(idea.transcriptId ?? ""),
          title: String(idea.title ?? "").trim(),
          summary: String(idea.summary ?? "").trim(),
        }))
        .filter((idea) => idea.transcriptId && idea.title && idea.summary)
    : [];

  if (ideas.length === 0) {
    throw new Error("The LLM provider did not return any blog post ideas.");
  }

  const transcriptById = new Map(input.transcripts.map((transcript) => [transcript.id, transcript]));
  return ideas.map((idea) => ({
    transcriptId: idea.transcriptId,
    transcriptTitle: transcriptById.get(idea.transcriptId)?.title ?? "Transcript",
    title: idea.title,
    summary: idea.summary,
  }));
}

export async function generateBlogPostDraftWithOpenAI(input: {
  companyUrl: string;
  projectName: string;
  ideaTitle: string;
  ideaSummary: string;
  transcriptTitle: string;
  transcript: string;
}) {
  const transcriptFileRef = await uploadTranscriptFile({
    transcriptId: input.transcriptTitle,
    title: input.transcriptTitle,
    transcript: input.transcript,
  });

  try {
    const draftSystemPrompt = await getSystemPrompt(BLOG_DRAFT_CAPABILITY);

    const detailed = await generateWithFileInput({
      system: draftSystemPrompt,
      prompt: [
        `Project name: ${input.projectName}`,
        `Company URL: ${input.companyUrl}`,
        `Selected idea title: ${input.ideaTitle}`,
        `Selected idea summary: ${input.ideaSummary}`,
        `Attached transcript title: ${input.transcriptTitle}`,
        "Use the company website as the primary style reference and the attached transcript only as supporting source material.",
        "Only use the portions of the transcript that are relevant to the selected idea, and generalize those thoughts so the result reads as original company content.",
      ].join("\n\n"),
      fileId: transcriptFileRef.id,
      maxTokens: 8000,
      reasoningEffort: "low",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["excerpt", "content"],
        properties: {
          excerpt: {
            type: "string",
            description: "A concise editable teaser text for the post, ideally 1-3 sentences.",
          },
          content: {
            type: "string",
            description: "The full blog post draft in markdown.",
          },
        },
      },
      logLabel: "blog-post-draft",
    });

    const parsed = parseStructuredJson<BlogPostDraftResponse>(detailed?.text ?? "");
    const excerpt = String(parsed?.excerpt ?? "").trim();
    const content = String(parsed?.content ?? "").trim();
    if (!content) {
      throw new Error("The LLM provider did not return any blog post content.");
    }

    return { excerpt, content };
  } finally {
    await deleteUploadedFile(transcriptFileRef);
  }
}

export async function generateLinkedInPostDraftWithOpenAI(input: {
  companyUrl: string;
  postTitle: string;
  postExcerpt: string;
  blogPostContent: string;
  blogPostUrl: string;
  destinationType: "member" | "organization";
  destinationName: string;
}) {
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) {
    throw new Error("No LLM provider configured. Set up OpenAI or Claude in LLM first.");
  }

  // Deliver the LinkedIn-post skill as a skill tool so it appears in the LLM
  // request log. Resolve its skillId by capability (lazily registering the
  // SKILL.md body) — no hardcoded extension package/path.
  const linkedinSkillId = await ensureSkillForCapability(BLOG_LINKEDIN_CAPABILITY);
  const detailed = await runResolvedSkillAwareDeterministicLlmTask({
    runtime,
    skillIds: [linkedinSkillId],
    system: "You are a LinkedIn post drafting assistant.",
    user: [
      `Company URL: ${input.companyUrl}`,
      `Destination type: ${input.destinationType}`,
      `Destination name: ${input.destinationName}`,
      `Blog post title: ${input.postTitle}`,
      `Blog post URL: ${input.blogPostUrl}`,
      input.postExcerpt ? `Blog post excerpt: ${input.postExcerpt}` : undefined,
      `Blog post content:\n${input.blogPostContent.slice(0, 7000)}`,
      "Return one finished LinkedIn post only.",
      "The final line should be only the blog post URL.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    maxOutputTokens: 1800,
    reasoningEffort: "low",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          type: "string",
          description: "A finished LinkedIn post draft in plain text.",
        },
      },
    },
    logLabel: "blog-post-linkedin-draft",
  });

  const parsed = parseStructuredJson<LinkedInPostDraftResponse>(detailed?.text ?? "");
  const content = String(parsed?.content ?? "").trim();
  if (!content) {
    throw new Error("The LLM provider did not return any LinkedIn post content.");
  }

  return { content };
}
