# Avise API keys: connecting n8n and other tools

Avise API keys let external tools such as n8n, Zapier, Make or your own scripts call the Avise API without a browser login.

## The standard

| | |
|---|---|
| **Format** | `avise_sk_` followed by 43 URL-safe characters, e.g. `avise_sk_3fJ…Qx9a` |
| **Header** | `Authorization: Bearer avise_sk_…` (preferred) or `X-API-Key: avise_sk_…` |
| **Base URL** | `https://<your Avise domain>/api` (same endpoints the app uses) |
| **Who it acts as** | The admin who created it, inside their organization only |
| **Storage** | Only a SHA-256 hash is stored. The full key is shown **once** at creation |
| **Expiry** | Never, 30 days, 90 days or 1 year (chosen at creation) |
| **Stops working when** | Revoked, expired, the creator is deactivated, or the creator moves to another org |

## Create a key

1. Sign in as an **organization admin**.
2. Go to **Settings → API Keys**.
3. Name the key after where it will be used, e.g. `n8n — deal intake`, and pick an expiry.
4. Click **Create key** and copy it right away. It is never shown again.

Use **one key per integration**, so you can revoke one without breaking the others.

Keys can't create or revoke other keys. That has to be done from a signed-in session.

## Use it in n8n

1. In n8n, go to **Credentials → New → Header Auth**.
   - Name: `Authorization`
   - Value: `Bearer avise_sk_…`
2. In an **HTTP Request** node, set **Authentication → Generic Credential Type → Header Auth** and pick that credential.
3. Call any Avise endpoint, for example:
   - `GET https://<your Avise domain>/api/deals`: list deals
   - `POST https://<your Avise domain>/api/deals`: create a deal
   - `GET https://<your Avise domain>/api/contacts`: list contacts

## Quick test from a terminal

```bash
curl -H "Authorization: Bearer avise_sk_…" https://<your Avise domain>/api/deals
```

A `401` with "Invalid, revoked or expired API key" means the key is wrong, revoked or expired. Create a new one in Settings → API Keys.

## Security notes

- Treat a key like a password. Store it only in n8n credentials or a secret manager, never in a workflow's plain fields, a chat or git.
- If a key leaks, revoke it in Settings → API Keys. It stops working immediately.
- If the organization requires two-factor authentication, the key's creator must have 2FA set up, or requests return `403 MFA_REQUIRED`.
