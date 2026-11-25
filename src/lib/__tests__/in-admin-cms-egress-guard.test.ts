// cinatra#1214 S3 — in-admin CMS assistant MCP-only egress: the cinatra-side
// STANDING guard.
//
// The house rule (#1214 / epic #1037): the in-admin CMS assistant (the embedded
// widget in the WordPress or Drupal admin) reaches the CMS ONLY through that
// CMS's MCP integration — never a direct REST / JSON:API call with a stored
// credential. The WordPress in-admin read/update was rerouted onto the site's
// MCP content server (S1, wordpress-mcp-connector#66); Drupal's one remaining
// direct read was inverted to an MCP-primary read (S2, drupal-mcp-connector#64).
//
// The connector repos each carry their OWN code-path egress guard (S4 — the
// "D2" sibling that proves absence in the connector's handler at that repo's
// CI). What no per-connector guard can catch is the DISTINCT cinatra-side
// regression: **cinatra core adopting (via the extension lock) a connector
// version that reintroduced direct CMS REST on the agent path.** This guard
// closes exactly that gap — it asserts the invariant over the connector
// integration surfaces cinatra ACTUALLY HOSTS (the workspace-resolved connector
// handler sources) plus core's own CMS-connection surfaces:
//
//   (a) no direct WordPress `/wp/v2/*` or Drupal `/jsonapi/*` REST egress in the
//       agent-path handler code cinatra hosts (no direct fetch, no deleted
//       direct-REST helper, no legacy direct-REST DI call), and
//   (b) the sanctioned MCP transports are the routing — asserted at the SPECIFIC
//       handler->governed-invoker edges for WordPress and the MCP-helper edges
//       for Drupal, not merely file-wide symbol presence. Connector #114
//       removed WordPress's connector-owned snapshot/review/read-back helpers.
//       Connector #119 split the site tool into the read-only
//       wordpress_site_tool_call and the new wordpress_site_tool_write; both
//       handlers forward through the one shared forwardSiteTool, which holds
//       the governed invoker edge, so the guard asserts both handler edges
//       and that shared function. Connector #120 (cinatra#3745) gave the
//       read tool a validated catalog row: the guard pins that the read tool
//       adds exactly two fields to the forwarded call, both from that row, that
//       the caller's input has no field for them, and that no function other
//       than the shared forward names the invoker.
//
// It is a pure static/AST-shaped source assertion: hermetic, Docker-free, and
// runs in the always-on `pnpm test:root` suite (build-image.yml) where
// `clone-extensions` has resolved the connector handler sources cinatra hosts.
// It turns RED the moment the hosted connector agent path carries a direct-REST
// call again, and GREEN on the compliant MCP-only path.
//
// SCOPE NOTE: this covers the two in-admin editing primitives rerouted by
// S1/S2 (post read+update / node read) — the ratified #1214 reroute scope. The
// adjacent WordPress primitives (status/list/delete/media/draft/meta) remain
// direct-REST-backed and are NOT rerouted; whether the in-admin agent's tool
// access must be allowlisted so it cannot REACH them is a distinct #1214 fix
// question (surfaced on the issue), out of this guard's assertion scope.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";

// Shared single-pass LEXICAL comment stripper — comment-context-aware, so a
// `/wp/v2` inside a URL string literal (`"https://host/wp/v2/..."`) is PRESERVED
// and correctly caught, and a `//` inside a protocol-relative URL is not
// mistaken for a line comment. A naive regex stripper would drop the tail of
// such a URL and let a real direct-REST call slip through the guard.
// The .mjs audit helper resolves under the test tsconfig (same import the
// sibling toast-banner guard uses); no ts-expect-error needed.
import { stripComments } from "../../../scripts/audit/lib/strip-comments.mjs";

import { classifyAnnotations } from "@cinatra-ai/mcp-server/annotation-classifier";

import {
  resolveWordPressMcpEndpoint,
  resolveWordPressMcpFallbackEndpoint,
} from "@/lib/wordpress-mcp-connection";

const require = createRequire(import.meta.url);

/** Read the connector handler SOURCE cinatra hosts via its published export. */
function readHostedHandlerCode(mcpHandlersSpecifier: string): string {
  const resolved = require.resolve(mcpHandlersSpecifier);
  return stripComments(readFileSync(resolved, "utf8"));
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration?.body) throw new Error(`Missing hosted function: ${name}`);
  return declaration;
}

function callsNamed(node: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && child.expression.getText() === name) calls.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return calls;
}

// The two hosted site tools that forward a site ability call to the site.
const SITE_TOOL_HANDLERS = ["wordpress_site_tool_call", "wordpress_site_tool_write"] as const;

function propertyName(node: ts.ObjectLiteralElementLike): string {
  const name = (node as { name?: ts.PropertyName }).name;
  return name && (ts.isStringLiteral(name) || ts.isIdentifier(name)) ? name.text : node.getText();
}

