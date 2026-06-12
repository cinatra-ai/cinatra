# Materialization-plan byte-contract fixtures (cinatra#181)

These files are the NORMATIVE cross-side contract between the host verifier
(this repo: `src/lib/extension-materialization-plan-core.ts` +
`src/lib/extension-signature.ts`) and the publish-time signer (the
marketplace side). Prose is descriptive; **the fixture bytes are the
contract** — the signer must reproduce them byte-identically.

| File | Contents |
|---|---|
| `plan.transport.json` | A plan as it may travel in the packument field `cinatraMaterializationPlan` — pretty-printed, keys and arrays deliberately OUT of canonical order (the host re-canonicalizes; transport encoding is free). |
| `plan.canonical.bytes` | The CANONICAL bytes of that plan: keys sorted (UTF-16 code-unit order), `nodes` sorted by `placementPath`, dependency arrays sorted by `name`, zero whitespace, UTF-8. |
| `closure-hash.txt` | Lowercase-hex sha512 over `plan.canonical.bytes` (no trailing newline). |
| `fixture.json` | The extension-tarball identity (`packageName`, `version`, `integrity`) the payloads bind. |
| `payload-v1.bytes` | v1 signature payload: `cinatra-extension-signature/v1\n<name>\n<version>\n<integrity>` (UTF-8, LF, no trailing newline). |
| `payload-v2.bytes` | v2 signature payload: `cinatra-extension-signature/v2\n<name>\n<version>\n<integrity>\n<closureHash>` (5 lines; `none` for closure-less). |
| `signing-keypair.json` | TEST-ONLY Ed25519 keypair (base64 SPKI / PKCS8 DER). Never used outside fixtures. |
| `signature.v1.txt` | Bare-base64 v1 transport value over `payload-v1.bytes`. |
| `signature.v2.txt` | `v2:`-prefixed transport value over `payload-v2.bytes`. |

The fixture plan covers both duplicate classes (same name at two versions;
same name@version at two placement paths) and a hoisted edge.

SINGLE IDENTITY PER NODE: a node's `node_modules` placement name IS its
registry package name. `npm:` ALIASED dependencies (placement name !=
registry identity) are NOT expressible in `cinatra-materialization-plan/v1`;
the closure-mode builder refuses them at build time and the signer must
refuse them at plan computation (alongside git/file/link/workspace sources).

Regeneration (only the derived files — the keypair is stable):

```
CINATRA_REGENERATE_PLAN_FIXTURES=1 pnpm vitest run --config vitest.config.ts \
  src/lib/__tests__/extension-materialization-plan-core.test.ts --no-coverage
```

The golden tests (`extension-materialization-plan-core.test.ts`,
`extension-signature-v2.test.ts`) fail on ANY byte drift.
