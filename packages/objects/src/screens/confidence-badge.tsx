import { Badge } from "@/components/ui/badge";

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence == null) {
    return (
      <Badge variant="secondary" className="font-mono text-xs">
        dynamic
      </Badge>
    );
  }
  if (confidence >= 0.8) {
    return (
      <Badge
        variant="secondary"
        className="border-success/30 bg-success/10 text-success font-mono text-xs"
      >
        {Math.round(confidence * 100)}%
      </Badge>
    );
  }
  if (confidence >= 0.4) {
    return (
      <Badge
        variant="secondary"
        className="border-warning/30 bg-warning/10 text-warning font-mono text-xs"
      >
        {Math.round(confidence * 100)}%
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-mono text-xs">
      {Math.round(confidence * 100)}%
    </Badge>
  );
}
