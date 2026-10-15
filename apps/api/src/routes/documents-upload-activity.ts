/**
 * Activity-feed text for a document upload. Spreadsheets have no page count;
 * the old template printed "(null pages extracted)" on the deal timeline.
 */
export function uploadActivityDescription(
  docType: string,
  numPages: number | null | undefined,
  extracted: boolean,
  aiAnalyzed: boolean,
): string {
  if (!extracted) return `${docType} document uploaded`;
  const pages = typeof numPages === 'number' && numPages > 0 ? `${numPages} ${numPages === 1 ? 'page' : 'pages'}` : null;
  if (aiAnalyzed) {
    return pages
      ? `${docType} document uploaded, processed (${pages}), and AI-analyzed`
      : `${docType} document uploaded, processed and AI-analyzed`;
  }
  return pages ? `${docType} document uploaded and processed (${pages} extracted)` : `${docType} document uploaded and processed`;
}
