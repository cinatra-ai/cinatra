import "server-only";

export type PrimitiveInvocationMode = "deterministic" | "agentic" | "system";

export type PrimitiveActorContext = {
  actorType: "human" | "model" | "system" | "a2a";
  userId?: string;
  sessionId?: string;
  requestId?: string;
  campaignId?: string;
  provider?: string;
  model?: string;
  jobId?: string;
  operationId?: string;
  source: "ui" | "route" | "worker" | "scheduler" | "agent" | "a2a" | "mcp";
  approvedByUserId?: string;
  // JWT scope claim, threaded from /api/a2a route through the MCP boundary
  // into the auth-policy bridge. Undefined for non-A2A actors (HumanUser via
  // UI, InternalWorker via BullMQ, etc.). Empty array means "token issued with
  // no scopes" → enforceRunAccess denies all permissions.
  tokenScopes?: string[];
  // Trusted admin role hint. Stamped by upstream code paths that have already
  // verified the caller's better-auth session role at request boundary (route
  // handlers like /api/chat, MCP transport bridge).
  // Used by admin-gated MCP handlers (agent_source_publish,
  // extensions_install, etc.) so they don't have to re-read cookies inside
  // a streaming-response context (where request headers may be detached).
  // Trust boundary: only upstream server-only code may stamp this — no
  // path lets a downstream MCP client forge it.
  platformRole?: "platform_admin" | "member";
  // Trusted org id, stamped the same way as platformRole so downstream handlers
  // (e.g. agent_template upsert during publish) can attribute the new record to
  // the caller's active organization without re-reading the cookie session.
  orgId?: string | null;
};

export type PrimitiveErrorShape = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
  operationId?: string;
};

export class PrimitiveInvocationError extends Error {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
  operationId?: string;

  constructor(input: PrimitiveErrorShape) {
    super(input.message);
    this.name = "PrimitiveInvocationError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.details = input.details;
    this.fieldErrors = input.fieldErrors;
    this.operationId = input.operationId;
  }
}

export type PrimitiveInvocationRequest<TInput> = {
  primitiveName: string;
  input: TInput;
  actor: PrimitiveActorContext;
  mode: PrimitiveInvocationMode;
  idempotencyKey?: string;
};

export type PrimitiveInvocationSuccess<TOutput> = {
  ok: true;
  output: TOutput;
};

export type PrimitiveInvocationFailure = {
  ok: false;
  error: PrimitiveErrorShape;
};

export type PrimitiveInvocationResponse<TOutput> =
  | PrimitiveInvocationSuccess<TOutput>
  | PrimitiveInvocationFailure;

export type PrimitiveTransport = {
  invoke<TInput, TOutput>(request: PrimitiveInvocationRequest<TInput>): Promise<PrimitiveInvocationResponse<TOutput>>;
};

export type PrimitiveInvocationTraceHook = (event: {
  primitiveName: string;
  actor: PrimitiveActorContext;
  mode: PrimitiveInvocationMode;
  status: "started" | "succeeded" | "failed";
  input?: unknown;
  output?: unknown;
  error?: PrimitiveErrorShape;
}) => void | Promise<void>;

export function createInProcessPrimitiveTransport(
  handlers: Record<string, (request: PrimitiveInvocationRequest<unknown>) => Promise<unknown>>,
  options?: {
    onTrace?: PrimitiveInvocationTraceHook;
  },
): PrimitiveTransport {
  return {
    async invoke<TInput, TOutput>(request: PrimitiveInvocationRequest<TInput>) {
      await options?.onTrace?.({
        primitiveName: request.primitiveName,
        actor: request.actor,
        mode: request.mode,
        status: "started",
        input: request.input,
      });

      const handler = handlers[request.primitiveName];
      if (!handler) {
        const error = {
          code: "primitive_not_found",
          message: `Unknown primitive "${request.primitiveName}".`,
          retryable: false,
        } satisfies PrimitiveErrorShape;
        await options?.onTrace?.({
          primitiveName: request.primitiveName,
          actor: request.actor,
          mode: request.mode,
          status: "failed",
          input: request.input,
          error,
        });
        return { ok: false, error };
      }

      try {
        const output = (await handler(request as PrimitiveInvocationRequest<unknown>)) as TOutput;
        await options?.onTrace?.({
          primitiveName: request.primitiveName,
          actor: request.actor,
          mode: request.mode,
          status: "succeeded",
          input: request.input,
          output,
        });
        return {
          ok: true,
          output,
        } satisfies PrimitiveInvocationSuccess<TOutput>;
      } catch (error) {
        const normalized = normalizePrimitiveError(error);
        await options?.onTrace?.({
          primitiveName: request.primitiveName,
          actor: request.actor,
          mode: request.mode,
          status: "failed",
          input: request.input,
          error: normalized,
        });
        return {
          ok: false,
          error: normalized,
        } satisfies PrimitiveInvocationFailure;
      }
    },
  };
}

export async function invokePrimitive<TInput, TOutput>(
  transport: PrimitiveTransport,
  request: PrimitiveInvocationRequest<TInput>,
) {
  const result = await transport.invoke<TInput, TOutput>(request);
  if (!result.ok) {
    throw new PrimitiveInvocationError(result.error);
  }
  return result.output;
}

export function normalizePrimitiveError(error: unknown): PrimitiveErrorShape {
  if (error instanceof PrimitiveInvocationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
      fieldErrors: error.fieldErrors,
      operationId: error.operationId,
    };
  }

  if (error instanceof Error) {
    return {
      code: "primitive_failed",
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "primitive_failed",
    message: "The primitive failed for an unknown reason.",
    retryable: false,
  };
}
