import Image from "next/image";
import Link from "next/link";

type BrandLogoProps = {
  href?: string;
  width?: number;
  height?: number;
  className?: string;
  priority?: boolean;
};

export function BrandLogo({
  href = "/",
  width = 150,
  height = 40,
  className = "",
  priority = false,
}: BrandLogoProps) {
  const image = (
    <Image
      src="/logo.png"
      alt="TradeICT Earner"
      width={width}
      height={height}
      priority={priority}
      className={`h-8 w-auto max-w-[min(150px,42vw)] object-contain object-left sm:h-10 sm:max-w-[150px] ${className}`}
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
