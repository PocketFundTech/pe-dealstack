// NDA "bring your own Google Doc" intake — a thin Docs-only wrapper over the
// shared Google Picker glue in @/lib/googlePicker. Kept as its own module so
// the NDA UI's imports and the Docs-only MIME filter live next to the feature.
//
// See @/lib/googlePicker for the full why (drive.file per-file grant model,
// GIS token client, popup/user-activation handling).

import { pickGoogleFile, type PickedGoogleFile } from "@/lib/googlePicker";

export {
  getGooglePickerConfig,
  isGooglePickerConfigured,
  preloadGooglePicker,
} from "@/lib/googlePicker";

// MIME type for native Google Docs. Filters the Picker to just Docs (no
// Sheets/Slides/PDFs) since NDAs are always Docs in this flow.
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/** Shape returned to the caller when a Doc is picked. */
export interface PickedGoogleDoc {
  fileId: string;
  name: string;
  url: string;
}

/**
 * Opens the Google Picker filtered to Google Docs so the user selects ONE of
 * their Docs. Resolves with `{ fileId, name, url }`, `null` if the user
 * cancels, and REJECTS with a toast-friendly Error on failure.
 *
 * @param hint - Google account email to pre-select in the consent popup
 *               (the server-connected account email).
 */
export async function pickGoogleDoc({
  hint,
}: {
  hint?: string;
}): Promise<PickedGoogleDoc | null> {
  const picked: PickedGoogleFile | null = await pickGoogleFile({
    hint,
    mimeTypes: [GOOGLE_DOC_MIME],
    title: "Select a Google Doc to import",
  });
  if (!picked) return null;
  return { fileId: picked.fileId, name: picked.name, url: picked.url };
}
