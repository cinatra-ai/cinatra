import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    name: "Cinatra Core API",
    version: "1.0.0",
    routes: {
      accounts: "/api/core/accounts",
      contacts: "/api/core/contacts",
      campaigns: "/api/core/campaigns",
      campaignTypes: "/api/core/campaign-types",
    },
  });
}
