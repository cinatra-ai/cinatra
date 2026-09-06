// ---------------------------------------------------------------------------
// extension-package-manifest.ts — what a supplied package SAYS it is, and
// whether it carries the payload to back that up (cinatra#3204).
//
// ONE implementation, deliberately, because there are two roads. The File road
// reads a ZIP; the GitHub road reads a repository tree. If each answered "what
// kind is this?" its own way, the same package could be admitted through one
// road and refused by the other — and the refusal messages an operator sees
// would depend on which tab they happened to open.
//
// So both roads call the functions below, and both get the same answer and the
// same wording. The rules are:
//
//   - THE DECLARED KIND IS READ, NEVER ASSUMED. `cinatra.kind` decides; an
//     absent, unknown or retired kind is refused with a message naming what was
//     found and what is accepted.
//   - THE DECLARATION MUST BE BACKED BY A PAYLOAD. A package declaring
//     `kind: "skill"` while shipping an agent's OAS document and no SKILL.md is
//     refused. The declaration is a claim; the payload is the evidence.
//   - A KIND SUFFIX IN THE NAME MUST NOT CONTRADICT THE DECLARATION. Published
//     packages follow a kind-at-end naming convention, and the artifact and
//     connector validators enforce it. This module enforces only the weaker,
//     kind-agnostic half — a name ending in ANOTHER kind's suffix is refused —
//     and leaves the convention itself to each kind's own `validate()`, which
//     runs server-side before any mutation. Inventing a stricter naming rule
//     here than the store road applies would refuse packages the storefront
//     installs happily.
//
// PURE and browser-safe: no Node imports, no server-only imports. It reads
// bytes and parses JSON. Nothing in a supplied package is ever imported,
// evaluated or required, for any kind, at preview or at validation time.
// ---------------------------------------------------------------------------

/** The live installable kinds. `workflow` is deliberately absent: its host
 *  handler was removed and the literal survives in the kind union only until
 *  the in-app consumer narrowing completes, so an upload declaring it has
 *  nothing to install into. */
export const UPLOADABLE_EXTENSION_KINDS = ["agent", "connector", "artifact", "skill"] as const;
export type UploadableExtensionKind = (typeof UPLOADABLE_EXTENSION_KINDS)[number];

export const ACCEPTED_KINDS_SENTENCE = UPLOADABLE_EXTENSION_KINDS.join(", ");

/** Kind suffixes as they appear at the end of a published package name. */
const KIND_NAME_SUFFIXES: Record<string, UploadableExtensionKind> = {
  agent: "agent",
  agents: "agent",
  connector: "connector",
  connectors: "connector",
  artifact: "artifact",
  artifacts: "artifact",
  skill: "skill",
  skills: "skill",
};

// The version a package.json declares, as SemVer 2.0.0 spells it. This is the
// published grammar verbatim: three numeric parts that carry NO leading zero,
// then at most one prerelease part introduced by a single `-` and at most one
// build part introduced by a single `+`, each a run of dot-separated
// identifiers, where a purely numeric prerelease identifier also carries no
// leading zero.
//
// THE ACCEPTANCE SET MUST EQUAL `semver.valid()`. A version admitted here is
// stored and then compared by the product's own semver layer — the update
// check in screens.tsx and the orchestrator's range check both run it through
// `semver` — and that layer rejects a leading-zero version outright. Admitting
// a version those comparisons cannot read would install an extension that is
// permanently uncomparable: no update is ever offered for it and its version
// silently satisfies no range. So the rule is not "close enough to SemVer",
// it is the same rule, and the suite pins the two against each other.
//
// THE SHAPE IS ALSO LOAD-BEARING, because these are bytes an operator
// supplied and the decision has to come back in bounded time. Nothing here
// nests an unbounded quantifier inside another, and `.` — the identifier
// separator — is excluded from every identifier class, so each identifier's
// boundaries are fixed before its contents are read and the repeated groups
// cannot trade characters with one another. An earlier shape opened one
// repeated group on `[-+]` while `-` was also a member of the unbounded class
// inside it, so every separator could be read two ways and a refused version
// made of many `--` pairs cost exponential backtracking (js/redos).
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type ExtensionPackageIdentity = {
  kind: UploadableExtensionKind;
  packageName: string;
  packageVersion: string;
  /** The parsed package.json — the exact object each kind's `validate()` takes. */
  manifest: Record<string, unknown>;
  /** The `cinatra` block, when the manifest carries one. */
  cinatra: Record<string, unknown> | null;
};

function refuseKind(found: unknown): never {
  if (found === undefined || found === null || found === "") {
    throw new Error(
      "Invalid package: package.json declares no `cinatra.kind`, so there is nothing to install it as. " +
        `Accepted kinds are ${ACCEPTED_KINDS_SENTENCE}.`,
    );
  }
  if (found === "workflow") {
    throw new Error(
      'Invalid package: package.json declares `cinatra.kind: "workflow"`. The workflow kind was ' +
        "retired and has no installable handler, so a workflow package cannot be installed. " +
        `Accepted kinds are ${ACCEPTED_KINDS_SENTENCE}.`,
    );
  }
  throw new Error(
    `Invalid package: package.json declares \`cinatra.kind: ${JSON.stringify(found)}\`, which is ` +
      `not an installable extension kind. Accepted kinds are ${ACCEPTED_KINDS_SENTENCE}.`,
  );
}

/**
 * Read the identity a supplied package declares, refusing every way it can fail
 * to declare one. `label` names the container in the refusal wording ("archive"
 * for the File road, "repository" for the GitHub road) so an operator is told
 * which thing they handed over.
 */
