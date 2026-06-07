import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isSetupWizardComplete } from "@/lib/setup-wizard";

export async function GET() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    return NextResponse.json({
      authenticated: false,
      setupComplete: false,
    });
  }

  const setupComplete = await isSetupWizardComplete();

  return NextResponse.json({
    authenticated: true,
    setupComplete,
  });
}
