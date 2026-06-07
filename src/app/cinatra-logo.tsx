import { CINATRA_LOGO } from "@/lib/cinatra-brand";

type CinatraLogoProps = {
  className?: string;
};

export function CinatraLogo({ className }: CinatraLogoProps) {
  return (
    <svg
      viewBox={CINATRA_LOGO.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-label="Cinatra logo"
      className={className}
    >
      <path d={CINATRA_LOGO.brim} />
      <path d={CINATRA_LOGO.crown} />
    </svg>
  );
}