export function readExtensionPackageIdentity(
  packageJsonText: string,
  label: "archive" | "repository" = "archive",
): ExtensionPackageIdentity {
  const noun = label === "repository" ? "repository" : "archive";
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(packageJsonText) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid ${noun}: package.json is not valid JSON.`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid ${noun}: package.json is not a JSON object.`);
  }

  const packageName = manifest.name;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(`Invalid ${noun}: package.json is missing a "name".`);
  }
  const packageVersion = manifest.version;
  if (typeof packageVersion !== "string" || !SEMVER_RE.test(packageVersion)) {
    throw new Error(
      `Invalid ${noun}: package.json is missing a valid "version" (expected a semantic version, got ` +
        `${JSON.stringify(manifest.version)}).`,
    );
  }

  const cinatra =
    manifest.cinatra !== null && typeof manifest.cinatra === "object" && !Array.isArray(manifest.cinatra)
      ? (manifest.cinatra as Record<string, unknown>)
      : null;
  const declaredKind = cinatra?.kind;
  if (!(UPLOADABLE_EXTENSION_KINDS as readonly unknown[]).includes(declaredKind)) {
    try {
      refuseKind(declaredKind);
    } catch (err) {
      throw new Error((err as Error).message.replace("Invalid package:", `Invalid ${noun}:`));
    }
  }
  const kind = declaredKind as UploadableExtensionKind;

  const slug = packageName.split("/").pop() ?? packageName;
  const lastToken = slug.split("-").pop() ?? "";
  const suffixKind = KIND_NAME_SUFFIXES[lastToken.toLowerCase()];
  if (suffixKind !== undefined && suffixKind !== kind) {
    throw new Error(
      `Invalid ${noun}: package name ${JSON.stringify(packageName)} ends in "-${lastToken}", ` +
        `naming it a ${suffixKind} package, but package.json declares ` +
        `\`cinatra.kind: ${JSON.stringify(kind)}\`. The name and the declared kind must agree.`,
    );
  }

  return { kind, packageName, packageVersion, manifest, cinatra };
}

export type PackagePayloadReader = {
  /** Every path in the delivered tree, package-root-relative. */
  paths: () => Iterable<string>;
  /** UTF-8 text of one path, or null when the tree has no such file. */
  read: (path: string) => string | null;
};

export type ResolvedPackagePayload = {
  /** The OAS Flow document — kind "agent" only; null for every other kind. */
  agentJson: string | null;
  /** "legacy" only for the flat root-agent.json shape the app's own older exports produce. */
  layout: "standard" | "legacy";
};

function refusePayload(
  noun: string,
  kind: UploadableExtensionKind,
  expected: string,
): never {
  throw new Error(
    `Invalid ${noun}: package.json declares \`cinatra.kind: ${JSON.stringify(kind)}\` but carries ` +
      `no ${kind} payload (expected ${expected}).`,
  );
}

/**
 * Assert that the declared kind is backed by the payload that kind requires,
 * and resolve the payload the kind needs carried forward.
 *
 * The artifact arm additionally applies the artifact handler's own two hard
 * rules at intake — an artifact is metadata-only and must never be mountable by
 * the agent loader, and its descriptor is mandatory — so a package that could
 * never pass `validate()` is refused before it is uploaded at all rather than
 * after it has been read, scoped and sent.
 */
export function resolveExtensionPackagePayload(
  identity: ExtensionPackageIdentity,
  tree: PackagePayloadReader,
  label: "archive" | "repository" = "archive",
): ResolvedPackagePayload {
  const noun = label === "repository" ? "repository" : "archive";
  const { kind, cinatra } = identity;
  switch (kind) {
    case "agent": {
      const entrypoint = cinatra?.entrypoint;
      if (typeof entrypoint === "string" && entrypoint.length > 0) {
        const normalized = entrypoint.replace(/^\.\//, "");
        const found = tree.read(normalized);
        if (found === null) {
          throw new Error(
            `Invalid ${noun}: entrypoint ${JSON.stringify(entrypoint)} (from package.json) not found in the ${noun}.`,
          );
        }
        return { agentJson: found, layout: "standard" };
      }
      const conventional = tree.read("cinatra/oas.json");
      if (conventional !== null) return { agentJson: conventional, layout: "standard" };
      const legacy = tree.read("agent.json");
      if (legacy !== null) return { agentJson: legacy, layout: "legacy" };
      refusePayload(
        noun,
        "agent",
        "the file named by cinatra.entrypoint, cinatra/oas.json, or a root agent.json",
      );
      break;
    }
    case "skill": {
      const hasSkill = [...tree.paths()].some((name) => /(^|\/)SKILL\.md$/.test(name));
      if (!hasSkill) refusePayload(noun, "skill", "at least one skills/<name>/SKILL.md");
      break;
    }
    case "connector": {
      if (tree.read("cinatra/config.json") === null) {
        refusePayload(noun, "connector", "cinatra/config.json");
      }
      break;
    }
    case "artifact": {
      if (cinatra && "oas" in cinatra && cinatra.oas != null) {
        throw new Error(
          `Invalid ${noun}: an artifact package must not carry a \`cinatra.oas\` payload — ` +
            "artifact extensions are metadata-only and must never be mountable by the agent loader.",
        );
      }
      const descriptor = cinatra?.artifact;
      if (descriptor === undefined || descriptor === null || typeof descriptor !== "object") {
        refusePayload(noun, "artifact", "a cinatra.artifact descriptor in package.json");
      }
      break;
    }
  }
  return { agentJson: null, layout: "standard" };
}
