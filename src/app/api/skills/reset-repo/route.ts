import { NextResponse } from "next/server";
import { pushSkillStoreToGitHub } from "@cinatra-ai/skills";

// Defense in depth on this destructive endpoint.
//
// The route remains accessible because `packages/cli/src/index.mjs`
// `cinatra skills reset-repo --yes` POSTs here from the operator's local
// shell. The in-app caller was removed; the only remaining caller is the
// CLI's loopback fetch.
//
// Three independent guards:
//   1. NODE_ENV must NOT be production — even if CINATRA_RUNTIME_MODE
//      is mis-set, production deployments never expose this surface.
//   2. CINATRA_RUNTIME_MODE === 'development' — primary gate.
//   3. The request must originate from a loopback hostname AND must not
//      carry any x-forwarded-* chain — blocks attacker requests proxied
//      through a stale Cloudflare/Tailscale tunnel that may still trust
//      a dev box.
//
// In production this returns 403 immediately. In dev, only loopback POSTs
// (`cinatra skills reset-repo --app-url http://localhost:3000`) succeed.
function isLoopback(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (req.headers.get("x-forwarded-for")) return false;
  if (req.headers.get("x-forwarded-host")) return false;
  try {
    const url = new URL(req.url);
    const h = url.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "host.docker.internal";
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") {
    return NextResponse.json({ error: "Only available in development mode." }, { status: 403 });
  }
  if (!isLoopback(req)) {
    return NextResponse.json(
      {
        error:
          "/api/skills/reset-repo refuses non-loopback origins. " +
          "Use the Library tab → Recreate library admin action for in-app destructive resets.",
      },
      { status: 403 },
    );
  }

  try {
    const result = await pushSkillStoreToGitHub({ force: true });
    return NextResponse.json({ success: true, commitSha: result.commitSha });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error." },
      { status: 500 },
    );
  }
}
