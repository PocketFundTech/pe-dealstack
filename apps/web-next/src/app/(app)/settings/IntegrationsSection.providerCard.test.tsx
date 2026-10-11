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
  // At the lg:grid-cols-3 breakpoint each card is ~215px wide. The name's
  // flex-1 container used to share its row with the icon (shrink-0, 40px)
  // AND the status badge (shrink-0, ~70-95px for "Connected"/"Not connected"),
  // leaving as little as 34px for the name — "Microsoft 365" rendered as
  // "Mi...". The fix moves the badge out of that row so the name only
  // competes with the icon for space.
  it("keeps the status badge out of the name's row so a long provider name isn't squeezed", () => {
    renderCard("connected");
    const nameRow = screen.getByText("Gmail").closest('[data-testid="provider-name-row"]');
    expect(nameRow).toBeTruthy();
    expect(nameRow?.contains(screen.getByText("Connected"))).toBe(false);
  });

  it("keeps the 'Not connected' indicator out of the name's row too", () => {
    const handlers = { onConnect: vi.fn(), onDisconnect: vi.fn(), onSyncNow: vi.fn() };
    render(<ProviderCard provider={provider} integration={null} busy={false} {...handlers} />);
    const nameRow = screen.getByText("Gmail").closest('[data-testid="provider-name-row"]');
    expect(nameRow).toBeTruthy();
    expect(nameRow?.contains(screen.getByText("Not connected"))).toBe(false);
  });


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
