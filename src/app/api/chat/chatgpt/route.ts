import { callCodexCliAssistant } from "@/lib/codex-bridge";

type ChatRequestBody = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequestBody;
  const messages = body.messages ?? [];

  // Pass messages directly — callCodexCliAssistant accepts { messages?: Array<{role, content}> }.
  const thread = { messages };
  const userMessage = messages.filter((m) => m.role === "user").pop()?.content ?? "";

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const reply = await callCodexCliAssistant(thread, userMessage);
        send("text", { content: reply });
        send("done", {});
      } catch (err) {
        const message = err instanceof Error ? err.message : "Codex request failed.";
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
