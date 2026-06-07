export type QueryResultRow = Readonly<Record<string, unknown>>;

export type QueryResult = {
  readonly rows: readonly QueryResultRow[];
  readonly meta: {
    readonly cubeId: string;
    readonly elapsedMs: number;
  };
};
