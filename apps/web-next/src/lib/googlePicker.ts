// Generic Google Picker + GIS token-client glue, shared by every "pick a file
// from your Google Drive" flow (NDA Doc import, deal-intake Drive ingest, …).
// NOT a React component — pure browser glue the UI calls on a click.
//
// Why the Picker (and not a pasted URL): the server's connected OAuth scope is
// `drive.file` (per-file access). Drive returns 404 for any file the user
// didn't create through this app, so a pasted link can't be fetched. The
// Picker is Google's own file-chooser; selecting a file there grants OUR app
// per-file `drive.file` access to exactly that file, which the server-side
// token (same OAuth client + same user) then inherits. So the user picks, and
// the server-side fetch/export succeeds.
//
// To get a browser access token WITHOUT exposing the server token we use the
// GIS token client to mint a fresh token scoped ONLY to drive.file. We pass the
// server-connected account email as `hint` so the consent popup targets the
// right Google account even if the browser is logged into a different one.

// Scope requested for the browser token — read/write access limited to files
// the user explicitly opens/creates via this app (incl. Picker selections).
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// Script URLs + idempotency guard attributes. We inject each at most once and
// reuse the in-flight promise on concurrent calls.
const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";

export interface GooglePickerConfig {
  clientId: string;
  apiKey: string;
  appId: string;
}

/**
 * Reads the three NEXT_PUBLIC_GOOGLE_* values inlined at build time (see the
 * `env` block in next.config.ts). Returns them plus `isConfigured`, true only
 * when ALL three are non-empty — the UI uses that to enable/disable the button.
 */
export function getGooglePickerConfig(): GooglePickerConfig & {
  isConfigured: boolean;
} {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY || "";
  const appId = process.env.NEXT_PUBLIC_GOOGLE_APP_ID || "";
  return {
    clientId,
    apiKey,
    appId,
    isConfigured: Boolean(clientId && apiKey && appId),
  };
}

/** Convenience boolean for callers that only need the configured check. */
export const isGooglePickerConfigured: boolean =
  getGooglePickerConfig().isConfigured;

/**
 * Drive MIME allow-list for adding a document to an EXISTING deal (deal
 * Documents tab → "Google Drive"). Mirrors the server document-upload
 * validator's accepted types (apps/api fileValidator.ALLOWED_MIME_TYPES) PLUS
 * native Google types that export cleanly to a supported format (Docs/Slides →
 * PDF, Sheets → XLSX). Deliberately EXCLUDES text/plain, which the document
 * upload endpoint rejects — filtering it out of the picker avoids a confusing
 * post-pick error. Distinct from the deal-intake ingest list (which also
 * accepts .txt because that path runs a different pipeline).
 */
export const DRIVE_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
];

/** Shape returned to the caller when a file is picked. */
export interface PickedGoogleFile {
  fileId: string;
  name: string;
  url: string;
  mimeType: string;
}

// ----------------------------- script loading ----------------------------- //

// Cache the load promises so repeated picks don't re-inject scripts.
let gisPromise: Promise<void> | null = null;
let gapiPickerPromise: Promise<void> | null = null;

/** Injects a <script src> once, resolving on load and rejecting on error. */
function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Google Picker is only available in the browser."));
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error(`Failed to load ${src}`)),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${src}`)),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

/** Loads GIS (token client) once. */
function loadGis(): Promise<void> {
  if (!gisPromise) {
    gisPromise = injectScript(GIS_SRC).catch((err) => {
      // Reset so a later attempt can retry rather than reusing a rejected
      // promise forever.
      gisPromise = null;
      throw err;
    });
  }
  return gisPromise;
}

/** Loads gapi, then the 'picker' module, resolving when google.picker exists. */
function loadGapiPicker(): Promise<void> {
  if (!gapiPickerPromise) {
    gapiPickerPromise = injectScript(GAPI_SRC)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const gapi = window.gapi;
            if (!gapi) {
              reject(new Error("Google API script loaded without window.gapi."));
              return;
            }
            gapi.load("picker", () => {
              if (window.google?.picker) {
                resolve();
              } else {
                reject(new Error("Google Picker module failed to initialize."));
              }
            });
          }),
      )
      .catch((err) => {
        gapiPickerPromise = null;
        throw err;
      });
  }
  return gapiPickerPromise;
}

/**
 * Warm both SDK scripts ahead of the user's click. Call this on mount of any UI
 * that will open the Picker. Critical for popups: browsers only allow a popup
 * during a user gesture, and an `await` on a still-loading script pushes
 * `requestAccessToken()` past that gesture window → the popup gets blocked. If
 * the scripts are already loaded by click time, the awaits in `pickGoogleFile`
 * resolve on the microtask queue (which preserves user activation) and the
 * popup opens reliably. Fire-and-forget — errors surface on the real pick.
 */
export function preloadGooglePicker(): void {
  if (typeof window === "undefined") return;
  if (!getGooglePickerConfig().isConfigured) return;
  void loadGis().catch(() => {});
  void loadGapiPicker().catch(() => {});
}

// ------------------------------- token flow ------------------------------- //

/**
 * Mints a fresh browser access token via GIS, scoped to drive.file only.
 * `hint` pre-selects the Google account (the server-connected email) so the
 * user doesn't accidentally consent under a different logged-in account.
 */
function requestAccessToken(clientId: string, hint?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error("Google sign-in failed to load. Try again."));
      return;
    }
    let settled = false;
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      hint,
      // Minimum friction: silently reuse an existing drive.file grant instead of
      // forcing the account chooser on every pick — the connected user who has
      // already granted access shouldn't be asked to "sign in again" each time.
      // `hint` still targets the server-connected account, and GIS shows UI only
      // when it genuinely needs input (no existing grant, or the hinted account
      // isn't signed into the browser). Empty string = "prompt only when
      // required" in the GIS token model (default would be "select_account").
      prompt: "",
      callback: (response) => {
        if (settled) return;
        settled = true;
        if (response.error || !response.access_token) {
          const detail =
            response.error_description || response.error || "unknown error";
          console.warn("[google-picker] token error", response);
          reject(
            new Error(
              `Google didn't grant access (${detail}). Make sure you pick the account you connected in Settings.`,
            ),
          );
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (error) => {
        if (settled) return;
        settled = true;
        console.warn("[google-picker] token error_callback", error);
        // GIS reports the failure kind in `error.type`. Distinguish a truly
        // blocked popup from a user who closed it.
        let message: string;
        if (error.type === "popup_failed_to_open") {
          message =
            "Your browser blocked the Google sign-in popup. Allow popups for this site, then click again.";
        } else if (error.type === "popup_closed") {
          message =
            "Google sign-in was closed before you finished. Click to try again.";
        } else {
          message =
            error.message || "Google sign-in didn't complete. Try again.";
        }
        reject(new Error(message));
      },
    });
    try {
      client.requestAccessToken();
    } catch (err) {
      if (settled) return;
      settled = true;
      console.warn("[google-picker] requestAccessToken threw", err);
      reject(new Error("Couldn't start Google sign-in. Try again."));
    }
  });
}

