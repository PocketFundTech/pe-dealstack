/**
 * Team & Invitations (USERFLOW-SMOOTHING batch 2): Resend / Revoke per
 * invite, EXPIRED shown from expiresAt, friendly role labels, and a load
 * error with Retry instead of a misleading "No invitations sent yet".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      get: (...a: unknown[]) => apiGet(...a),
      post: (...a: unknown[]) => apiPost(...a),
      delete: (...a: unknown[]) => apiDelete(...a),
    },
  };
});
vi.mock("./TeamSection.requireMfa", () => ({ RequireMfaToggle: () => null }));
vi.mock("@/components/layout/InviteTeamModal", () => ({ InviteTeamModal: () => null }));

import { TeamSection } from "./TeamSection";

const FUTURE = new Date(Date.now() + 3 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const invites = [
  { id: "i1", email: "pending@x.com", role: "MEMBER", status: "PENDING", createdAt: FUTURE, expiresAt: FUTURE, inviteUrl: "u1" },
  // Server says PENDING but it's past expiry — must show EXPIRED.
  { id: "i2", email: "stale@x.com", role: "VIEWER", status: "PENDING", createdAt: PAST, expiresAt: PAST, inviteUrl: "u2" },
  { id: "i3", email: "joined@x.com", role: "ADMIN", status: "ACCEPTED", createdAt: PAST, expiresAt: FUTURE, inviteUrl: null },
];

const rowFor = (email: string) => screen.getByText(email).closest("[data-invite-row]") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue(invites);
});

describe("TeamSection", () => {
  it("shows friendly role labels and EXPIRED for past-expiry invites", async () => {
    render(<TeamSection onToast={vi.fn()} />);
    await screen.findByText("pending@x.com");

    expect(within(rowFor("pending@x.com")).getByText(/Associate/)).toBeInTheDocument();
    expect(within(rowFor("stale@x.com")).getByText(/Analyst/)).toBeInTheDocument();
    expect(within(rowFor("stale@x.com")).getByText("Expired")).toBeInTheDocument();
    expect(within(rowFor("joined@x.com")).getByText("Accepted")).toBeInTheDocument();
    expect(screen.queryByText("MEMBER")).not.toBeInTheDocument();
    // No copy-link for an expired invite; no actions on an accepted one.
    expect(within(rowFor("stale@x.com")).queryByText("Copy Link")).not.toBeInTheDocument();
    expect(within(rowFor("joined@x.com")).queryByText("Resend")).not.toBeInTheDocument();
  });

  it("resends an expired invite and reloads the list", async () => {
    const onToast = vi.fn();
    apiPost.mockResolvedValue({ success: true, emailSent: true });
    render(<TeamSection onToast={onToast} />);
    await screen.findByText("stale@x.com");

    fireEvent.click(within(rowFor("stale@x.com")).getByText("Resend"));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/invitations/i2/resend", {}));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("Invitation resent to stale@x.com", "success"));
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("revokes after confirmation", async () => {
    apiDelete.mockResolvedValue(undefined);
    render(<TeamSection onToast={vi.fn()} />);
    await screen.findByText("pending@x.com");

    fireEvent.click(within(rowFor("pending@x.com")).getByText("Revoke"));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invite" }));

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith("/invitations/i1"));
  });

  it("shows an error with Retry when the list fails to load", async () => {
    apiGet.mockRejectedValueOnce(new Error("Network down"));
    render(<TeamSection onToast={vi.fn()} />);

    expect(await screen.findByText(/Couldn't load invitations/)).toBeInTheDocument();
    expect(screen.queryByText("No invitations sent yet.")).not.toBeInTheDocument();

    apiGet.mockResolvedValueOnce(invites);
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("pending@x.com")).toBeInTheDocument();
  });
});
