import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));

import { IndexDocumentsForAi } from "./deal-index-docs";

beforeEach(() => { get.mockReset(); post.mockReset(); });

describe("IndexDocumentsForAi", () => {
  it("renders nothing when every document is indexed", async () => {
    get.mockResolvedValue({ pending: 0 });
    const { container } = render(<IndexDocumentsForAi dealId="d1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("indexes in rounds until nothing is left", async () => {
    get.mockResolvedValue({ pending: 30 });
    post
      .mockResolvedValueOnce({ indexed: 25, failed: 0, remaining: 5, error: null })
      .mockResolvedValueOnce({ indexed: 5, failed: 0, remaining: 0, error: null });
    render(<IndexDocumentsForAi dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Index 30 documents for AI" }));
    expect(await screen.findByText(/30 documents indexed/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith("/deals/d1/documents/index-pending", {});
  });

  it("stops and explains when nothing could be indexed", async () => {
    get.mockResolvedValue({ pending: 2 });
    post.mockResolvedValueOnce({ indexed: 0, failed: 2, remaining: 2, error: "AI provider out of credit" });
    render(<IndexDocumentsForAi dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Index 2 documents for AI" }));
    expect(await screen.findByText(/AI provider out of credit/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("explains failures even when the server marked them failed and nothing remains", async () => {
    get.mockResolvedValue({ pending: 2 });
    post.mockResolvedValueOnce({ indexed: 0, failed: 2, remaining: 0, error: "AI provider out of credit" });
    render(<IndexDocumentsForAi dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Index 2 documents for AI" }));
    expect(await screen.findByText(/Couldn't index 2 document\(s\): AI provider out of credit/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("shows both the success line and the failures from a mixed run", async () => {
    get.mockResolvedValue({ pending: 3 });
    post.mockResolvedValueOnce({ indexed: 2, failed: 1, remaining: 0, error: "Unreadable file" });
    render(<IndexDocumentsForAi dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Index 3 documents for AI" }));
    expect(await screen.findByText(/2 documents indexed/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't index 1 document\(s\): Unreadable file/)).toBeInTheDocument();
  });
});
