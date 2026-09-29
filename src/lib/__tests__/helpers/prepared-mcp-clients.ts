import {
  defaultConnectorInstanceMcpClientFactory,
  type ConnectorInstanceMcpClient,
  type ConnectorInstanceMcpClientFactory,
} from "@/lib/connector-instance-mcp-transport";

/** The pinned WordPress adapter stores all of a user's sessions in one metadata
 * row without atomic updates. Keep fixture session writes out of the concurrent
 * tool-call phase: initialize real clients in order, invoke in parallel, then
 * close in order after EVERY invocation settles. No production retry is changed.
 */
export async function runWithPreparedMcpClients<T>(
  input: { endpoint: string; authHeader: string },
  count: number,
  invoke: (factory: ConnectorInstanceMcpClientFactory, index: number) => Promise<T>,
  create: ConnectorInstanceMcpClientFactory = defaultConnectorInstanceMcpClientFactory,
): Promise<T[]> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("A positive fixture client count is required");
  const clients: ConnectorInstanceMcpClient[] = [];
  let operationFailed = false;
  try {
    for (let i = 0; i < count; i += 1) {
      const client = create(input);
      // Include a partly connected client in cleanup if connect rejects.
      clients.push(client);
      await client.connect();
    }
    const results = await Promise.allSettled(clients.map((client, index) => {
      let used = false;
      const factory: ConnectorInstanceMcpClientFactory = (requested) => {
        if (requested.endpoint !== input.endpoint || requested.authHeader !== input.authHeader) {
          throw new Error("A prepared fixture client cannot be used for a different peer");
        }
        // Retain the production transport's bounded fresh-client retry if the
        // peer independently invalidates a session after fixture preparation.
        if (used) return create(requested);
        used = true;
        return {
          connect: async () => {}, // The real handshake already completed above.
          callTool: (args) => client.callTool(args),
          close: async () => {}, // Defer deletion until all concurrent calls end.
          peerAnswered: () => client.peerAnswered?.() ?? true,
        };
      };
      return Promise.resolve().then(() => invoke(factory, index));
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return results.map((result) => (result as PromiseFulfilledResult<T>).value);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    const failures: unknown[] = [];
    for (const client of clients) {
      try { await client.close(); } catch (error) { failures.push(error); }
    }
    if (!operationFailed && failures.length) throw new AggregateError(failures, "Fixture session cleanup failed");
  }
}
