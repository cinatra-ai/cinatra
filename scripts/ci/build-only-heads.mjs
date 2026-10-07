// Build-only heads — cinatra#3890.
//
// The merge tooling opens a pull request whose only purpose is to run the image
// workflow on the exact tree main is about to carry. Such a pull request is
// never merged; its head is a branch of this repository, and the branch name
// starts with one of the prefixes below. A fork's branch of the same name is
// an ordinary head: the condition never skips it.
// Every workflow a `pull_request` event starts, except the image build
// (`build-image.yml`), skips it through one job condition CONDITION (below),
// written the same way in every file:
//
//   if: ${{ (EXISTING) && CONDITION }}   (EXISTING: the job's own condition, unchanged)
//   if: ${{ CONDITION }}                 (a job with no condition before)
//
// `github.event.pull_request.head.repo.full_name` is the head repository of a
// pull request and is empty on every other event (a push, a merge queue group,
// a schedule, a run by hand), where `github.head_ref` is empty too. The
// comparison with `github.repository` is then false, so the condition is true
// — the job runs as before — everywhere except on a build-only head.
//
// This module is the one place the condition is written. The workflow test
// (scripts/ci/__tests__/build-only-heads-skip.test.mjs) requires it on every
// pull request workflow and evaluates it; the merge readiness inventory reads
// it so that a job whose only other guard is none, always() or !cancelled()
// stays a job that must succeed on a real candidate.

/** Head branch prefixes of the pull requests that exist only to build a tree. */
export const BUILD_ONLY_HEAD_PREFIXES = Object.freeze(["merge-queue/", "merge-batch/"]);

/** The one workflow that runs on a build-only head: its run proves the tree. */
export const IMAGE_WORKFLOW = "build-image.yml";

/** The condition, exactly as every workflow file carries it. */
export const BUILD_ONLY_HEAD_CONDITION =
  "!(github.event.pull_request.head.repo.full_name == github.repository && (" +
  BUILD_ONLY_HEAD_PREFIXES.map((prefix) => `startsWith(github.head_ref, '${prefix}')`).join(" || ") +
  "))";

const SUFFIX = ` && ${BUILD_ONLY_HEAD_CONDITION}`;

/** True when `text` is one parenthesised group from its first to its last character. */
function isOneGroup(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0 && i !== text.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted;
}

/**
 * Split a job's `if:` value into the build-only head condition and the job's
 * own condition. Returns `{ carries, existing }`: `carries` is true when the
 * value has one of the two canonical forms above; `existing` is the job's own
 * condition (null when it has none). A value in any other form does not carry
 * the condition, and `existing` is then the value itself.
 */
export function splitBuildOnlyHeadGuard(ifValue) {
  if (ifValue == null) return { carries: false, existing: null };
  const value = String(ifValue).trim();
  const inner = value.startsWith("${{") && value.endsWith("}}") ? value.slice(3, -2).trim() : value;
  if (inner === BUILD_ONLY_HEAD_CONDITION) return { carries: true, existing: null };
  if (inner.endsWith(SUFFIX)) {
    const head = inner.slice(0, -SUFFIX.length).trim();
    if (isOneGroup(head)) {
      const existing = head.slice(1, -1).trim();
      if (existing !== "") return { carries: true, existing };
    }
  }
  return { carries: false, existing: value };
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (text.startsWith("&&", i) || text.startsWith("||", i) || text.startsWith("==", i) || text.startsWith("!=", i)) {
      tokens.push({ kind: "op", value: text.slice(i, i + 2) });
      i += 2;
    } else if ("!(),".includes(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i++;
    } else if (ch === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= text.length) throw new Error(`unterminated string in: ${text}`);
        if (text[i] === "'" && text[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (text[i] === "'") {
          i++;
          break;
        } else {
          value += text[i++];
        }
      }
      tokens.push({ kind: "string", value });
    } else {
      const word = text.slice(i).match(/^[A-Za-z_][\w.-]*/);
      if (!word) throw new Error(`unexpected character '${ch}' in: ${text}`);
      tokens.push({ kind: "name", value: word[0] });
      i += word[0].length;
    }
  }
  return tokens;
}

/** The values the reader knows, by the context name the condition uses. */
const OPERANDS = {
  "github.head_ref": (head) => head.headRef ?? "",
  "github.event.pull_request.head.repo.full_name": (head) => head.headRepo ?? null,
  "github.repository": (head) => head.repository,
  "github.event_name": (head) => {
    if (typeof head.eventName !== "string") throw new Error("github.event_name needs a head with an eventName");
    return head.eventName;
  },
};

/** A value as a number, the way the platform coerces one of another type. */
function toNumber(value) {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return Number.NaN;
}

/** The platform's `==`: strings without regard to case, else as numbers. */
function looselyEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (a === null && b === null) return true;
  return toNumber(a) === toNumber(b);
}

/**
 * Evaluate a condition built only from `github.head_ref`, the pull request's
 * head repository, `github.repository`, string literals, `startsWith(a, b)`,
 * `==`, `!`, `&&`, `||` and parentheses, for one head:
 * `{ headRef, headRepo, repository }` (a push has the empty head reference and
 * no head repository, `null`). `startsWith` and `==` ignore case, as the
 * platform's own do. Anything else in the text throws: an expression this
 * reader does not know is never taken as true. `github.event_name` (the head's
 * `eventName`, which throws when the head carries none) and `!=` (the negation
 * of `==`) are read too.
 */
export function evaluateHeadCondition(text, head) {
  if (head === null || typeof head !== "object" || typeof head.repository !== "string") {
    throw new Error("evaluateHeadCondition needs { headRef, headRepo, repository }");
  }
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (kind, value) => {
    const t = tokens[pos];
    if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new Error(`expected ${value ?? kind} at token ${pos} in: ${text}`);
    }
    pos++;
    return t;
  };
  const value = () => {
    const t = peek();
    if (t?.kind === "string") return take("string").value;
    if (t?.kind === "name" && Object.hasOwn(OPERANDS, t.value)) {
      pos++;
      return OPERANDS[t.value](head);
    }
    throw new Error(`unsupported operand at token ${pos} in: ${text}`);
  };
  const primary = () => {
    const t = peek();
    if (t?.kind === "punct" && t.value === "!") {
      pos++;
      return !primary();
    }
    if (t?.kind === "punct" && t.value === "(") {
      pos++;
      const inner = or();
      take("punct", ")");
      return inner;
    }
    if (t?.kind === "name" && t.value === "startsWith") {
      pos++;
      take("punct", "(");
      const subject = value();
      take("punct", ",");
      const prefix = value();
      take("punct", ")");
      return String(subject ?? "").toLowerCase().startsWith(String(prefix ?? "").toLowerCase());
    }
    const left = value();
    if (peek()?.kind === "op" && peek().value === "!=") {
      pos++;
      return !looselyEqual(left, value());
    }
    take("op", "==");
    return looselyEqual(left, value());
  };
  const and = () => {
    let result = primary();
    while (peek()?.kind === "op" && peek().value === "&&") {
      pos++;
      const right = primary();
      result = result && right;
    }
    return result;
  };
  const or = () => {
    let result = and();
    while (peek()?.kind === "op" && peek().value === "||") {
      pos++;
      const right = and();
      result = result || right;
    }
    return result;
  };
  const result = or();
  if (pos !== tokens.length) throw new Error(`trailing tokens at ${pos} in: ${text}`);
  return result;
}

/** True when a head `{ headRef, headRepo, repository }` is a build-only head. */
export const isBuildOnlyHead = (head) => !evaluateHeadCondition(BUILD_ONLY_HEAD_CONDITION, head);
