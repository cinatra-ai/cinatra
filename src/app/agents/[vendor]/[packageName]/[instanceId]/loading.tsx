import { LoadingSpinner } from "@/components/loading-spinner";

export default function AgentInstanceLoading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <LoadingSpinner className="h-6 w-6" />
    </div>
  );
}
