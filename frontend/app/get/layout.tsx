import type { Metadata } from "next";
import { COMPANY } from "@/lib/company";

export const metadata: Metadata = {
  title: "Install TradeICT Earner",
  description: `Install ${COMPANY.productName} on your phone — Android or iPhone.`,
};

export default function GetInstallLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
