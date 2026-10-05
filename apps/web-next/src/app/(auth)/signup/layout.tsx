import type { Metadata } from "next";

// The page is a client component, so its <title> lives here. Without it the
// tab fell back to the (auth) group default, "Sign In | Avise".
export const metadata: Metadata = { title: "Create your workspace" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
