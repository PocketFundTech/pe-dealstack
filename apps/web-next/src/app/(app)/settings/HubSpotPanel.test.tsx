import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 500) { super(message); this.status = status; }
  },
}));

import { HubSpotPanel } from "./IntegrationsSection";
import { ApiError } from "@/lib/api";

const RUNNING_JOB = {
  id: "job-resume-1",
  status: "running",
  currentObject: "contacts",
  objectCounts: {
    companies: { processed: 3837, created: 1539, updated: 1846, failed: 452 },
    contacts: { processed: 600, created: 355, updated: 129, failed: 116 },
  },
  error: null,
};

const COMPLETED_JOB = {
  id: "job-done-1",
  status: "completed",
  currentObject: null,
  objectCounts: {
    companies: { processed: 10, created: 10, updated: 0, failed: 0 },
  },
  error: null,
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe("HubSpotPanel", () => {
  it("re-hydrates a running job's progress card on mount, without creating a new job", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: RUNNING_JOB });
      if (path === "/integrations/hubspot/import/job-resume-1") return Promise.resolve(RUNNING_JOB);
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/import/job-resume-1/continue") return Promise.resolve({ more: false });
      throw new Error(`unexpected POST ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    expect(await screen.findByText(/syncing contacts/i)).toBeInTheDocument();
    // Never re-created the job — only drove the existing one.
    expect(post).not.toHaveBeenCalledWith("/integrations/hubspot/import", expect.anything());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/integrations/hubspot/import/job-resume-1/continue", { mode: "fill" }),
    );
  });

  it("shows a completed job's final counts as a persistent summary on mount", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: COMPLETED_JOB });
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    // RTL's default text matcher only joins an element's direct text-node
    // children, skipping nested elements — so "Status: " (text node) and
    // "completed" (inside a <span>) never concatenate into one matchable
    // string via getByText. Query the status line by testid and check its
    // full textContent directly instead.
    const status = await screen.findByTestId("hubspot-job-status");
    expect(status).toHaveTextContent(/status:\s*completed/i);
    expect(post).not.toHaveBeenCalled();
  });

  it("shows nothing extra when the org has never run an import", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: null });
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    await screen.findByText(/HubSpot connected/i);
    expect(screen.queryByText(/status:/i)).not.toBeInTheDocument();
  });

  it("retries a dropped connection while driving instead of stopping the import", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: RUNNING_JOB });
      if (path === "/integrations/hubspot/import/job-resume-1") return Promise.resolve(RUNNING_JOB);
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });
    post
      .mockRejectedValueOnce(new (ApiError as unknown as new (m: string, s: number) => Error)("Internal Server Error", 500))
      .mockResolvedValueOnce({ more: false });

    render(<HubSpotPanel onToast={() => {}} />);

    expect(await screen.findByText(/Lost connection to the server — retrying/i)).toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(screen.queryByText(/Internal Server Error/)).not.toBeInTheDocument();
  });

  it("offers Resume import when a running job stops being driven", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: RUNNING_JOB });
      if (path === "/integrations/hubspot/import/job-resume-1") return Promise.resolve(RUNNING_JOB);
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockRejectedValue(new (ApiError as unknown as new (m: string, s: number) => Error)("Import job not found", 404));

    render(<HubSpotPanel onToast={() => {}} />);

    expect(await screen.findByText("Import job not found")).toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "Resume import" });
    expect(button).not.toBeDisabled();
  });

  it("shows X of Y per object and an overall percentage from HubSpot's totals", async () => {
    const job = {
      ...RUNNING_JOB,
      currentObject: "contacts",
      objectCounts: {
        companies: { processed: 3971, created: 3949, updated: 0, failed: 22, total: 3971 },
        contacts: { processed: 500, created: 480, updated: 0, failed: 20, total: 2029 },
      },
    };
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job });
      if (path === "/integrations/hubspot/import/job-resume-1") return Promise.resolve(job);
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockResolvedValue({ more: true });

    render(<HubSpotPanel onToast={() => {}} />);

    expect(await screen.findByText("3,949 of 3,971 imported · 22 failed")).toBeInTheDocument();
    expect(screen.getByText("480 of 2,029 imported · 20 failed")).toBeInTheDocument();
    expect(screen.getByTestId("hubspot-overall")).toHaveTextContent("4,471 of 6,000 records (74%)");
  });

  it("lists past imports with who ran them", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: null });
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [
        { ...COMPLETED_JOB, startedAt: "2026-10-05T10:00:00Z", finishedAt: "2026-10-05T10:42:00Z", startedByName: "Pushkar" },
      ] });
      throw new Error(`unexpected GET ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    const history = await screen.findByTestId("hubspot-history");
    expect(history).toHaveTextContent("Past imports (1)");
    expect(history).toHaveTextContent("Pushkar");
    expect(history).toHaveTextContent("10 imported · 0 failed · took 42 min");
  });
});
