"use client";

type BackgroundProcessStatusBannerProps = {
  variant: "error" | "success";
  message: string;
};

export function BackgroundProcessStatusBanner({
  variant,
  message,
}: BackgroundProcessStatusBannerProps) {
  if (variant === "error") {
    return (
      <div className="mt-3 flex items-start gap-3 rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-5 w-5 shrink-0 text-destructive">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" strokeLinecap="round" />
          <path d="M12 16h.01" strokeLinecap="round" />
        </svg>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-6 text-destructive">Background process failed</p>
          <p className="text-sm leading-6 text-destructive">{message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex items-start gap-3 rounded-control border border-success/30 bg-success/10 px-4 py-3 text-success">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-5 w-5 shrink-0 text-success">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-6 text-success">Background process completed</p>
        <p className="text-sm leading-6 text-success">{message}</p>
      </div>
    </div>
  );
}
