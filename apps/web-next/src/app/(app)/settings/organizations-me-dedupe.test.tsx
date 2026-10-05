/**
 * Perf regression coverage: TrustPosture (SecuritySection.trust.tsx) and
 * RequireMfaToggle (TeamSection.requireMfa.tsx) both used to fetch
 * GET /organizations/me independently -- along with a third caller in
 * SecuritySection.staffAccessLog.tsx -- fanning the settings page's load out
 * into 3x the same request. All three now read through the shared
 * ORGANIZATIONS_ME_KEY useApiQuery key (settings-api-keys.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const get = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patch(...a) },
}));

vi.mock("@/providers/UserProvider", () => ({
  useUser: () => ({
    user: { id: "u1", systemRole: "ADMIN", role: "ADMIN" },
    loading: false,
    refetch: vi.fn(),
  }),
}));

import { invalidateApiCache } from "@/lib/useApiQuery";
import { ORGANIZATIONS_ME_KEY } from "./settings-api-keys";
import { TrustPosture } from "./SecuritySection.trust";
import { RequireMfaToggle } from "./TeamSection.requireMfa";

const org = { id: "org-1", name: "Chanakya Capital", requireMFA: false };

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  invalidateApiCache();
});

describe("TrustPosture + RequireMfaToggle (shared /organizations/me key)", () => {
  it("issue exactly one /organizations/me request when mounted together", async () => {
    get.mockResolvedValue(org);

    render(
      <>
        <TrustPosture />
        <RequireMfaToggle onToast={vi.fn()} />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Chanakya Capital")).toBeInTheDocument());
    // RequireMfaToggle's switch has rendered off the same resolved data.
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ORGANIZATIONS_ME_KEY);
  });

  it("flipping the MFA toggle updates TrustPosture's view of the org without a second fetch", async () => {
    get.mockResolvedValue(org);
    patch.mockResolvedValue({ ...org, requireMFA: true });

    render(
      <>
        <TrustPosture />
        <RequireMfaToggle onToast={vi.fn()} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("switch")).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("switch"));
    // Going off -> on requires the confirm step.
    await userEvent.click(await screen.findByRole("button", { name: /yes, require 2fa/i }));

    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    // The PATCH updated the shared cache directly -- no extra GET was needed.
    expect(get).toHaveBeenCalledTimes(1);
  });
});
