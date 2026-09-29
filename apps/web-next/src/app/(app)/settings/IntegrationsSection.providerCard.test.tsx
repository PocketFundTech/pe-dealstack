/**
 * An integration whose token expired showed "Reconnect needed" but offered
 * only "Sync now" (fails again) and "Disconnect"; the sync error was never
 * shown. The card now leads with Reconnect and says what went wrong.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProviderCard } from "./IntegrationsSection.providerCard";

const provider = { id: "gmail", name: "Gmail", desc: "Email", icon: "mail", available: true } as never;

function renderCard(status: string, extra: Record<string, unknown> = {}) {
  const handlers = { onConnect: vi.fn(), onDisconnect: vi.fn(), onSyncNow: vi.fn() };
  render(
    <ProviderCard
      provider={provider}
      integration={{ id: "i1", provider: "gmail", status, ...extra } as never}
      busy={false}
      {...handlers}
    />,
  );
  return handlers;
}

describe("ProviderCard", () => {
  it("offers Reconnect for an expired token and shows the sync error", () => {
    const h = renderCard("token_expired", { lastSyncError: "invalid_grant: Token has been expired or revoked." });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(h.onConnect).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    expect(screen.getByText(/Token has been expired or revoked/)).toBeTruthy();
    // Disconnect stays available as a secondary action.
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("offers Reconnect for an integration in error", () => {
    const h = renderCard("error");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(h.onConnect).toHaveBeenCalled();
  });

  it("keeps Sync now + Disconnect for a healthy connection", () => {
    renderCard("connected");
    expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
