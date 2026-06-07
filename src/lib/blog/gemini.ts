import "server-only";

import { resolveDefaultImageAdapter } from "@cinatra-ai/llm";

type CompanyStyleReference = {
  pageTitle?: string;
  metaDescription?: string;
  themeColor?: string;
  visibleTextSample?: string;
};

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function extractMetaContent(html: string, name: string) {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  return decodeHtmlEntities(pattern.exec(html)?.[1] ?? "").trim() || undefined;
}

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return collapseWhitespace(decodeHtmlEntities(match?.[1] ?? "")) || undefined;
}

function extractVisibleTextSample(html: string) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return collapseWhitespace(decodeHtmlEntities(stripped)).slice(0, 800) || undefined;
}

async function readCompanyStyleReference(companyUrl: string): Promise<CompanyStyleReference> {
  try {
    const response = await fetch(companyUrl, {
      headers: {
        "user-agent": "Cinatra Blog Image Generator/1.0",
        accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return {};
    }

    const html = await response.text();
    return {
      pageTitle: extractTitle(html),
      metaDescription: extractMetaContent(html, "description") ?? extractMetaContent(html, "og:description"),
      themeColor: extractMetaContent(html, "theme-color"),
      visibleTextSample: extractVisibleTextSample(html),
    };
  } catch {
    return {};
  }
}

function buildImagePrompt(input: {
  projectName: string;
  companyUrl: string;
  ideaTitle: string;
  ideaSummary: string;
  blogPostContent: string;
  companyStyle: CompanyStyleReference;
}) {
  const styleLines = [
    input.companyStyle.pageTitle ? `Website page title: ${input.companyStyle.pageTitle}` : undefined,
    input.companyStyle.metaDescription ? `Website meta description: ${input.companyStyle.metaDescription}` : undefined,
    input.companyStyle.themeColor ? `Website theme color: ${input.companyStyle.themeColor}` : undefined,
    input.companyStyle.visibleTextSample ? `Visible website text sample: ${input.companyStyle.visibleTextSample}` : undefined,
  ].filter(Boolean);

  return [
    "Create one original landscape 16:9 hero image for a company blog post.",
    "Visualize the main point of the blog post in a clean, modern, editorial website style.",
    "The image should feel like it belongs on the company's website and should match its visual tone, color direction, and level of sophistication as closely as the provided website cues allow.",
    "Do not include any text, letters, logos, UI screenshots, watermarks, or split-panel layouts.",
    "Avoid showing named people, podcast guests, speakers, or recognizable brands from the source material.",
    "Prefer a polished marketing-editorial illustration or art-directed scene that communicates the main business idea clearly.",
    "",
    `Project name: ${input.projectName}`,
    `Company URL: ${input.companyUrl}`,
    `Blog post idea title: ${input.ideaTitle}`,
    `Blog post idea summary: ${input.ideaSummary}`,
    `Blog post content:\n${input.blogPostContent.slice(0, 6000)}`,
    styleLines.length > 0 ? `Website style cues:\n${styleLines.join("\n")}` : "Website style cues: unavailable, use a tasteful modern website hero style.",
  ].join("\n");
}

export async function generateBlogPostImage(input: {
  projectName: string;
  companyUrl: string;
  ideaTitle: string;
  ideaSummary: string;
  blogPostContent: string;
  customPrompt?: string;
}) {
  const adapter = await resolveDefaultImageAdapter();
  if (!adapter) {
    throw new Error("No image generation provider is configured. Connect Gemini, OpenAI, or Anthropic in LLM settings.");
  }

  const companyStyle = await readCompanyStyleReference(input.companyUrl);
  const basePrompt = buildImagePrompt({
    projectName: input.projectName,
    companyUrl: input.companyUrl,
    ideaTitle: input.ideaTitle,
    ideaSummary: input.ideaSummary,
    blogPostContent: input.blogPostContent,
    companyStyle,
  });

  const prompt = input.customPrompt?.trim()
    ? [
        "Follow this additional image direction exactly:",
        input.customPrompt.trim(),
        "",
        "Required context for the image:",
        basePrompt,
      ].join("\n")
    : basePrompt;

  const image = await adapter.generateImage!({
    prompt,
    logLabel: "blog-post-image",
  });

  if (!image) {
    throw new Error("The image generation provider did not return an image.");
  }

  return {
    imageBase64: image.imageData,
    imageMimeType: image.mimeType,
    imagePrompt: prompt,
    model: adapter.defaultModel,
  };
}
