import Link from "next/link";

// Custom 404 — replaces Next's bare default for any unmatched route.
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <p className="mb-2 text-sm font-semibold" style={{ color: "#003366" }}>
          404
        </p>
        <h2 className="mb-2 text-xl font-semibold text-gray-900">Page not found</h2>
        <p className="mb-6 text-sm text-gray-600">
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <Link
          href="/"
          className="inline-block rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: "#003366" }}
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
