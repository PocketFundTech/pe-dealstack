import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { DealContactsSection } from "./deal-contacts";

beforeEach(() => get.mockReset());

describe("DealContactsSection", () => {
  it("lists linked contacts with role and email", async () => {
    get.mockResolvedValue({ contacts: [
      { id: "c1", firstName: "Ann", lastName: "Lee", email: "ann@bank.com", title: "MD", company: "Bank Co", role: "BANKER" },
    ] });
    render(<DealContactsSection dealId="d1" />);
    expect(await screen.findByText("Ann Lee")).toBeInTheDocument();
    expect(screen.getByText("Banker")).toBeInTheDocument();
    expect(screen.getByText("MD · Bank Co")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ann@bank.com" })).toHaveAttribute("href", "mailto:ann@bank.com");
    expect(get).toHaveBeenCalledWith("/deals/d1/contacts");
  });

  it("explains the empty state", async () => {
    get.mockResolvedValue({ contacts: [] });
    render(<DealContactsSection dealId="d1" />);
    expect(await screen.findByText(/No contacts linked to this deal yet/)).toBeInTheDocument();
  });

  it("shows why it failed and retries", async () => {
    get.mockRejectedValueOnce(new Error("Could not load this deal's contacts")).mockResolvedValueOnce({ contacts: [] });
    render(<DealContactsSection dealId="d1" />);
    expect(await screen.findByText("Could not load this deal's contacts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No contacts linked to this deal yet/)).toBeInTheDocument();
  });
});