function assertGovernedWordPressRouting(code: string): void {
  const source = ts.createSourceFile("hosted-handlers.ts", code, ts.ScriptTarget.Latest, true);
  const factory = namedFunction(source, "createWordPressPrimitiveHandlers");
  const returned = factory.body!.statements.find(ts.isReturnStatement)?.expression;
  const handlers = returned && ts.isAsExpression(returned) ? returned.expression : returned;
  if (!handlers || !ts.isObjectLiteralExpression(handlers)) throw new Error("Missing hosted handler map");
  // The entries of the handler map whose source names the shared forward or
  // the invoker are exactly the two site tools: a further entry that names
  // either one, or a site tool that no longer forwards, fails here.
  const forwarding = handlers.properties
    .filter((node) => /\b(?:forwardSiteTool|invokeSiteTool)\b/.test(node.getText()))
    .map(propertyName)
    .sort();
  expect(forwarding).toEqual([...SITE_TOOL_HANDLERS].sort());
  for (const name of SITE_TOOL_HANDLERS) {
    const property = handlers.properties.find(
      (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node) === name,
    );
    if (!property || !ts.isArrowFunction(property.initializer)) {
      throw new Error(`Missing WordPress site-tool handler: ${name}`);
    }
    // Each site tool reaches the site only through the shared governed
    // forward, once, as its result, naming itself as the calling tool (the
    // name the write-authority record carries).
    const body = property.initializer.body;
    const bodyText = compactOf(body);
    expect(bodyText).not.toContain("invokeSiteTool");
    const forwards = callsNamed(body, "forwardSiteTool");
    expect(forwards).toHaveLength(1);
    expect(forwards[0] === body || ts.isReturnStatement(forwards[0].parent)).toBe(true);
    // The whole handler body is pinned, so nothing else can ride along:
    //  - the write tool forwards the input as the one parser returned it;
    //  - the read tool parses the same way, forwards only after `readRow` found
    //    its validated catalog row (no row is the fixed refusal), and then adds
    //    exactly two fields, both taken from that row and never from the
    //    caller: the server the call is pinned to and the row's annotations.
    const expectedBody = name === "wordpress_site_tool_write"
      ? 'forwardSiteTool(parseSiteToolCallInput(request.input),"wordpress_site_tool_write")'
      : "{constinput=parseSiteToolCallInput(request.input);constrow=awaitreadRow(input);"
        + "if(row===null)thrownewError(SITE_TOOL_READ_ONLY_REFUSAL);"
        + 'returnforwardSiteTool({...input,serverId:row.serverId,expectedRawAnnotations:row.rawAnnotations},"wordpress_site_tool_call");}';
    expect(bodyText).toBe(expectedBody);
    expect(forwards[0].arguments[forwards[0].arguments.length - 1].getText()).toBe(JSON.stringify(name));
  }

  // The caller's input has the five fields of the shared schema and no other:
  // in particular no `expectedRawAnnotations`, which only the read tool's
  // validated row may supply. The parser validates with that schema and
  // resolves the arguments from `args` or `argsJson`, nothing else.
  const schemaDeclaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText() === "siteToolCallSchema");
  const schemaInit = schemaDeclaration?.initializer;
  const schemaShape = schemaInit && ts.isCallExpression(schemaInit) ? schemaInit.arguments[0] : undefined;
  if (!schemaShape || !ts.isObjectLiteralExpression(schemaShape)) throw new Error("Missing siteToolCallSchema shape");
  expect(schemaShape.properties.map(propertyName).sort()).toEqual(["args", "argsJson", "instanceId", "serverId", "toolName"]);
  // Both functions that turn the caller's input into the forwarded arguments
  // are pinned WHOLE (their exact statement lists), so no early return, cast or
  // skipped check can sit in front of the schema parse, dead code or not.
  const parser = namedFunction(source, "parseSiteToolCallInput");
  expect(parser.parameters.map((parameter) => parameter.getText())).toEqual(["raw: unknown"]);
  expect(compactOf(parser.body!)).toBe(
    "{const{argsJson,args,...rest}=siteToolCallSchema.parse(raw);"
    + "if(argsJson!==undefined&&args!==undefined)thrownewError(SITE_TOOL_ARGS_BOTH_REFUSAL);"
    + "return{...rest,args:argsJson!==undefined?parseArgsJson(argsJson):(args??{})};}",
  );
  const argsJsonParser = namedFunction(source, "parseArgsJson");
  expect(argsJsonParser.parameters.map((parameter) => parameter.getText())).toEqual(["text: string"]);
  expect(compactOf(argsJsonParser.body!)).toBe(
    "{if(text.length>SITE_TOOL_ARGS_JSON_MAX_BYTES||newTextEncoder().encode(text).length>SITE_TOOL_ARGS_JSON_MAX_BYTES)"
    + "{thrownewError(SITE_TOOL_ARGS_JSON_TOO_LARGE_REFUSAL);}"
    + "letparsed:unknown;try{parsed=JSON.parse(text);}catch{thrownewError(SITE_TOOL_ARGS_JSON_REFUSAL);}"
    + 'if(typeofparsed!=="object"||parsed===null||Array.isArray(parsed)){thrownewError(SITE_TOOL_ARGS_JSON_REFUSAL);}'
    + "constchecked=siteToolCallSchema.shape.args.safeParse(parsed);"
    + "if(!checked.success||checked.data===undefined)thrownewError(SITE_TOOL_ARGS_JSON_REFUSAL);"
    + "returnchecked.data;}",
  );

  // The governed invoker is named in exactly one function: no helper, parser or
  // row check reaches the site by another path.
  const forwardDeclaration = namedFunction(source, "forwardSiteTool");
  const outside: string[] = [];
  (function findInvokerReferences(node: ts.Node) {
    const reference = (ts.isIdentifier(node) && node.text === "invokeSiteTool")
      || (ts.isStringLiteral(node) && node.text === "invokeSiteTool" && ts.isElementAccessExpression(node.parent));
    if (reference && (node.getStart() < forwardDeclaration.getStart() || node.getEnd() > forwardDeclaration.getEnd())) {
      // The one type-level mention is the parameter type of the review-gated helper.
      let inType = false;
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) if (ts.isTypeNode(up)) inType = true;
      if (!inType) outside.push(node.parent.getText());
    }
    ts.forEachChild(node, findInvokerReferences);
  })(source);
  expect(outside).toEqual([]);

  const forward = namedFunction(source, "forwardSiteTool");
  expect(forward.parameters.map((parameter) => parameter.name.getText())).toEqual(["input", "tool"]);
  const handler = forward.body!;
  // The shared forward is pinned WHOLE as a statement list, so nothing can sit
  // in front of the governed call, as an early return or as dead code: the
  // invoker lookup, the unavailable-channel refusal (the only statement of its
  // block is a throw), the update branch (its only statement is the return to
  // the review-gated helper), and the one returned invoker call.
  expect(handler.statements.map((statement) => statementKind(statement))).toEqual([
    "VariableStatement",
    "IfStatement",
    "IfStatement",
    "ReturnStatement",
  ]);
  const [lookup, unavailable, updateBranch, finalReturn] = handler.statements as unknown as [
    ts.VariableStatement, ts.IfStatement, ts.IfStatement, ts.ReturnStatement,
  ];
  expect(compactOf(lookup)).toBe("constinvoke=getWordPressDeps().invokeSiteTool;");
  expect(compactOf(unavailable.expression)).toBe('typeofinvoke!=="function"');
  expect(unavailable.elseStatement).toBeUndefined();
  expect(ts.isBlock(unavailable.thenStatement) && unavailable.thenStatement.statements.map((statement) => statementKind(statement)))
    .toEqual(["ThrowStatement"]);
  expect(compactOf(updateBranch.expression)).toBe("CONTENT_REVIEW_TARGET_ABILITIES.has(input.toolName)");
  expect(updateBranch.elseStatement).toBeUndefined();
  expect(compactOf(updateBranch.thenStatement)).toBe("{returncallReviewGatedSiteTool(invoke,input,tool);}");
  const topLevelDeclaration = (name: string): ts.VariableDeclaration | undefined =>
    source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((declaration) => declaration.name.getText() === name);
  expect(compactOf(topLevelDeclaration("EWPA_UPDATE_POST_ABILITY")!)).toBe('EWPA_UPDATE_POST_ABILITY="ewpa/update-post"');
  expect(compactOf(topLevelDeclaration("CONTENT_REVIEW_TARGET_ABILITIES")!))
    .toBe("CONTENT_REVIEW_TARGET_ABILITIES:ReadonlySet<string>=newSet([EWPA_UPDATE_POST_ABILITY])");
  const genericCalls = callsNamed(handler, "invoke");
  expect(genericCalls).toHaveLength(1);
  expect(genericCalls[0].parent).toBe(finalReturn);

  // The review-gated helper is pinned by what governs its one call: the
  // instance and post checks and the write-authority gate are statements of
  // its own top level (never inside a branch that can be skipped), in that
  // order, ahead of its one invoker call, which is its ONLY return. Its
  // argument checks between them stay free text: they only refuse, and the
  // connector's own suite owns them.
  const reviewGated = namedFunction(source, "callReviewGatedSiteTool");
  expect(reviewGated.parameters[2]?.name.getText()).toBe("tool");
  const update = reviewGated.body!;
  const updateCalls = callsNamed(update, "invoke");
  expect(updateCalls).toHaveLength(1);
  const authority = callsNamed(update, "requireWriteAuthority");
  expect(authority).toHaveLength(1);
  expect(ts.isAwaitExpression(authority[0].parent)).toBe(true);
  expect(authority[0].getText()).toBe("requireWriteAuthority(instanceId, tool)");
  const updateReturn = update.statements[update.statements.length - 1];
  expect(ts.isReturnStatement(updateReturn) && updateReturn.expression && ts.isCallExpression(updateReturn.expression)
    ? updateReturn.expression : undefined).toBe(updateCalls[0]);
  expect(returnsOf(update)).toEqual([updateReturn]);
  const topLevel = update.statements.map((statement) => compactOf(statement));
  const at = (predicate: (text: string) => boolean): number => topLevel.findIndex(predicate);
  const instanceCheck = at((text) => /^if\(!instanceId\)\{throw/.test(text));
  const postCheck = at((text) => /^if\(!Number\.isInteger\(postId\)\|\|postId<=0\)\{throw/.test(text));
  const gate = at((text) => text === "awaitrequireWriteAuthority(instanceId,tool);");
  expect(instanceCheck).toBeGreaterThanOrEqual(0);
  expect(postCheck).toBeGreaterThan(instanceCheck);
  expect(gate).toBeGreaterThan(postCheck);
  expect(gate).toBe(update.statements.length - 2); // right before the call: nothing between the gate and the forward

  // What each invoker call carries is pinned element by element, predicates of
  // the conditional spreads included, so none can be added, taken from
  // elsewhere, changed or switched off: the tool and its arguments exactly as
  // the caller gave them (no actor, connector key or kind: those are
  // host-derived), the instance and server coordinates, and, on the read path
  // only, the annotations the validated row had. The write-gated update call
  // carries no annotations.
  expect(invokerElements(genericCalls[0])).toEqual([
    "toolName:input.toolName",
    "args:input.args",
    "...(input.instanceId!==undefined?{instanceId:input.instanceId}:{})",
    "...(input.serverId!==undefined?{serverId:input.serverId}:{})",
    "...(input.expectedRawAnnotations!==undefined?{expectedRawAnnotations:input.expectedRawAnnotations}:{})",
  ]);
  expect(invokerElements(updateCalls[0])).toEqual([
    "toolName:input.toolName",
    "args:input.args",
    "instanceId",
    "...(input.serverId!==undefined?{serverId:input.serverId}:{})",
  ]);
}

// The statement kinds this guard tells apart (`ts.SyntaxKind` names two kinds alike).
function statementKind(statement: ts.Statement): string {
  if (ts.isVariableStatement(statement)) return "VariableStatement";
  if (ts.isIfStatement(statement)) return "IfStatement";
  if (ts.isReturnStatement(statement)) return "ReturnStatement";
  if (ts.isThrowStatement(statement)) return "ThrowStatement";
  return "OtherStatement";
}

// A node's source as its tokens joined without trivia: whitespace is dropped only
// BETWEEN tokens, never inside a string or template literal (a leaf token keeps
// its text), so a changed literal cannot hide behind the normalisation. A comma
// before a closing bracket is formatting, not a change.
function compactOf(node: ts.Node): string {
  const tokens: string[] = [];
  (function collect(current: ts.Node) {
    const children = current.getChildren();
    if (children.length === 0) tokens.push(current.getText());
    else children.forEach(collect);
  })(node);
  return tokens.filter((token, index) => !(token === "," && [")", "}", "]"].includes(tokens[index + 1]))).join("");
}

// The return statements of a body, not those of functions nested in it.
function returnsOf(body: ts.Node): ts.ReturnStatement[] {
  const found: ts.ReturnStatement[] = [];
  (function visit(node: ts.Node) {
    if (ts.isReturnStatement(node)) found.push(node);
    if (node !== body && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  })(body);
  return found;
}

// The elements of an invoker call's one object argument, each as its exact
// source text (a spread's condition and object included), in order.
function invokerElements(call: ts.CallExpression): string[] {
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error("Missing governed invocation coordinates");
  return argument.properties.map((element) => compactOf(element));
}

const FORWARD_ANCHOR = "async function forwardSiteTool(";
const HANDLERS_ANCHOR = "export function createWordPressPrimitiveHandlers()";

// Replace the first `before` that follows `anchor` (anchor must occur once).
function mutateHandler(code: string, anchor: string, before: string, after: string): string {
  const start = code.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(code.indexOf(anchor, start + 1)).toBe(-1);
  const handlerSource = code.slice(start);
  expect(handlerSource).toContain(before);
  return code.slice(0, start) + handlerSource.replace(before, after);
}

// ---------------------------------------------------------------------------
// WordPress — the connector agent-path handler cinatra hosts routes the
// in-admin read/update through the MCP content tools, never a direct /wp/v2 call.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — hosted WordPress connector", () => {
  const code = readHostedHandlerCode("@cinatra-ai/wordpress-mcp-connector/mcp-handlers");

  it("makes no direct fetch() call on the hosted agent path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("references no direct /wp/v2 REST path in code (string literals included)", () => {
    expect(code).not.toMatch(/\/wp\/v2/);
  });

  it("does not host the deleted direct-REST helpers", () => {
    for (const deleted of ["readWordPressPost", "updateWordPressPost"]) {
      expect(code).not.toContain(deleted);
    }
  });

  it("makes no legacy direct-REST DI call on the in-admin read/update path", () => {
    // The pre-reroute handler read/wrote via `getWordPressDeps().readPost(...)`
    // / `.updatePost(...)` (direct /wp/v2). Ban those exact DI edges so a
    // restored client method cannot coexist with an unused MCP symbol.
    // `.readPostStatus(` is a DISTINCT (non-rerouted) primitive and does not
    // match `\.readPost\(`.
    expect(code).not.toMatch(/\.readPost\s*\(/);
    expect(code).not.toMatch(/\.updatePost\s*\(/);
  });

  it("routes the in-admin read/update through the governed invoker (routing-edge positive control)", () => {
    // Both the old connector composition and #114's own-result forwarding
    // use these governed edges. This is an egress guard, not proof that the
    // separately ordered agent snapshot/review lifecycle is complete.
    assertGovernedWordPressRouting(code);
  });

  it("rejects an ungoverned handler even when the invoker name remains elsewhere", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, "const invoke = getWordPressDeps().invokeSiteTool;", "const invoke = ungovernedCall;");
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a missing-invoker fallback instead of a refusal", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, 'if (typeof invoke !== "function")', 'if (typeof invoke === "function")');
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects an update branch that bypasses argument and authority checks", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, "return callReviewGatedSiteTool(invoke, input, tool);", "return invoke(input);");
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects an update that forwards before its write-authority gate", () => {
    const before = "await requireWriteAuthority(instanceId, tool);";
    expect(code).toContain(before);
    expect(() => assertGovernedWordPressRouting(code.replace(before, ""))).toThrow();
  });

  it("rejects transformed tool arguments on the generic invocation", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, "args: input.args,", "args: {},");
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a write handler that calls the invoker past the shared governed forward", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'forwardSiteTool(parseSiteToolCallInput(request.input), "wordpress_site_tool_write")',
      "getWordPressDeps().invokeSiteTool!(parseSiteToolCallInput(request.input))",
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a write handler that forwards through an ungoverned call", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'forwardSiteTool(parseSiteToolCallInput(request.input), "wordpress_site_tool_write")',
      "ungovernedCall(parseSiteToolCallInput(request.input))",
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a write handler that forwards under the read tool's name", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'forwardSiteTool(parseSiteToolCallInput(request.input), "wordpress_site_tool_write")',
      'forwardSiteTool(parseSiteToolCallInput(request.input), "wordpress_site_tool_call")',
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a read handler that calls the invoker past the shared governed forward", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'return forwardSiteTool(',
      "return getWordPressDeps().invokeSiteTool!(",
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a further handler that reaches the invoker", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      "return {",
      'return {\n    "wordpress_site_tool_extra": async (request: unknown) => getWordPressDeps().invokeSiteTool!(request),',
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  // The pins on the read tool's validated row and on what each invoker call
  // carries: each change below must fail the guard.
  const replaceOnce = (before: string, after: string): string => {
    expect(code.split(before)).toHaveLength(2);
    return code.replace(before, after);
  };
  // The changed source is made OUTSIDE the asserted call, so a failed
  // precondition of the change cannot pass as a rejection.
  const rejects = (changed: string): void => {
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  };

  it("rejects a read tool that forwards without its validated row, or a refusal that no longer stops it", () => {
    rejects(replaceOnce("if (row === null) throw new Error(SITE_TOOL_READ_ONLY_REFUSAL);", ""));
    rejects(replaceOnce("{ ...input, serverId: row.serverId, expectedRawAnnotations: row.rawAnnotations }", "input"));
  });

  it("rejects a read tool that takes the server or the annotations from the caller, or adds a field", () => {
    rejects(replaceOnce("serverId: row.serverId,", "serverId: input.serverId,"));
    rejects(replaceOnce("expectedRawAnnotations: row.rawAnnotations }", "expectedRawAnnotations: input.expectedRawAnnotations }"));
    rejects(replaceOnce("expectedRawAnnotations: row.rawAnnotations }", "expectedRawAnnotations: row.rawAnnotations, extra: input.args }"));
  });

  it("rejects a second forward call in a site tool", () => {
    rejects(replaceOnce("const row = await readRow(input);", 'const row = await readRow(input);\n      await forwardSiteTool(input, "wordpress_site_tool_call");'));
  });

  it("rejects a field added to, or taken from elsewhere in, the governed invocation", () => {
    const annotations = "...(input.expectedRawAnnotations !== undefined ? { expectedRawAnnotations: input.expectedRawAnnotations } : {}),";
    rejects(replaceOnce(annotations, `${annotations}\n    extra: input.args,`));
    rejects(replaceOnce(annotations, ""));
    const instance = "...(input.serverId !== undefined ? { serverId: input.serverId } : {}),";
    rejects(mutateHandler(code, FORWARD_ANCHOR, instance, `${instance}\n    extra: input.args,`));
    // the write-gated update call, which carries no annotations
    rejects(replaceOnce(`    instanceId,\n    ${instance}`, `    instanceId,\n    ${instance}\n    extra: input.args,`));
    rejects(replaceOnce(`    instanceId,\n    ${instance}`, `    instanceId,\n    ${instance}\n    expectedRawAnnotations: input.expectedRawAnnotations,`));
  });

  it("rejects a caller input that can carry the row's annotations, or a hollow parser", () => {
    rejects(replaceOnce("export const siteToolCallSchema = z.object({", "export const siteToolCallSchema = z.object({\n  expectedRawAnnotations: z.record(z.string(), z.unknown()).optional(),"));
    rejects(replaceOnce("= siteToolCallSchema.parse(raw);", "= raw as z.infer<typeof siteToolCallSchema>;"));
  });

  it("rejects a condition of a conditional field that switches the field off or changes it", () => {
    const annotations = "...(input.expectedRawAnnotations !== undefined ? { expectedRawAnnotations: input.expectedRawAnnotations } : {}),";
    rejects(replaceOnce(annotations, "...(false ? { expectedRawAnnotations: input.expectedRawAnnotations } : {}),"));
    rejects(replaceOnce(annotations, "...(input.expectedRawAnnotations === undefined ? { expectedRawAnnotations: input.expectedRawAnnotations } : {}),"));
    const server = "...(input.serverId !== undefined ? { serverId: input.serverId } : {}),";
    rejects(mutateHandler(code, FORWARD_ANCHOR, server, "...(false ? { serverId: input.serverId } : {}),"));
    rejects(mutateHandler(code, FORWARD_ANCHOR, "...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),", "...(true ? { instanceId: input.instanceId } : {}),"));
  });

  it("rejects an early exit in front of the parser's schema parse, in the argsJson parser, or in the shared forward", () => {
    const parse = "const { argsJson, args, ...rest } = siteToolCallSchema.parse(raw);";
    rejects(replaceOnce(parse, `return raw as SiteToolCallInput;\n  ${parse}`));
    rejects(replaceOnce(parse, `if (raw !== undefined) return { toolName: "x", args: {} };\n  ${parse}`));
    rejects(replaceOnce("  let parsed: unknown;", "  return {};\n  let parsed: unknown;"));
    const lookup = "const invoke = getWordPressDeps().invokeSiteTool;";
    rejects(replaceOnce(lookup, `${lookup}\n  if (tool === "x") return undefined;`));
    rejects(replaceOnce(lookup, `return undefined;\n  ${lookup}`));
  });

  it("rejects an early exit, or a skippable gate, in the review-gated helper", () => {
    const gate = "await requireWriteAuthority(instanceId, tool);";
    rejects(replaceOnce(gate, `if (tool === "x") return undefined;\n  ${gate}`));
    rejects(replaceOnce(gate, `if (tool !== "x") {\n    ${gate}\n  }`));
    rejects(replaceOnce(gate, `${gate}\n  void 0;`));
    rejects(replaceOnce("if (!instanceId) {", "if (!instanceId && false) {"));
  });

  it("rejects a changed update-ability set", () => {
    rejects(replaceOnce('const EWPA_UPDATE_POST_ABILITY = "ewpa/update-post";', 'const EWPA_UPDATE_POST_ABILITY = "ewpa/other";'));
    rejects(replaceOnce("new Set([EWPA_UPDATE_POST_ABILITY])", "new Set([])"));
  });

  it("rejects a space inside a string literal that the guard compares (whitespace is dropped only between tokens)", () => {
    rejects(replaceOnce('const EWPA_UPDATE_POST_ABILITY = "ewpa/update-post";', 'const EWPA_UPDATE_POST_ABILITY = "ewpa/update- post";'));
    rejects(replaceOnce('typeof invoke !== "function"', 'typeof invoke !== "func tion"'));
    rejects(replaceOnce('typeof parsed !== "object"', 'typeof parsed !== "obj ect"'));
    rejects(mutateHandler(code, HANDLERS_ANCHOR, '"wordpress_site_tool_write"),', '"wordpress_site_tool_wri te"),'));
  });

  it("rejects a second invoker path in a helper", () => {
    rejects(replaceOnce("async function readRow(input: SiteToolCallInput): Promise<SiteToolRow | null> {", 'async function readRow(input: SiteToolCallInput): Promise<SiteToolRow | null> {\n  await getWordPressDeps().invokeSiteTool!({ toolName: "x", args: {} });'));
  });
});

