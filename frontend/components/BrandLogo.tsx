import Image from "next/image";
import Link from "next/link";

type BrandLogoProps = {
  href?: string;
  width?: number;
  height?: number;
  className?: string;
  priority?: boolean;
  /** Header nav: 150% of default logo dimensions */
  variant?: "default" | "header";
};

const LOGO_SIZES = {
  default: {
    width: 150,
    height: 40,
    imageClass:
      "h-8 w-auto max-w-[min(150px,42vw)] object-contain object-left sm:h-10 sm:max-w-[150px]",
  },
  header: {
    width: 225,
    height: 60,
    imageClass:
      "h-12 w-auto max-w-[min(225px,63vw)] object-contain object-left sm:h-[60px] sm:max-w-[225px]",
  },
} as const;

export function BrandLogo({
  href = "/",
  width,
  height,
  className = "",
  priority = false,
  variant = "default",
}: BrandLogoProps) {
  const preset = LOGO_SIZES[variant];
  const image = (
    <Image
      src="/logo.png"
      alt="TradeICT Earner"
      width={width ?? preset.width}
      height={height ?? preset.height}
      priority={priority}
      className={`${preset.imageClass} ${className}`}
    />
  );

  if (!href) {
    return <span className="inline-flex shrink-0 items-center">{image}</span>;
  }

  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {image}
    </Link>
  );
}
