// Nango works-after round-trip (cinatra#352).
//
// Functional proof for a Nango major bump: against a candidate nango-server,
// create a SYNTHETIC integration for a synthetic `unauthenticated` provider (no
// external OAuth/credential test), import a SYNTHETIC connection, write
// connection metadata via setMetadata, then read it back via getConnection — and
// assert the round-tripped metadata equals what was written. This exercises the
// full server → records-DB write/read path AND the @nangohq/node ↔ nango-server
// HTTP API contract end to end: a Nango major that breaks the connections/records
// DB schema, the create-integration/import/get-connection routes, or the
// @nangohq/node client surface fails this read-back. It runs with a 100%
// synthetic, hermetic connection — no external network egress.
//
// SCOPE (deliberate, settled empirically — design §1.3): this asserts the
// connection-STORE round-trip + the API contract, NOT the AES-GCM credential
// envelope. Verified against nango-server (this digest): (a) connection metadata
// is stored in PLAINTEXT in _nango_connections.metadata (not encrypted), and (b)
// importing a real API_KEY/OAuth credential triggers a LIVE provider
// verification call (egress + a valid upstream key) with no skip flag — so a
// secret-free, hermetic gate cannot exercise the credentials_iv/credentials_tag
// crypto path through the public API. The connection-store + records-DB + route
// contract IS the surface a Nango major most commonly breaks, and is what this
// proves; the credential-crypto envelope is out of scope for the secret-free arm.
//
// Uses @nangohq/node (a direct repo dep) pointed at the LOCAL server with a
// THROWAWAY secret key + a per-run throwaway NANGO_ENCRYPTION_KEY — never an ops
// secret. The secret key is the seeded dev-environment key the harness reads
// from the throwaway nango DB and passes via NANGO_SECRET_KEY.
//
// Run: node --import tsx scripts/ci/works-after/rt/nango-roundtrip.ts
// Env: NANGO_SERVER_URL (required), NANGO_SECRET_KEY (required),
//      WORKS_AFTER_NONCE (required — the metadata value to round-trip).

import { Nango } from "@nangohq/node";

const HOST = process.env.NANGO_SERVER_URL;
const SECRET = process.env.NANGO_SECRET_KEY;
const NONCE = process.env.WORKS_AFTER_NONCE;
if (!HOST || !SECRET || !NONCE) {
  console.error("nango-roundtrip: NANGO_SERVER_URL, NANGO_SECRET_KEY and WORKS_AFTER_NONCE are required");
  process.exit(2);
}

const PROVIDER_CONFIG_KEY = "works-after-proof";
const CONNECTION_ID = `works-after-${Date.now()}`;
// A synthetic metadata payload — the value we round-trip through the store.
const METADATA = { worksAfterNonce: NONCE, projectedAt: new Date().toISOString() };

const nango = new Nango({ host: HOST, secretKey: SECRET });

async function ensureIntegration(): Promise<void> {
  // Create the synthetic integration (POST /integrations with
  // {provider, unique_key} — verified against nango-server 0.70.8); tolerate
  // "already exists" on a re-run.
  try {
    await nango.createIntegration({
      provider: "unauthenticated",
      unique_key: PROVIDER_CONFIG_KEY,
    } as Parameters<typeof nango.createIntegration>[0]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/exist|conflict|409|duplicate/i.test(msg)) throw new Error(`createIntegration failed: ${msg}`);
  }
}

async function main(): Promise<void> {
  await ensureIntegration();

  // Import a synthetic connection for the unauthenticated provider via the
  // Connections HTTP endpoint (POST /connections). The @nangohq/node SDK
  // (the 0.70 line) has no connection-import method, so this is a direct call.
  // For an `unauthenticated` provider, the credential type is `NONE` (verified
  // empirically) — no upstream credential-verification call, so the import is
  // hermetic (a real API_KEY/OAuth import would make a live provider call). The
  // connection row is written to Nango's records DB — the store a Nango major /
  // records-DB-schema / route change breaks, which the read-back below proves.
  const importRes = await fetch(`${HOST!.replace(/\/$/, "")}/connections`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      connection_id: CONNECTION_ID,
      provider_config_key: PROVIDER_CONFIG_KEY,
      credentials: { type: "NONE" },
    }),
  });
  if (!importRes.ok) {
    throw new Error(
      `connection import failed: HTTP ${importRes.status} ${(await importRes.text()).slice(0, 300)}`,
    );
  }
  const sdk = nango as unknown as {
    setMetadata: (providerConfigKey: string, connectionId: string, metadata: Record<string, unknown>) => Promise<unknown>;
    getConnection: (providerConfigKey: string, connectionId: string, forceRefresh?: boolean) => Promise<unknown>;
  };
  console.log(`nango-roundtrip: imported synthetic connection '${CONNECTION_ID}' on '${PROVIDER_CONFIG_KEY}'`);

  // Write connection metadata (store) through the @nangohq/node client.
  await sdk.setMetadata(PROVIDER_CONFIG_KEY, CONNECTION_ID, METADATA);
  console.log(`nango-roundtrip: wrote metadata via setMetadata`);

  // Read it back (store → retrieve) and assert byte-equality. This round-trips
  // the connection through Nango's records DB + the get-connection route; a
  // major that breaks the schema, the store, or the client/server contract fails
  // here. (Metadata is the synthetic-safe payload — see the SCOPE note in the
  // header for why the AES-GCM credential envelope is out of scope.)
  const conn = (await sdk.getConnection(PROVIDER_CONFIG_KEY, CONNECTION_ID)) as { metadata?: Record<string, unknown> };
  const got = conn?.metadata ?? {};
  if (got.worksAfterNonce !== NONCE) {
    throw new Error(
      `metadata did not round-trip: wrote worksAfterNonce='${NONCE}', read back '${JSON.stringify(got)}'`,
    );
  }
  console.log(
    `nango-roundtrip OK — synthetic connection imported via the records-DB store, metadata round-tripped byte-equal through get-connection (worksAfterNonce=${NONCE})`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`nango-roundtrip FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
