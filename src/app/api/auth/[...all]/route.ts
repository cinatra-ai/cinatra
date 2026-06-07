import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

const authHandlers = toNextJsHandler(auth);

export async function GET(
  ...args: Parameters<typeof authHandlers.GET>
): ReturnType<typeof authHandlers.GET> {
  return authHandlers.GET(...args);
}

export async function POST(
  ...args: Parameters<typeof authHandlers.POST>
): ReturnType<typeof authHandlers.POST> {
  return authHandlers.POST(...args);
}
