"use client";

/**
 * Loading body — shown inside FinancialShell while /deals/:id/financials is
 * in flight. Centered spinner with a single line of placeholder copy.
 */
export function DealFinancialsLoadingState() {
  return (
    <div className="text-center py-10">
      <span className="material-symbols-outlined text-gray-300 text-3xl animate-spin block mb-2">progress_activity</span>
      <p className="text-xs text-gray-400">Loading financial data...</p>
    </div>
  );
}

interface DealFinancialsErrorStateProps {
  /** Error message surfaced from the failed fetch. */
  message: string;
  /** Retry handler — re-runs the parent's loadFinancials. */
  onRetry: () => void;
}

/**
 * Error body — shown inside FinancialShell when the financials fetch fails
 * with a non-404 error (404s fall back to the empty state instead). Offers
 * a Retry button that re-runs the parent's loadFinancials.
 */
export function DealFinancialsErrorState({
  message,
  onRetry,
}: DealFinancialsErrorStateProps) {
  return (
    <div className="text-center py-10">
      <span className="material-symbols-outlined text-red-300 text-3xl block mb-2">error</span>
      <p className="text-xs text-gray-500">{message}</p>
      <button onClick={onRetry} className="mt-3 text-xs text-blue-600 hover:underline">Retry</button>
    </div>
  );
}