// ---------------------------------------------------------------------------
// WordPress — the read tool forwards READS ONLY, pinned by behaviour.
//
// Core relies on `wordpress_site_tool_call` forwarding reads only
// (packages/mcp-server/src/in-admin-cms-tool-policy.ts: the tool that is not
// declared `outward` must never carry a write). The source assertions above pin
// where the read tool may reach the invoker; this block runs the pinned
// connector's real handler module against a stub catalog and a stub invoker
// and pins WHICH rows it forwards. The stub rows carry the class the host's own
// classifier gives their annotations, as the host's listing would.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — the hosted WordPress read tool forwards reads only (behaviour)", () => {
  const DEFAULT_SERVER = "mcp-adapter-default";
  type StubRow = {
    name: string;
    serverId: string;
    inputSchema: unknown;
    rawAnnotations: Record<string, unknown>;
    derivedClass: ReturnType<typeof classifyAnnotations>;
    policyStatus: "allowed";
    cacheAgeMs: number;
    catalogRevision: string;
  };
  const row = (name: string, rawAnnotations: Record<string, unknown>, serverId = DEFAULT_SERVER): StubRow => ({
    name,
    serverId,
    inputSchema: {},
    rawAnnotations,
    derivedClass: classifyAnnotations(rawAnnotations),
    policyStatus: "allowed",
    cacheAgeMs: 0,
    catalogRevision: "rev-1",
  });

  let catalog: StubRow[] = [];
  let hostFiltersByServer = true;
  let endlessListing = false;
  const invokeSiteTool = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true }));
  const listSiteTools = vi.fn(async (input: { serverId?: string }) => ({
    tools: catalog.filter((candidate) => !hostFiltersByServer || input.serverId === undefined || candidate.serverId === input.serverId),
    ...(endlessListing ? { nextCursor: "more" } : {}),
    catalogRevision: "rev-1",
  }));

  let read: (input: unknown) => Promise<unknown>;
  let refusal: string;

  beforeEach(async () => {
    const handlers = await import("@cinatra-ai/wordpress-mcp-connector/mcp-handlers");
    const deps = await import("../../../extensions/cinatra-ai/wordpress-mcp-connector/src/deps");
    deps._resetWordPressDepsForTests();
    catalog = [];
    hostFiltersByServer = true;
    endlessListing = false;
    invokeSiteTool.mockClear();
    listSiteTools.mockClear();
    deps.registerWordPressConnector({ invokeSiteTool, listSiteTools } as never);
    const table = handlers.createWordPressPrimitiveHandlers() as unknown as Record<string, (request: unknown) => Promise<unknown>>;
    read = (input) => table.wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input,
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    refusal = handlers.SITE_TOOL_READ_ONLY_REFUSAL;
    return () => deps._resetWordPressDepsForTests();
  });

  const refused = async (input: unknown): Promise<void> => {
    await expect(read(input)).rejects.toThrow(refusal);
    expect(invokeSiteTool).not.toHaveBeenCalled();
  };

  it("forwards a row whose annotations say read-only, pinned to the row's server with the row's annotations", async () => {
    catalog = [row("core/get-site-info", { readOnlyHint: true })];
    expect(await read({ toolName: "core/get-site-info", instanceId: "wp-1" })).toEqual({ ok: true });
    expect(invokeSiteTool).toHaveBeenCalledTimes(1);
    expect(invokeSiteTool).toHaveBeenCalledWith({
      toolName: "core/get-site-info",
      args: {},
      instanceId: "wp-1",
      serverId: DEFAULT_SERVER,
      expectedRawAnnotations: { readOnlyHint: true },
    });
  });

  it("forwards an unannotated ewpa read on the default server only", async () => {
    catalog = [row("ewpa/get-post", {})];
    await read({ toolName: "ewpa/get-post", args: { post_id: 7 } });
    expect(invokeSiteTool).toHaveBeenCalledWith(expect.objectContaining({ serverId: DEFAULT_SERVER, expectedRawAnnotations: {} }));
  });

  it("takes the annotations and the server from the row, never from the caller", async () => {
    catalog = [row("core/get-site-info", { readOnlyHint: true })];
    await read({ toolName: "core/get-site-info", expectedRawAnnotations: { readOnlyHint: false }, serverId: DEFAULT_SERVER });
    expect(invokeSiteTool).toHaveBeenCalledWith(expect.objectContaining({
      serverId: DEFAULT_SERVER,
      expectedRawAnnotations: { readOnlyHint: true },
    }));
  });

  it.each([
    ["a row that says it is not read-only", [row("core/get-site-info", { readOnlyHint: false })], "core/get-site-info"],
    ["an unannotated core row", [row("core/get-site-info", {})], "core/get-site-info"],
    ["a destructive row", [row("core/get-site-info", { destructiveHint: true })], "core/get-site-info"],
    ["a row with both a read-only and a destructive hint", [row("core/get-site-info", { readOnlyHint: true, destructiveHint: true })], "core/get-site-info"],
    // The class the host listed can be stale or wrong: the row's own hints are checked too.
    [
      "a row listed as read whose stored annotations carry a destructive hint",
      [{ ...row("core/get-site-info", { readOnlyHint: true, destructiveHint: true }), derivedClass: "read" as const }],
      "core/get-site-info",
    ],
    [
      "a row listed as destructive whose stored annotations say read-only",
      [{ ...row("core/get-site-info", { readOnlyHint: true }), derivedClass: "destructive" as const }],
      "core/get-site-info",
    ],
    ["an unannotated ewpa read on a server that is not the default", [row("ewpa/get-post", {}, "srv-2")], "ewpa/get-post"],
    ["an ewpa read marked not read-only on the default server", [row("ewpa/get-post", { readOnlyHint: false })], "ewpa/get-post"],
    ["an ewpa read marked destructive on the default server", [row("ewpa/get-post", { destructiveHint: true })], "ewpa/get-post"],
    ["a known write name, whatever its row says (update)", [row("ewpa/update-post", { readOnlyHint: true })], "ewpa/update-post"],
    ["a known write name, whatever its row says (create)", [row("ewpa/create-post", { readOnlyHint: true })], "ewpa/create-post"],
    ["a name that is not a known read, even with a read-only row", [row("core/get-option", { readOnlyHint: true })], "core/get-option"],
    ["a name with no row in the catalog", [], "core/get-site-info"],
    [
      "a name with a read-only row on two servers",
      [row("core/get-site-info", { readOnlyHint: true }), row("core/get-site-info", { readOnlyHint: true }, "srv-2")],
      "core/get-site-info",
    ],
    [
      "a name with a read-only row and a write row on two servers",
      [row("core/get-site-info", { readOnlyHint: true }), row("core/get-site-info", {}, "srv-2")],
      "core/get-site-info",
    ],
  ] as Array<[string, StubRow[], string]>)("the read tool refuses %s, and the invoker is never called", async (_label, rows, toolName) => {
    catalog = rows;
    await refused({ toolName });
  });

  it("the read tool refuses a row that is on another server than the one the caller named, even when the host ignores the server filter", async () => {
    hostFiltersByServer = false;
    catalog = [row("core/get-site-info", { readOnlyHint: true })];
    await refused({ toolName: "core/get-site-info", serverId: "srv-2" });
  });

  it("the read tool refuses on a catalog listing that does not end, and with no listing capability", async () => {
    catalog = [row("core/get-site-info", { readOnlyHint: true })];
    endlessListing = true;
    await refused({ toolName: "core/get-site-info" });
    endlessListing = false;
    const deps = await import("../../../extensions/cinatra-ai/wordpress-mcp-connector/src/deps");
    deps._resetWordPressDepsForTests();
    deps.registerWordPressConnector({ invokeSiteTool } as never);
    await refused({ toolName: "core/get-site-info" });
  });
});

