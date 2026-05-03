import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your TradeICT Earner account.",
};

export default function SignupLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
