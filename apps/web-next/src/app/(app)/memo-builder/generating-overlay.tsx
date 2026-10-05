"use client";

interface GeneratingOverlayProps {
  status?: string;
  title?: string;
  onCancel?: () => void;
}

export function GeneratingOverlay({ title = "Generating Investment Memo", status = "Analyzing deal data and documents...", onCancel }: GeneratingOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl p-8 shadow-2xl max-w-md text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-t-transparent mx-auto mb-4" style={{ borderColor: "#003366", borderTopColor: "transparent" }} />
        <h3 className="text-lg font-semibold mb-2" style={{ color: "#003366" }}>{title}</h3>
        <p className="text-sm text-gray-500">{status}</p>
        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-5 text-sm font-medium text-slate-600 hover:text-slate-900 underline"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
