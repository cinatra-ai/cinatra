import type { NextRequest } from "next/server";
import { guardAppRoute } from "@/lib/auth-route-guard";

export async function proxy(request: NextRequest) {
  return guardAppRoute(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml)$).*)"],
};