// ---------------------------------------------------------------------------
// Drupal — the connector agent-path handler cinatra hosts routes the in-admin
// read through the Drupal MCP module, never a direct /jsonapi call.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — hosted Drupal connector", () => {
  const code = readHostedHandlerCode("@cinatra-ai/drupal-mcp-connector/mcp-handlers");

  it("makes no direct fetch() call on the hosted agent path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("references no direct /jsonapi REST path in code (the MCP tool mcp_jsonapi_* is not a path)", () => {
    // A leading-slash JSON:API path is the deleted direct-REST egress; the MCP
    // read tool `mcp_jsonapi_list_entities` uses `_jsonapi`, not `/jsonapi`.
    expect(code).not.toMatch(/\/jsonapi/);
  });

  it("does not host the deleted JSON:API direct-REST helpers", () => {
    for (const deleted of ["readNodeViaJsonApi", "jsonApiGet", "flattenJsonApiNode", "JsonApiResource"]) {
      expect(code).not.toContain(deleted);
    }
  });

  it("routes the in-admin read through the Drupal MCP module (routing-edge positive control)", () => {
    expect(code).toContain("readNodeViaMcp");
    expect(code).toContain("callDrupalMcp");
    expect(code).toContain("mcp_jsonapi_list_entities");
  });
});

