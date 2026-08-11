// Minimal ambient declarations for the two Google browser SDKs we load at
// runtime from app/(app)/nda/googlePicker.ts:
//
//   1. gapi loader (https://apis.google.com/js/api.js) — only used to
//      `gapi.load('picker', cb)` so the Picker namespace becomes available.
//   2. Google Picker (google.picker.*) — the file-chooser UI.
//   3. Google Identity Services token client (google.accounts.oauth2.*) —
//      mints a short-lived browser access token scoped to drive.file.
//
// Neither ships bundled @types and we deliberately do NOT add an npm dep for
// them. This covers ONLY the surface googlePicker.ts touches; if you reach for
// something not declared here, add it here rather than casting to `any`.

export {};

declare global {
  // ----------------------------- gapi loader ----------------------------- //
  interface Window {
    gapi?: {
      // Loads a gapi module ('picker', 'client', …). The callback fires once
      // the module is ready. We only ever load 'picker'.
      load: (apiName: string, callback: () => void) => void;
    };
    google?: typeof google;
  }

  namespace google {
    namespace picker {
      // The subset of result actions we branch on. Google sends many more
      // (LOADED, CANCEL, …) but PICKED + CANCEL are all the flow needs.
      enum Action {
        PICKED = "picked",
        CANCEL = "cancel",
      }

      // View identifiers. We only open the Documents view.
      enum ViewId {
        DOCUMENTS = "documents",
      }

      // Keys present on each picked document. We read id / name / url.
      interface DocumentObject {
        id: string;
        name: string;
        url: string;
        // Picker includes more fields (mimeType, sizeBytes, …) — left loose
        // so reads of extra keys stay type-safe without over-specifying.
        [key: string]: unknown;
      }

      // Top-level callback payload. `action` tells us PICKED vs CANCEL; `docs`
      // is populated on PICKED.
      interface ResponseObject {
        action: string;
        docs?: DocumentObject[];
        [key: string]: unknown;
      }

      // A configured view to add to the picker. DocsView is the only one used.
      interface View {
        setMimeTypes(mimeTypes: string): DocsView;
      }

      class DocsView implements View {
        constructor(viewId?: ViewId);
        setMimeTypes(mimeTypes: string): DocsView;
        setIncludeFolders(include: boolean): DocsView;
        setSelectFolderEnabled(enabled: boolean): DocsView;
      }

      // The built picker instance — we only call setVisible(true).
      interface Picker {
        setVisible(visible: boolean): void;
      }

      // Fluent builder. Each setter returns the builder; build() yields the
      // Picker. Only the methods googlePicker.ts calls are declared.
      class PickerBuilder {
        addView(view: View | DocsView | ViewId): PickerBuilder;
        setOAuthToken(token: string): PickerBuilder;
        setDeveloperKey(key: string): PickerBuilder;
        setAppId(appId: string): PickerBuilder;
        setOrigin(origin: string): PickerBuilder;
        setCallback(callback: (data: ResponseObject) => void): PickerBuilder;
        setTitle(title: string): PickerBuilder;
        build(): Picker;
      }
    }

    namespace accounts {
      namespace oauth2 {
        // Shape returned to the token-client callback. On success `access_token`
        // is set; on failure `error` (and friends) describe what went wrong.
        interface TokenResponse {
          access_token?: string;
          error?: string;
          error_description?: string;
          error_uri?: string;
          scope?: string;
          token_type?: string;
          expires_in?: number;
        }

        interface TokenClientConfig {
          client_id: string;
          scope: string;
          // Pre-selects which Google account the consent popup targets — we
          // pass the server-connected Workspace email to dodge an
          // account-mismatch (browser logged into a different account).
          hint?: string;
          prompt?: string;
          callback: (response: TokenResponse) => void;
          error_callback?: (error: { type?: string; message?: string }) => void;
        }

        interface TokenClient {
          requestAccessToken(overrideConfig?: { prompt?: string }): void;
        }

        function initTokenClient(config: TokenClientConfig): TokenClient;
      }
    }
  }
}
