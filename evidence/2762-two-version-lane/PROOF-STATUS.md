# Two-version install proof: what is established, and what is not

This records the state of the real-application proof honestly. It is NOT the
finished proof. Nothing here is a substitute for the screenshots the review asks
for, and no assertion is claimed that was not run.

## What is established

The review's central claim was that a lane can build this environment without
production credentials. That is now demonstrated end to end for the hard part,
the trusted signed package:

- The repo's own Verdaccio image runs on a lane-private port (`127.0.0.1:4880`)
  from `drivers/lane-stack.compose.yml`, under its own compose project, with its
  own volumes. The operator's registry and containers are never touched.
- `drivers/publish-signed.mjs` publishes a newer version of a bundled connector
  to it, signing the canonical v1 payload with a locally generated Ed25519 key
  and carrying the signature in the packument's `dist.cinatraSignature`, which is
  the field the application's own registry client reads.
- `drivers/verify-signature-and-trust.mts` then drives the APPLICATION'S OWN
  modules over that published package: `resolveExtensionDistIntegrity` from the
  registry client, `resolveSignatureVerdict` from the signature module, and
  `classifyExtensionTrust` from the trust classifier.

Captured verbatim in `logs/trust-verdict-signed-local.txt`:

```
resolvedVersion: 0.1.2
signature present: true
SIGNATURE VERDICT: true
TRUST VERDICT: {"tier":"trusted-signed","trusted":true,"reason":"verified signature from a trusted activation host (integrity + persisted decision)"}
```

So a locally published, locally signed package reaches `trusted-signed` through
the real trust path, with no production credentials. The bundled connector in
this tree is at 0.1.0, which is the two-version shape the proof needs.

## What is NOT done

The rest of the lane. None of it is claimed:

1. A production build bundling the older version, and the app running against a
   lane-private database.
2. Installing the signed newer version through the real marketplace install path
   in that running application.
3. The assertions, each with a real screenshot: UI actions non-404; setup,
   settings and provider-write resolution all resolving the same row; the
   declared placeholder rendering; the same assertions again after a restart.
4. The negative run: a bad signature fails before any live finalized row exists,
   with the bundled version usable throughout.
5. A pre-existing stranded-row fixture exercising boot reconciliation.

## Why it stopped here

Session budget, not a technical blocker. The remaining steps are mechanical and
the two ingredients that looked hardest (a trusted local signing key and a local
marketplace host the trust classifier accepts) are the ones now proven. Anyone
continuing has the stack file, the publisher and the verifier in `drivers/`.
