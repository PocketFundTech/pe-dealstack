"use client";

import { usePathname } from "next/navigation";
import { AuthProvider } from "@/providers/AuthProvider";
import { UserProvider } from "@/providers/UserProvider";
import { NotificationCountProvider } from "@/providers/NotificationCountProvider";
import { ToastProvider } from "@/providers/ToastProvider";
import { IngestDealModalProvider } from "@/providers/IngestDealModalProvider";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { AIAssistant } from "@/components/layout/AIAssistant";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { MfaLockoutGate } from "@/components/layout/MfaLockoutGate";

// Pages that manage their own internal scrolling (full-bleed flex layouts with
// docked side panels). For these we drop the layout's overflow-y-auto wrapper
// so `h-full` chains resolve to the viewport height; otherwise the docked
// chat panel collapses below the deal content instead of side-by-side, and
// the data room's loading spinner / file table can't centre vertically.
function isFullBleedPage(pathname: string): boolean {
  return (
    /^\/deals\/[^/]+$/.test(pathname) ||
    /^\/data-room\/[^/]+$/.test(pathname)
  );
}

// Pages where the global AI Assistant FAB doesn't belong. Internal admin
// telemetry pages aren't a place where you'd ask the AI for help — the FAB
// just adds visual noise and distracts from the data.
function shouldHideAIAssistant(pathname: string): boolean {
  return pathname.startsWith("/internal/");
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const fullBleed = isFullBleedPage(pathname);
  const hideAIAssistant = shouldHideAIAssistant(pathname);
  return (
    <AuthProvider>
      <UserProvider>
        <NotificationCountProvider>
          <ToastProvider>
            <IngestDealModalProvider>
              <MfaLockoutGate>
                <div className="flex h-screen w-full overflow-hidden">
                  <Sidebar />
                  <main className="flex h-full flex-1 flex-col overflow-hidden bg-background-body min-w-0">
                    <Header />
                    <div
                      className={
                        fullBleed
                          ? "flex-1 min-h-0 flex flex-col overflow-hidden"
                          : "flex-1 overflow-y-auto custom-scrollbar"
                      }
                    >
                      <div
                        key={pathname}
                        className={
                          fullBleed
                            ? "page-fade-in flex-1 min-h-0 flex flex-col overflow-hidden"
                            : "page-fade-in"
                        }
                      >
                        {children}
                      </div>
                    </div>
                  </main>
                  {!hideAIAssistant && <AIAssistant />}
                  <CommandPalette />
                </div>
              </MfaLockoutGate>
            </IngestDealModalProvider>
          </ToastProvider>
        </NotificationCountProvider>
      </UserProvider>
    </AuthProvider>
  );
}
