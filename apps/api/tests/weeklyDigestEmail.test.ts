import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resendSend = vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });
vi.mock('resend', () => ({
  // A real `function`, not an arrow — vitest 4's mock invoker rejects
  // arrow-function implementations used as a constructor ("is not a
  // constructor") since arrows can't be `new`-ed.
  Resend: vi.fn().mockImplementation(function () {
    return { emails: { send: resendSend } };
  }),
}));

describe('sendWeeklyDigestEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendWeeklyDigestEmail } = await import('../src/services/weeklyDigestEmail.js');
    const result = await sendWeeklyDigestEmail({
      to: 'admin@user.com',
      name: 'Jamie',
      orgName: 'Acme Capital',
      counts: { DEAL_CREATED: 3 },
      weekOf: '2026-08-24',
    });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the configured from-address and subject when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'digest@avise.io';
    const { sendWeeklyDigestEmail } = await import('../src/services/weeklyDigestEmail.js');
    const result = await sendWeeklyDigestEmail({
      to: 'admin@user.com',
      name: 'Jamie',
      orgName: 'Acme Capital',
      counts: { DEAL_CREATED: 3 },
      weekOf: '2026-08-24',
    });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <digest@avise.io>',
        to: 'admin@user.com',
        subject: 'Your Avise weekly digest — week of 2026-08-24',
      }),
    );
  });

  it('humanizes each action into a lowercase, underscore-free bulleted line with its count', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendWeeklyDigestEmail } = await import('../src/services/weeklyDigestEmail.js');
    await sendWeeklyDigestEmail({
      to: 'admin@user.com',
      name: 'Jamie',
      orgName: 'Acme Capital',
      counts: { DEAL_CREATED: 3, DOCUMENT_UPLOADED: 12 },
      weekOf: '2026-08-24',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('<li>3 deal created</li>');
    expect(htmlArg).toContain('<li>12 document uploaded</li>');
  });

  it('HTML-escapes the org name and falls back to "there" when name is empty', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendWeeklyDigestEmail } = await import('../src/services/weeklyDigestEmail.js');
    await sendWeeklyDigestEmail({
      to: 'admin@user.com',
      name: '',
      orgName: '<Acme> & Co',
      counts: { DEAL_CREATED: 1 },
      weekOf: '2026-08-24',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
    expect(htmlArg).toContain('&lt;Acme&gt; &amp; Co');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendWeeklyDigestEmail } = await import('../src/services/weeklyDigestEmail.js');
    const result = await sendWeeklyDigestEmail({
      to: 'admin@user.com',
      name: 'Jamie',
      orgName: 'Acme Capital',
      counts: { DEAL_CREATED: 1 },
      weekOf: '2026-08-24',
    });

    expect(result).toBe(false);
  });

  it('returns false when Resend throws', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockRejectedValueOnce(new Error('network down'));
    const { sendWeeklyDigestEmail } = await import('../src/services/weeklyDigestEmail.js');
    const result = await sendWeeklyDigestEmail({
      to: 'admin@user.com',
      name: 'Jamie',
      orgName: 'Acme Capital',
      counts: { DEAL_CREATED: 1 },
      weekOf: '2026-08-24',
    });

    expect(result).toBe(false);
  });
});
