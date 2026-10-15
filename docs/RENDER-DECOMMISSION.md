# Remove the old Render app (`pe-os.onrender.com`) from everywhere

**Who this is for:** whoever has access to the `avise-site` repo and to the Supabase, Google Cloud and Render dashboards.
**Time:** about 20 minutes. **Cost:** none.

## Why

`https://pe-os.onrender.com` is an **old, separate deployment** of the app. It has its own backend, runs outdated code and has broken AI settings, but it **reads the same production database**. On 15 Oct 2026, during a live demo, it:

- showed outdated financials and model exports, and
- failed a PDF upload with *"Couldn't extract data from this document"* (HTTP 422).

Users end up there because the **"SIGN IN" button on www.avise.io links to it**. The real app is **https://app.avise.io**, on Vercel.

## Do these in order

### 1. Fix the "SIGN IN" link on the marketing site (repo `pocket-fund-2026/avise-site`)

```bash
git clone https://github.com/pocket-fund-2026/avise-site.git
cd avise-site
grep -rn "pe-os.onrender.com" --exclude-dir=node_modules --exclude-dir=.next .
```

Change **every** occurrence:

```
https://pe-os.onrender.com   →   https://app.avise.io/login
```

The known one is the **SIGN IN** link in the top navigation, next to "ABOUT US". Then:

```bash
git commit -am "fix(nav): Sign in goes to app.avise.io, not the old Render app"
git push origin main
```

Vercel (project `avise-site`, team `pocket-funds-projects`) redeploys www.avise.io in about 2 minutes. Verify:

```bash
curl -s https://www.avise.io/ | grep -c onrender                               # expect 0
curl -s https://www.avise.io/ | grep -o 'href="https://app.avise.io/login"'      # expect a match
```

- [ ] Done: Sign in on www.avise.io opens app.avise.io

### 2. Supabase: auth redirect settings

Supabase dashboard → project `rnipkfubpvyvskswsekk` → **Authentication → URL Configuration**:

- **Site URL** = `https://app.avise.io`. Login, confirmation and password-reset emails fall back to this; if it's still Render, emails send people there.
- **Redirect URLs:** keep the `https://app.avise.io/**` and `https://deals.avise.io/**` entries; **delete every `pe-os.onrender.com` entry**.

- [ ] Done

### 3. Google Cloud: OAuth client

Google Cloud Console → APIs & Services → **Credentials** → the OAuth 2.0 client used for sign-in and Gmail/Calendar:

- **Authorized JavaScript origins** and **Authorized redirect URIs**: **remove** any `pe-os.onrender.com` entries. Keep `app.avise.io`, `deals.avise.io` and the Supabase callback `https://rnipkfubpvyvskswsekk.supabase.co/auth/v1/callback`.

- [ ] Done

### 4. Render: suspend the old service, only after step 1 is live

Render dashboard → service **`pe-os`** → **Settings → Suspend Service**.

- It's on the free plan, so this costs nothing and can be undone.
- Do it **after** step 1, or the Sign in button on avise.io becomes a dead link for the ~2 minutes in between.
- Optionally, once a week passes with no issues, **delete** the service.

Verify: `curl -s -o /dev/null -w "%{http_code}\n" https://pe-os.onrender.com/` should no longer return 200 or 307.

- [ ] Done

## Already done in this PR (repo `pe-dealstack`)

- `render.yaml` removed, so nothing in this repo can re-create or redeploy the Render service.
- The current docs (`API.md`, `SECURITY.md`, `TROUBLESHOOTING.md`, `architecture/security.md`) now point at `https://app.avise.io`. `DEPLOYMENT.md` is marked obsolete.
- Historical changelogs (`PROGRESS.md`, `compact.md`, old plans) still mention Render on purpose: they describe what happened at the time.
- No application code references Render.

## After everything is done

- Visiting www.avise.io and clicking **Sign in** lands on `https://app.avise.io/login`.
- `https://pe-os.onrender.com` no longer serves the app.
