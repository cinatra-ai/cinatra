"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { QueryResult, QuerySpec } from "../types/index";

/**
 * Default endpoint URL. Dashboard widgets call this hook without overrides.
 * Host apps can mount a thin wrapper that changes the URL via the
 * `endpoint` option (e.g. for multi-tenant routing).
 */
export const DEFAULT_QUERY_ENDPOINT = "/api/dashboards/cubejs-api/v1/load";

export type UseCubeQueryOptions = {
  /** Override the fetch URL. Defaults to DEFAULT_QUERY_ENDPOINT. */
  readonly endpoint?: string;
  /** Override @tanstack/react-query `enabled`. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Override @tanstack/react-query `staleTime` (ms). Defaults to 30s so
   * the same widget mount doesn't refetch on every focus change.
   */
  readonly staleTime?: number;
};

/**
 * Fetches a cube query through the dashboards query endpoint. Returns the
 * standard @tanstack/react-query result envelope so widgets can render
 * loading/error/success states without rolling their own state machine.
 *
 * Query key shape: `["dashboards-cube", cubeId, normalizedQuery]`. Include
 * the dashboard revision id here once revisions are part of the query model.
 */
export function useCubeQuery(
  cubeId: string,
  query: QuerySpec,
  opts: UseCubeQueryOptions = {},
): UseQueryResult<QueryResult> {
  const endpoint = opts.endpoint ?? DEFAULT_QUERY_ENDPOINT;
  return useQuery<QueryResult>({
    queryKey: ["dashboards-cube", cubeId, query],
    enabled: opts.enabled ?? true,
    staleTime: opts.staleTime ?? 30_000,
    queryFn: async (): Promise<QueryResult> => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cubeId, query }),
      });
      if (!res.ok) {
        let detail: unknown;
        try {
          detail = await res.json();
        } catch {
          detail = await res.text();
        }
        throw new Error(
          `useCubeQuery(${cubeId}) failed: HTTP ${res.status} ${JSON.stringify(detail)}`,
        );
      }
      // The route returns the Cube.js wire shape `{ data, query, annotation }`
      // so drizzle-cube/client and Cinatra's internal hook talk to the same
      // endpoint. Reshape into the Cinatra `QueryResult` DTO here so consumers
      // don't notice.
      const raw = (await res.json()) as
        | QueryResult
        | { data: unknown[]; query?: unknown; annotation?: unknown };
      if ("rows" in raw && Array.isArray((raw as QueryResult).rows)) {
        return raw as QueryResult;
      }
      if (Array.isArray((raw as { data?: unknown }).data)) {
        const rows = (raw as { data: unknown[] }).data as ReadonlyArray<
          Readonly<Record<string, unknown>>
        >;
        return {
          rows,
          meta: { cubeId, elapsedMs: 0 },
        };
      }
      throw new Error(
        `useCubeQuery(${cubeId}): unrecognized response shape ${JSON.stringify(raw).slice(0, 200)}`,
      );
    },
  });
}
