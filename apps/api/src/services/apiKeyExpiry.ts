import { z } from 'zod';
export const API_KEY_MAX_EXPIRY_DAYS = 3650;
const DAY_MS = 86_400_000;
export const apiKeyExpirySchema = z.object({
  expiresInDays: z.number().int().min(1).max(API_KEY_MAX_EXPIRY_DAYS).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.expiresAt && value.expiresInDays != null) {
    ctx.addIssue({ code: 'custom', message: 'Choose either a duration or a specific expiry date.', path: ['expiresAt'] });
  }
  if (value.expiresAt) {
    const time = Date.parse(value.expiresAt), now = Date.now();
    if (!Number.isFinite(time) || time <= now || time > now + API_KEY_MAX_EXPIRY_DAYS * DAY_MS) {
      ctx.addIssue({ code: 'custom', message: 'Expiry must be in the future and within 10 years.', path: ['expiresAt'] });
    }
  }
});
export function apiKeyExpiresAt(value: z.infer<typeof apiKeyExpirySchema>, now = Date.now()): string | null {
  if (value.expiresAt) return new Date(value.expiresAt).toISOString();
  return value.expiresInDays ? new Date(now + value.expiresInDays * DAY_MS).toISOString() : null;
}
export function isApiKeyExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (expiresAt === null) return false;
  const time = Date.parse(expiresAt);
  // Fail closed for corrupt timestamps as well as at the exact expiry instant.
  return !Number.isFinite(time) || time <= now;
}
