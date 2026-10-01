/**
 * Onboarding flow fixes (USERFLOW-SMOOTHING batch 2):
 *  - "Invite your team" really POSTs /invitations, keeps failed rows, and only
 *    completes when sent (or on an explicit "Skip for now").
 *  - "Use a sample deal" really creates the demo deal before ticking the box.
 *  - Invited teammates get the shortened checklist (no firm-profile task).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      get: (...a: unknown[]) => apiGet(...a),
      post: (...a: unknown[]) => apiPost(...a),
    },
  };
});
const showToast = vi.fn();
vi.mock("@/providers/ToastProvider", () => ({ useToast: () => ({ showToast }) }));
vi.mock("@/app/(app)/deal-intake/components", () => ({ authFetchRaw: vi.fn() }));
vi.mock("@/components/layout/Logo", () => ({ Logo: () => null }));

import { ApiError } from "@/lib/api";
import OnboardingPage from "./page";

function statusWith(context: Record<string, unknown> | null = null, steps: Record<string, boolean> = {}) {
  return { welcomeShown: false, checklistDismissed: false, steps, context };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (path: string) => {
    if (path === "/onboarding/status") return statusWith();
    return [];
  });
  apiPost.mockResolvedValue({ success: true });
});

async function openTeamTask() {
  render(<OnboardingPage />);
  fireEvent.click(await screen.findByText("Let's go"));
  const row = (await screen.findByText("Invite your team")).closest("li")!;
  fireEvent.click(row.querySelector("button")!);
  await screen.findByText("Send invites");
}

describe("Onboarding — invite your team", () => {
  it("sends each filled row to /invitations with an API role and completes the task", async () => {
    apiPost.mockImplementation(async (path: string) =>
      path === "/invitations" ? { id: "inv-1", emailSent: true } : { success: true },
    );
    await openTeamTask();

    fireEvent.change(screen.getByLabelText("Teammate 1 email"), { target: { value: "ana@firm.com" } });
    fireEvent.change(screen.getByLabelText("Teammate 1 role"), { target: { value: "VIEWER" } });
    fireEvent.click(screen.getByText("Send invites"));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/invitations", { email: "ana@firm.com", role: "VIEWER" }),
    );
    // Blank second row is ignored.
    expect(apiPost.mock.calls.filter((c) => c[0] === "/invitations")).toHaveLength(1);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/onboarding/complete-step", { step: "inviteTeamMember" }),
    );
    expect(screen.queryByText("Send invites")).not.toBeInTheDocument();
  });

  it("toasts each failure and keeps the failed rows open instead of completing", async () => {
    apiPost.mockImplementation(async (path: string, body: { email?: string }) => {
      if (path === "/invitations" && body.email === "bad@firm.com") {
        throw new ApiError("Only admins can invite admin users", 403);
      }
      return { success: true, emailSent: true };
    });
    await openTeamTask();

    fireEvent.change(screen.getByLabelText("Teammate 1 email"), { target: { value: "ok@firm.com" } });
    fireEvent.change(screen.getByLabelText("Teammate 2 email"), { target: { value: "bad@firm.com" } });
    fireEvent.click(screen.getByText("Send invites"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "bad@firm.com: Only admins can invite admin users",
        "error",
        expect.anything(),
      ),
    );
    // Modal still open with only the failed row left.
    expect(screen.getByText("Send invites")).toBeInTheDocument();
    expect(screen.getByLabelText("Teammate 1 email")).toHaveValue("bad@firm.com");
    expect(apiPost).not.toHaveBeenCalledWith("/onboarding/complete-step", { step: "inviteTeamMember" });
  });

  it("'Skip for now' completes the task without inviting anyone", async () => {
    await openTeamTask();
    fireEvent.click(screen.getByText("Skip for now"));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/onboarding/complete-step", { step: "inviteTeamMember" }),
    );
    expect(apiPost.mock.calls.some((c) => c[0] === "/invitations")).toBe(false);
  });

  it("does not offer the Admin role to non-admins", async () => {
    await openTeamTask();
    const options = Array.from(
      (screen.getByLabelText("Teammate 1 role") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(["VIEWER", "MEMBER"]);
  });
});

describe("Onboarding — use a sample deal", () => {
  it("creates the demo deal, then ticks the upload step", async () => {
    apiPost.mockImplementation(async (path: string) =>
      path === "/onboarding/create-demo-deal" ? { success: true, dealId: "deal-9" } : { success: true },
    );
    render(<OnboardingPage />);
    fireEvent.click(await screen.findByText("Use a sample deal"));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/onboarding/create-demo-deal", { sampleId: "luktara" }),
    );
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/onboarding/complete-step", { step: "uploadDocument" }),
    );
    expect(await screen.findByText(/1 of 3 complete/)).toBeInTheDocument();
  });

  it("shows an error toast and stays on the welcome view when creation fails", async () => {
    apiPost.mockImplementation(async (path: string) => {
      if (path === "/onboarding/create-demo-deal") throw new ApiError("Organization not set up yet", 400);
      return { success: true };
    });
    render(<OnboardingPage />);
    fireEvent.click(await screen.findByText("Use a sample deal"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Organization not set up yet", "error", expect.anything()),
    );
    expect(screen.getByText("Use a sample deal")).not.toBeDisabled();
    expect(apiPost).not.toHaveBeenCalledWith("/onboarding/complete-step", { step: "uploadDocument" });
  });
});

describe("Onboarding — invited teammates", () => {
  it("skips the welcome pitch and the firm-profile task", async () => {
    apiGet.mockImplementation(async (path: string) =>
      path === "/onboarding/status"
        ? statusWith({ invited: true, firmProfileSet: true, canEditFirmProfile: false })
        : [],
    );
    render(<OnboardingPage />);
    expect(await screen.findByText(/0 of 2 complete/)).toBeInTheDocument();
    expect(screen.queryByText("Define your investment focus")).not.toBeInTheDocument();
    expect(screen.getByText("Upload your first deal")).toBeInTheDocument();
  });
});
