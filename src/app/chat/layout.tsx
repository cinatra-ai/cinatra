import { ChatViewPanel } from "@cinatra-ai/chat";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-[calc(100svh-4rem-var(--banner-height,0px))] min-h-0 overflow-hidden">
      <ChatViewPanel />
      <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
        {children}
      </div>
    </div>
  );
}