// ---------------------------------------------------------------------------
// Core-owned surfaces — cinatra's own WordPress / Drupal MCP-connection helpers
// only ever target the sanctioned MCP route, never a direct CMS content path.
// These halves are independent of the connector lock and stand on their own.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — core WordPress MCP-connection surface", () => {
  const code = stripComments(
    readFileSync(new URL("../wordpress-mcp-connection.ts", import.meta.url), "utf8"),
  );

  it("references no /wp/v2 REST path in code", () => {
    expect(code).not.toMatch(/\/wp\/v2/);
  });

  it("keeps the sanctioned MCP adapter route as the only WP REST target", () => {
    expect(code).toContain("/mcp/mcp-adapter-default-server");
  });

  it("resolves only MCP-adapter endpoints, never a /wp/v2 content URL", () => {
    const site = "https://example.test";
    const pretty = resolveWordPressMcpEndpoint(site);
    const fallback = resolveWordPressMcpFallbackEndpoint(site);
    expect(pretty).toBe(`${site}/wp-json/mcp/mcp-adapter-default-server`);
    expect(fallback).toBe(`${site}/index.php?rest_route=/mcp/mcp-adapter-default-server`);
    expect(pretty).not.toContain("/wp/v2");
    expect(fallback).not.toContain("/wp/v2");
  });
});

describe("in-admin CMS egress guard — core Drupal MCP-connection surface", () => {
  const code = stripComments(
    readFileSync(new URL("../drupal-mcp-connection.ts", import.meta.url), "utf8"),
  );

  it("references no /jsonapi REST path in code", () => {
    expect(code).not.toMatch(/\/jsonapi/);
  });

  it("keeps the sanctioned Drupal MCP tools route as the CMS target", () => {
    expect(code).toContain("/_mcp_tools");
  });
});
