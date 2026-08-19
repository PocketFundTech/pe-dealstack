import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Sign In",
    template: "%s | Avise",
  },
  description: "Access your Avise account — AI-powered deal flow management for Private Equity.",
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // The root body has overflow-hidden for the app shell, so we override it here
  // to allow auth pages (signup, login) to scroll normally.
  return (
    <div className="overflow-y-auto" style={{ height: "100vh" }}>
      {children}
    </div>
  );
}
