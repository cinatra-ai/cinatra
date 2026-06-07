// add-extension-from-chat (thin).
//
// A chat admin pastes a source ref; this module detects the source type
// (GitHub URL / Verdaccio package@version / local path / npm package name),
// builds a structured proposal, and — on admin/release-manager confirm —
// the lifecycle primitive executes the install. Chat does NOT define the
// lifecycle model; it's a thin propose-confirm wrapper.
import "server-only";

import type { ExtensionKind, ExtensionSource } from "./canonical-types";

export type DetectedSourceRef =
  | { type: "github"; repo: string; ref?: string; path?: string; raw: string }
  | { type: "verdaccio"; packageName: string; version?: string; raw: string }
  | { type: "local"; path: string; raw: string }
  | { type: "npm"; packageName: string; version?: string; raw: string };

export class SourceDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceDetectionError";
  }
}

const GITHUB_URL_RE =
  /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#@]+?)(?:\.git)?(?:@([^/\s#]+))?(?:#(.+))?$/i;
// scoped (@scope/name) or unscoped (name), optional @version suffix.
const PKG_AT_VERSION_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~]+|[a-z0-9-~][a-z0-9-._~]*)(?:@(.+))?$/i;

/**
 * Detect the source type from a raw chat-pasted ref. Throws
 * SourceDetectionError when nothing matches (the chat surfaces the
 * structured error).
 */
export function detectSourceRef(raw: string): DetectedSourceRef {
  const trimmed = raw.trim();
  if (!trimmed) throw new SourceDetectionError("empty source ref");

  // 1) Local file path — file:// URL or absolute/relative fs path.
  if (trimmed.startsWith("file://")) {
    return { type: "local", path: trimmed.slice("file://".length), raw: trimmed };
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return { type: "local", path: trimmed, raw: trimmed };
  }

  // 2) GitHub URL (github.com/owner/repo[@ref][#path]).
  const gh = GITHUB_URL_RE.exec(trimmed);
  if (gh) {
    const [, owner, repo, ref, path] = gh;
    return {
      type: "github",
      repo: `${owner}/${repo}`,
      ...(ref ? { ref } : {}),
      ...(path ? { path } : {}),
      raw: trimmed,
    };
  }

  // 3) Verdaccio registry URL (explicit).
  if (/verdaccio|registry\.cinatra\.ai|:4873/i.test(trimmed) && /\/-\//.test(trimmed)) {
    // crude: pull the package name out of a /-/ tarball URL is unreliable;
    // surface as a structured error and ask the admin for package@version.
    throw new SourceDetectionError(
      "Detected a registry tarball URL — paste the package name as 'name@version' instead.",
    );
  }

  // 4) package-name[@version] — scoped or unscoped. Treat @cinatra-ai/* as
  //    Verdaccio (private registry); everything else as npm (proxied/public).
  const pkg = PKG_AT_VERSION_RE.exec(trimmed);
  if (pkg) {
    const [, packageName, version] = pkg;
    const isPrivateScope = packageName!.startsWith("@cinatra-ai/") || packageName!.startsWith("@cinatra/");
    return {
      type: isPrivateScope ? "verdaccio" : "npm",
      packageName: packageName!,
      ...(version ? { version } : {}),
      raw: trimmed,
    };
  }

  throw new SourceDetectionError(
    `Could not detect a source from '${trimmed}'. Supported: github.com/owner/repo[@ref], name@version, file:///path.`,
  );
}

export type ExtensionProposal = {
  detected: DetectedSourceRef;
  /** Resolved canonical source (provenance to be verified at install). */
  source: ExtensionSource;
  /** Kind read from the manifest's cinatra.kind by the caller. */
  kind: ExtensionKind | "unknown";
  /** Human-readable summary the chat surfaces for confirm. */
  summary: string;
  /** True until the admin/release-manager confirms. */
  requiresConfirmation: true;
};

/**
 * Build a thin proposal from a detected ref. `resolveKind` is injected by the
 * caller (it reads the manifest's cinatra.kind — kept out of this pure module
 * so detection stays testable without network).
 */
export function buildProposal(
  detected: DetectedSourceRef,
  opts: { kind?: ExtensionKind; registryUrl?: string } = {},
): ExtensionProposal {
  const kind = opts.kind ?? "unknown";
  let source: ExtensionSource;
  switch (detected.type) {
    case "github":
      source = {
        type: "github",
        repo: detected.repo,
        ref: detected.ref ?? "HEAD",
        resolvedSha: "pending-resolution",
        ...(detected.path ? { path: detected.path } : {}),
      };
      break;
    case "verdaccio":
    case "npm":
      source = {
        type: "verdaccio",
        registryUrl: opts.registryUrl ?? "http://localhost:4873",
        packageName: detected.packageName,
        version: detected.version ?? "latest",
        integrity: "pending-resolution",
      };
      break;
    case "local":
      source = {
        type: "local",
        path: detected.path,
        resolvedCommitOrTreeHash: "pending-resolution",
      };
      break;
  }

  const label =
    detected.type === "github"
      ? `GitHub ${detected.repo}${detected.ref ? `@${detected.ref}` : ""}`
      : detected.type === "local"
        ? `local path ${detected.path}`
        : `${detected.packageName}${detected.version ? `@${detected.version}` : ""}`;

  return {
    detected,
    source,
    kind,
    summary: `Install ${kind === "unknown" ? "extension" : kind} from ${label}. Confirm to proceed (release-manager/admin required).`,
    requiresConfirmation: true,
  };
}