// ------------------------------- picker flow ------------------------------ //

// The Picker SDK injects its own dialog (`.picker-dialog`) and backdrop
// (`.picker-dialog-bg`) directly onto document.body at a LOW, hardcoded z-index
// (~1000/1001) that PickerBuilder gives no API to change. Any app overlay that
// portals to document.body at a higher z-index — e.g. the Ingest Deal modal at
// z-[10000], which is exactly where the Drive picker is launched from — would
// paint ON TOP of the picker, hiding it behind the ingest menu. Bump the picker
// above every app layer so it always wins the stacking order (the menu then
// correctly stays below the picker). The nodes are created asynchronously after
// setVisible(true), so re-apply for a short bounded window until they appear.
const PICKER_Z_INDEX = "2147483000"; // above the app's z-[10001] ceiling
const PICKER_RAISE_FRAMES = 30; // ~0.5s of rAF ticks — cheap, self-terminating

function raisePickerAboveApp(): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined") {
    return;
  }
  let frames = 0;
  const bump = () => {
    document
      .querySelectorAll<HTMLElement>(".picker-dialog, .picker-dialog-bg")
      .forEach((el) => {
        el.style.zIndex = PICKER_Z_INDEX;
      });
    if (++frames < PICKER_RAISE_FRAMES) requestAnimationFrame(bump);
  };
  requestAnimationFrame(bump);
}

/**
 * Opens the Google Picker so the user selects ONE Drive file.
 *
 * Resolves with `{ fileId, name, url, mimeType }` on selection, `null` if the
 * user cancels/closes the picker, and REJECTS with a toast-friendly Error on
 * any browser/Google failure (script load, token denial, missing config).
 *
 * @param hint      - Google account email to pre-select in the consent popup.
 * @param mimeTypes - Optional Drive MIME allow-list to filter the picker to
 *                    (e.g. PDF + Docs + Sheets). Omit to show all file types.
 * @param title     - Picker window title.
 */
export async function pickGoogleFile({
  hint,
  mimeTypes,
  title = "Select a file",
}: {
  hint?: string;
  mimeTypes?: string[];
  title?: string;
}): Promise<PickedGoogleFile | null> {
  const { clientId, apiKey, appId, isConfigured } = getGooglePickerConfig();
  if (!isConfigured) {
    throw new Error(
      "Google Drive picker isn't configured. Set NEXT_PUBLIC_GOOGLE_CLIENT_ID, NEXT_PUBLIC_GOOGLE_API_KEY and NEXT_PUBLIC_GOOGLE_APP_ID.",
    );
  }
  if (typeof window === "undefined") {
    throw new Error("Google Picker is only available in the browser.");
  }

  // Load both SDKs (idempotent) in parallel, then mint a token.
  try {
    await Promise.all([loadGis(), loadGapiPicker()]);
  } catch (err) {
    console.warn("[google-picker] script load failed", err);
    throw new Error(
      "Couldn't load Google Drive. Check your connection and try again.",
    );
  }

  const token = await requestAccessToken(clientId, hint);

  const pickerNs = window.google?.picker;
  if (!pickerNs) {
    throw new Error("Google Picker failed to initialize. Try again.");
  }

  return new Promise<PickedGoogleFile | null>((resolve, reject) => {
    try {
      const view = new pickerNs.DocsView();
      if (mimeTypes && mimeTypes.length > 0) {
        view.setMimeTypes(mimeTypes.join(","));
      }
      const picker = new pickerNs.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setOrigin(window.location.origin)
        .setTitle(title)
        .setCallback((data) => {
          if (data.action === pickerNs.Action.PICKED) {
            const doc = data.docs?.[0];
            if (!doc) {
              resolve(null);
              return;
            }
            resolve({
              fileId: doc.id,
              name: doc.name,
              url: doc.url,
              mimeType: typeof doc.mimeType === "string" ? doc.mimeType : "",
            });
            return;
          }
          if (data.action === pickerNs.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
      // Ensure the picker paints above any app overlay it was launched from
      // (e.g. the z-[10000] Ingest Deal modal) instead of behind it.
      raisePickerAboveApp();
    } catch (err) {
      console.warn("[google-picker] picker build failed", err);
      reject(new Error("Couldn't open Google Drive picker. Try again."));
    }
  });
}
