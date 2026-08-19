# Supabase Authentication Configuration Guide

This guide explains how to configure Supabase Authentication for Avise.

## Prerequisites

- Access to your Supabase project dashboard
- Admin permissions on the Supabase project

## 1. Enable Email Verification

Email verification ensures users own the email addresses they register with.

### Steps:

1. Go to your Supabase Dashboard
2. Navigate to **Authentication** → **Providers** → **Email**
3. Enable **"Confirm email"** toggle
4. Click **Save**

### Verification Flow:
```
User signs up → Receives verification email → Clicks link → Redirected to /verify-email.html → Can now login
```

## 2. Configure Email Templates

Customize the emails Supabase sends to users.

### Go to: Authentication → Email Templates

#### Confirmation Email (signup)
```
Subject: Confirm your Avise account

Hi,

Click the link below to verify your email address and activate your Avise account:

{{ .ConfirmationURL }}

If you didn't create an account, you can safely ignore this email.

Best regards,
The Avise Team
```

#### Password Reset Email
```
Subject: Reset your Avise password

Hi,

We received a request to reset your password. Click the link below to set a new password:

{{ .ConfirmationURL }}

This link expires in 24 hours.

If you didn't request this, you can safely ignore this email.

Best regards,
The Avise Team
```

## 3. Configure Redirect URLs

### Go to: Authentication → URL Configuration

Set these URLs:

| Setting | Value |
|---------|-------|
| Site URL | `https://yourdomain.com` (or `http://localhost:3000` for dev) |
| Redirect URLs | Add these: |
| | `http://localhost:3000/verify-email.html` |
| | `http://localhost:3000/reset-password.html` |
| | `https://yourdomain.com/verify-email.html` |
| | `https://yourdomain.com/reset-password.html` |

## 4. JWT Configuration (Optional)

### Go to: Authentication → Settings

| Setting | Recommended Value |
|---------|-------------------|
| JWT expiry time | `3600` (1 hour) |
| Refresh token lifetime | `604800` (7 days) |

## 5. Security Settings

### Go to: Authentication → Settings

Recommended settings:

| Setting | Value |
|---------|-------|
| Enable email confirmations | ✅ On |
| Enable secure email change | ✅ On |
| Minimum password length | 8 |

## 6. Testing the Configuration

### Test Email Verification:
1. Sign up with a new email at `/signup.html`
2. Check your inbox for verification email
3. Click the link in the email
4. You should land on `/verify-email.html` with success message
5. Now try logging in - should work

### Test Password Reset:
1. Go to `/login.html`
2. Click "Forgot password?"
3. Enter your email
4. Check inbox for reset email
5. Click the link - should go to `/reset-password.html`
6. Set new password
7. Try logging in with new password

## 7. Troubleshooting

### Email not received?
- Check spam folder
- Verify Supabase email sending is working (Dashboard → Logs)
- Make sure "Confirm email" is enabled

### "Invalid link" on verification?
- Link may have expired (default 24 hours)
- Link was already used
- User needs to request new verification email

### Password reset link not working?
- Ensure redirect URL is in allowed list
- Check link hasn't expired
- Try requesting new reset email

## 8. Production Checklist

Before going live:

- [ ] Email templates customized with your branding
- [ ] All redirect URLs added (production domains)
- [ ] Site URL set to production domain
- [ ] SMTP configured for custom email domain (optional but recommended)
- [ ] Rate limiting reviewed
- [ ] Test all flows end-to-end

## Custom SMTP (Optional)

For better email deliverability and custom sender address:

1. Go to **Project Settings** → **Auth** → **SMTP Settings**
2. Add your SMTP credentials:
   - Host (e.g., `smtp.sendgrid.net`)
   - Port (typically 587)
   - Username
   - Password
   - Sender email
   - Sender name

Recommended providers:
- SendGrid
- AWS SES
- Postmark
- Resend
