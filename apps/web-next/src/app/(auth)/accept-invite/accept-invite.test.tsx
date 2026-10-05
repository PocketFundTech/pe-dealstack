/**
 * Accept-invite (USERFLOW-SMOOTHING batch 2):
 *  - existing accounts get "Sign in to accept" → authenticated /join endpoint;
 *  - a new account applies the returned session and goes to the app;
 *  - 409 ACCOUNT_EXISTS switches to the sign-in form;
 *  - role shows a friendly label, never the raw enum.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=tok-1"),
}));

const auth = {
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(),
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));

const apiPost = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { post: (...a: unknown[]) => apiPost(...a) } };
});
vi.mock("@/components/layout/Logo", () => ({ Logo: () => null }));

import { ApiError } from "@/lib/api";
import AcceptInvitePage from "./page";

const verifyBody = (extra: Record<string, unknown> = {}) => ({
  valid: true,
  email: "jane@acme.com",
  firmName: "Acme Capital",
  organizationLogo: null,
  role: "MEMBER",
  inviter: { name: "Founder" },
  accountExists: false,
  ...extra,
});

const fetchMock = vi.fn();
function respond(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.setSession.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
});

function fillNewAccount() {
  fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Jane Doe" } });
  fireEvent.change(screen.getByLabelText("Create Password"), { target: { value: "Str0ng!Passw0rd" } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "Str0ng!Passw0rd" } });
  fireEvent.click(screen.getByRole("button", { name: /create account & join/i }));
}

describe("Accept invite — new account", () => {
  it("shows the friendly role label, applies the returned session and opens the app", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("/verify/")
        ? respond(200, verifyBody())
        : respond(200, { success: true, session: { access_token: "at", refresh_token: "rt" } }),
    );
    render(<AcceptInvitePage />);
    expect(await screen.findByText("Associate")).toBeInTheDocument();
    expect(screen.queryByText("MEMBER")).not.toBeInTheDocument();

    fillNewAccount();

    await waitFor(() => expect(auth.setSession).toHaveBeenCalledWith({ access_token: "at", refresh_token: "rt" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });

  it("without a session, tells the user to log in instead of bouncing silently", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("/verify/") ? respond(200, verifyBody()) : respond(200, { success: true, session: null }),
    );
    render(<AcceptInvitePage />);
    await screen.findByText("Associate");
    fillNewAccount();

    expect(await screen.findByText(/log in with your new password/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("switches to sign-in when the server says the account already exists", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("/verify/")
        ? respond(200, verifyBody())
        : respond(409, { error: "exists", code: "ACCOUNT_EXISTS" }),
    );
    render(<AcceptInvitePage />);
    await screen.findByText("Associate");
    fillNewAccount();

    expect(await screen.findByRole("button", { name: /sign in & join/i })).toBeInTheDocument();
  });
});

describe("Accept invite — existing account", () => {
  it("offers 'Sign in to accept', signs in with the invite email, then joins via the API", async () => {
    fetchMock.mockImplementation(() => respond(200, verifyBody({ accountExists: true })));
    auth.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
    apiPost.mockResolvedValue({ success: true, organizationId: "org-A" });

    render(<AcceptInvitePage />);
    expect(await screen.findByText(/already have an avise account/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "whatever-1A!" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in & join/i }));

    await waitFor(() =>
      expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "jane@acme.com", password: "whatever-1A!" }),
    );
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/public/invitations/join/tok-1", {}));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });

  it("lets an already-signed-in matching user join with one click", async () => {
    fetchMock.mockImplementation(() => respond(200, verifyBody({ accountExists: true })));
    auth.getUser.mockResolvedValue({ data: { user: { email: "JANE@acme.com" } } });
    apiPost.mockResolvedValue({ success: true });

    render(<AcceptInvitePage />);
    fireEvent.click(await screen.findByRole("button", { name: /join acme capital/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/public/invitations/join/tok-1", {}));
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("explains a mismatch when signed in as someone else", async () => {
    fetchMock.mockImplementation(() => respond(200, verifyBody({ accountExists: true })));
    auth.getUser.mockResolvedValue({ data: { user: { email: "other@x.com" } } });

    render(<AcceptInvitePage />);
    expect(await screen.findByText(/signed in as other@x.com/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /sign in & join/i })).toBeInTheDocument();
  });

  it("shows the server's reason when joining is refused", async () => {
    fetchMock.mockImplementation(() => respond(200, verifyBody({ accountExists: true })));
    auth.getUser.mockResolvedValue({ data: { user: { email: "jane@acme.com" } } });
    apiPost.mockRejectedValue(
      new ApiError("Your account already belongs to another workspace.", 409, "INVITE_USER_IN_OTHER_ORG"),
    );

    render(<AcceptInvitePage />);
    fireEvent.click(await screen.findByRole("button", { name: /join acme capital/i }));
    expect(await screen.findByText(/already belongs to another workspace/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
