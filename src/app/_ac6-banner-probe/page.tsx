// AC6 PROBE (cinatra#1213) — deliberately reintroduces a non-canonical
// searchParams-flash transient banner to prove the required toast-banner-gate
// bites. This PR is opened DRAFT and CLOSED UNMERGED; it must never land.
import { Alert } from "@/components/ui/alert";

export default function Ac6BannerProbe({
  searchParams,
}: {
  searchParams: URLSearchParams;
}) {
  const saved = searchParams.get("saved");
  return (
    <div>
      {saved ? (
        <Alert variant="destructive">Save failed — this is the probe banner.</Alert>
      ) : null}
    </div>
  );
}
