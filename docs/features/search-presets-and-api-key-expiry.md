# Search presets and API key expiry

New workspace admins now see the approved nine-step search flow at `/onboarding` after signup/email verification. Invited teammates retain the shorter checklist. Existing users are not forced through the new flow. **Settings → Search Profile → Complete search setup / Edit search profile** opens it explicitly at `/onboarding?search=1`; JSON import remains available for profiles created in the standalone prototype.

## Search profile

`POST /api/firm-context/search-preset` accepts `{ answers }`. `GET` on the same path returns the saved profile and readable brief. Both inherit the existing organization, authentication, MFA and API-key scope middleware; writes additionally require an admin session.

The service stores all collected answers in `Organization.settings.searchProfile`, fills missing Firm Profile fields, and initializes Firm Context and Investment Criteria only if absent. Existing saved profile facts, context, criteria and unrelated settings are preserved. A compare-and-swap update retries concurrent settings changes. Reimporting replaces the saved search profile, not existing manually maintained settings.

The full profile is included in the firm-context consumption hook used by AI and in deal scorecards. Current Investment Criteria take precedence where they overlap with an imported search. Preferences remain separate from hard exclusions. Geography is a target market, not the firm's headquarters; enterprise value is not AUM or an equity cheque. No portfolio holdings are invented from target criteria.

Financial values in the export retain their currency and are in millions. Existing numeric Investment Criteria are USD-based: only USD exports seed those numeric fields. Other currencies stay in the search profile with a visible warning to enter converted values explicitly. Geography, EBITDA maximum, preferences, timing, capital readiness, transition and deal-flow answers remain available in the full context even where the legacy criteria editor has no separate field.

No database migration is required; these presets use the existing JSONB settings column.

## Drafts, skipping and completion

`POST /api/firm-context/search-setup/draft` saves incomplete answers, the current step and touched fields in `Organization.settings.searchSetup`. `POST /api/firm-context/search-setup/skip` retains that draft and marks setup skipped. Both require an authenticated admin session and inherit organization scope and MFA enforcement. Neither endpoint seeds firm settings or AI context. Drafts autosave after 500 ms; a browser-session backup is scoped to the user/workspace for edits made immediately before a refresh.

Completing the nine steps calls the existing preset endpoint directly, saving the full profile and marking setup complete in the same compare-and-swap update. Later stale draft/skip requests cannot downgrade a completed setup. Failed saves stay on the form with a retry path. Skipped/completed admins are not bounced back from the dashboard; explicit Settings visits can resume or edit. Edits to a completed profile are held in the current browser session until the final save.

The opening explanation and skip action are included. Firm name, website, search stage and capital readiness are required only when completing setup. Countries use a searchable ISO list; M&A Advisor and the requested team-size bands are available. Other criteria is one short sentence. Description suggestions use deterministic text matching and stay editable; this change does not add an LLM call during onboarding.

Validation: focused API tests cover context consumption, org scope, draft/skip/complete, retries and expiry boundaries; component tests cover signup routing, the full nine-step flow, validation, failed saves and resume. A browser smoke check runs the actual Next.js page at desktop and phone sizes with mocked authentication/API responses. Live database writes and production AI calls are not exercised by these checks.

## API key expiry

Settings → API Keys retains Never, 30 days, 90 days and 1 year; it also offers 1 day, 7 days and Specific date. Specific date exposes a native calendar and time picker. The browser interprets the selection in the user's local timezone and sends a UTC `expiresAt` timestamp. The list displays the date, time and timezone and refreshes status while the page is open.

The create endpoint accepts either `expiresInDays` or `expiresAt`, not both. Dates must be valid, in the future, and within 3650 days. Existing null expiries remain non-expiring. Authentication reads the key on every request and refuses it at `now >= expiresAt`, with no expiry cache delay. Invalid stored timestamps fail closed.

To test manually, create a read-only key with Specific date set to today and a time a few minutes ahead. Call a permitted GET endpoint using that key before the selected time; repeat at/after expiry and expect HTTP 401. Revoked keys and keys owned by inactive or moved users remain rejected. The automated tests exercise the instant before, at, and after expiry through the real auth middleware with isolated mocked database records; they do not create live production keys.
