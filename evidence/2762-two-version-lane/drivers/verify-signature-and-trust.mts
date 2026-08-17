import { resolveExtensionDistIntegrity } from "@cinatra-ai/registries";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import { classifyExtensionTrust } from "@/lib/extension-trust";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";
const REG = "http://127.0.0.1:4880";
const r = await resolveExtensionDistIntegrity(
  { packageName: PKG, packageVersion: "0.1.2" },
  { registryUrl: REG, token: null } as never,
);
console.log("resolvedVersion:", r.resolvedVersion);
console.log("signature present:", Boolean(r.signature));
const verdict = resolveSignatureVerdict({
  packageName: PKG, version: r.resolvedVersion, integrity: r.integrity, signature: r.signature,
});
console.log("SIGNATURE VERDICT:", JSON.stringify(verdict));
const trust = classifyExtensionTrust({
  packageName: PKG,
  registryUrl: REG,
  integrityVerified: true,
  persistedTrustDecision: true,
  signatureVerified: verdict === true ? true : undefined,
  trustedActivationHosts: ["127.0.0.1:4880"],
  allowMarketplaceBootstrapTrust: false,
});
console.log("TRUST VERDICT:", JSON.stringify(trust));
