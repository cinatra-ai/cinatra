import "server-only";

// Register CRM provider implementations at boot.
// Mirrors src/lib/register-email-providers.ts and register-blog-providers.ts.
//
// The crm-connector facade is provider-agnostic; this file is where concrete
// providers (Twenty today, HubSpot/Salesforce later) get registered with the
// facade's lookup table. Calling this twice is safe — the registry is a Map
// keyed by providerId.

import { registerTwentyProvider } from "@cinatra-ai/twenty-connector";

let _registered = false;

export function registerCrmProviders(): void {
  if (_registered) return;
  registerTwentyProvider();
  _registered = true;
}

// Self-invoke on import. Matches the pattern register-{email,blog}-providers
// use so simply importing this module from the host wires everything up.
registerCrmProviders();
