/**
 * Auth page fixes (USERFLOW-SMOOTHING batch 2): signup with an existing email,
 * resend / enter-code, verify-email straight to onboarding, login "verify your
 * email" way forward, expired reset link, SSO hidden, Remember me removed,
 * MFA as a form with auto-submit, forgot-password cooldown, page titles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const push = vi.fn();
const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => search,
}));

const auth = {
  signUp: vi.fn(),
  resend: vi.fn(),
  signInWithPassword: vi.fn(),
  getUser: vi.fn(),
  getSession: vi.fn(),
  verifyOtp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  mfa: { listFactors: vi.fn(), challengeAndVerify: vi.fn() },
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));
vi.mock("@/lib/api", () => ({ api: { post: vi.fn().mockResolvedValue({}) } }));
vi.mock("@/components/layout/Logo", () => ({ Logo: () => null }));

import SignupPage from "./signup/page";
import VerifyEmailPage from "./verify-email/page";
import LoginPage from "./login/page";
import ResetPasswordPage from "./reset-password/page";
import ForgotPasswordPage from "./forgot-password/page";
import { metadata as forgotMetadata } from "./forgot-password/layout";

const GOOD_PW = "Str0ng!Passw0rd";

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
  auth.resend.mockResolvedValue({ error: null });
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.getSession.mockResolvedValue({ data: { session: {} } });
  auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] } });
});
afterEach(() => {
  vi.useRealTimers();
});

function fillSignup(email = "jane@acme.com") {
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/firm name/i), { target: { value: "Acme" } });
  const pw = screen.getAllByPlaceholderText(/./).filter((el) => (el as HTMLInputElement).type === "password");
  fireEvent.change(pw[0], { target: { value: GOOD_PW } });
  fireEvent.change(pw[1], { target: { value: GOOD_PW } });
  fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
}

describe("Signup", () => {
  it("tells the user an account already exists when Supabase returns no identities", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: "fake", identities: [] }, session: null }, error: null });
    render(<SignupPage />);
    fillSignup();

    expect(await screen.findByText(/an account with this email already exists/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "reset your password" })).toHaveAttribute("href", "/forgot-password");
    expect(screen.queryByText(/check .* for a verification link/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create workspace/i })).not.toBeDisabled();
  });

  it("offers Resend and Enter code while waiting for confirmation, and never sticks disabled", async () => {
    auth.signUp.mockResolvedValue({
      data: { user: { id: "u1", identities: [{ id: "i1" }] }, session: null },
      error: null,
    });
    render(<SignupPage />);
    fillSignup();

    expect(await screen.findByText(/for a verification link/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /enter code instead/i })).toHaveAttribute(
      "href",
      "/verify-email?email=jane%40acme.com",
    );
    expect(screen.getByRole("button", { name: /create workspace/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Resend email" }));
    await waitFor(() => expect(auth.resend).toHaveBeenCalledWith({ type: "signup", email: "jane@acme.com" }));
    expect(await screen.findByRole("button", { name: /resend email \(\d+s\)/i })).toBeDisabled();
  });
});

describe("Verify email", () => {
  it("goes straight to onboarding after a successful link verification", async () => {
    search = new URLSearchParams("token_hash=abc&type=email");
    auth.verifyOtp.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    render(<VerifyEmailPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/onboarding"));
    expect(screen.getByRole("link", { name: /continue to setup/i })).toHaveAttribute("href", "/onboarding");
    expect(screen.queryByText(/redirecting to login/i)).not.toBeInTheDocument();
  });

  it("prefills the code form from ?email=", async () => {
    search = new URLSearchParams("email=jane%40acme.com");
    render(<VerifyEmailPage />);
    expect(await screen.findByText("jane@acme.com")).toBeInTheDocument();
  });
});

function login(email = "jane@acme.com", password = "pw") {
  fireEvent.change(screen.getByPlaceholderText("name@firm.com"), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("Login", () => {
  it("offers a way forward when the email isn't verified", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: "Email not confirmed" } });
    render(<LoginPage />);
    login();

    expect(await screen.findByText(/verify your email address/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter code" })).toHaveAttribute(
      "href",
      "/verify-email?email=jane%40acme.com",
    );
    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));
    await waitFor(() => expect(auth.resend).toHaveBeenCalledWith({ type: "signup", email: "jane@acme.com" }));
    expect(await screen.findByText("Verification email sent")).toBeInTheDocument();
  });

  it("maps raw Supabase errors to readable text", async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: { message: "For security purposes, you can only request this after 41 seconds." },
    });
    render(<LoginPage />);
    login();
    expect(await screen.findByText("Too many attempts. Please wait 41 seconds and try again.")).toBeInTheDocument();
  });

  it("has no dead SSO button and no unwired Remember me", () => {
    render(<LoginPage />);
    expect(screen.queryByText(/single sign-on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/remember me/i)).not.toBeInTheDocument();
  });

  it("MFA: six digits auto-submit; Enter submits the form", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null });
    auth.mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: "f1", status: "verified" }] } });
    auth.mfa.challengeAndVerify.mockResolvedValue({ error: { message: "bad" } });
    render(<LoginPage />);
    login();

    const first = await screen.findByLabelText("Digit 1");
    for (let i = 0; i < 6; i++) {
      fireEvent.change(screen.getByLabelText(`Digit ${i + 1}`), { target: { value: String(i + 1) } });
    }
    await waitFor(() =>
      expect(auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: "f1", code: "123456" }),
    );
    // Wrong code clears the digits; re-entering a different code and pressing
    // Enter (form submit) verifies again.
    await screen.findByText(/invalid code/i);
    auth.mfa.challengeAndVerify.mockResolvedValue({ error: null });
    for (let i = 0; i < 6; i++) {
      fireEvent.change(screen.getByLabelText(`Digit ${i + 1}`), { target: { value: "9" } });
    }
    fireEvent.submit(first.closest("form")!);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });
});

describe("Reset password", () => {
  it("offers 'Request a new link' when the reset link has expired", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    render(<ResetPasswordPage />);
    const link = await screen.findByRole("link", { name: /request a new link/i });
    expect(link).toHaveAttribute("href", "/forgot-password");
  });

  it("names every missing password rule, including the special character", async () => {
    render(<ResetPasswordPage />);
    const pw = screen.getAllByPlaceholderText(/./).filter((el) => (el as HTMLInputElement).type === "password");
    fireEvent.change(pw[0], { target: { value: "Abcdefghij1" } });
    fireEvent.change(pw[1], { target: { value: "Abcdefghij1" } });
    fireEvent.submit(pw[0].closest("form")!);
    expect(await screen.findByText("Password must include a special character.")).toBeInTheDocument();
  });
});

describe("Forgot password", () => {
  it("keeps the field editable and unlocks the button after a cooldown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    auth.resetPasswordForEmail.mockResolvedValue({ error: null });
    render(<ForgotPasswordPage />);
    const input = screen.getByLabelText("Email Address");
    fireEvent.change(input, { target: { value: "jane@acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    const cooling = await screen.findByRole("button", { name: /resend in \d+s/i });
    expect(cooling).toBeDisabled();
    expect(input).not.toBeDisabled();

    for (let i = 0; i < 61; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(await screen.findByRole("button", { name: /send again/i })).not.toBeDisabled();
  });

  it("has its own tab title", () => {
    expect(forgotMetadata.title).toBe("Forgot password");
  });
});
