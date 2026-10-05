// Public share-link pages live outside the app shell, but the root <body> is
// `h-full overflow-hidden` for that shell — so without this wrapper a long
// page is clipped and can't scroll (QA #25a). Same fix as (auth)/layout.tsx.
export default function PublicPageLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh overflow-y-auto">{children}</div>;
}
