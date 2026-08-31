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

describe('sendShareExpiryWarningEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendShareExpiryWarningEmail } = await import('../src/services/shareExpiryWarningEmail.js');
    const result = await sendShareExpiryWarningEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: 'Healthcare partner',
      expiresAt: new Date('2026-09-01T14:00:00Z'),
    });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the expected subject, from-address, and recipient', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'notifications@avise.io';
    const { sendShareExpiryWarningEmail } = await import('../src/services/shareExpiryWarningEmail.js');
    const result = await sendShareExpiryWarningEmail({
      to: 'owner@user.com',
      name: 'Jamie Smith',
      dealName: 'Project Falcon',
      shareLabel: 'Healthcare partner',
      expiresAt: new Date('2026-09-01T14:00:00Z'),
    });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <notifications@avise.io>',
        to: 'owner@user.com',
        subject: 'Your shared link for Project Falcon expires soon',
      }),
    );
  });

  it('includes a human-readable expiry date/time and the share label', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendShareExpiryWarningEmail } = await import('../src/services/shareExpiryWarningEmail.js');
    await sendShareExpiryWarningEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: 'Healthcare partner',
      expiresAt: new Date('2026-09-01T14:00:00Z'),
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('September 1, 2026');
    expect(htmlArg).toContain('Healthcare partner');
  });

  it('falls back to generic copy when shareLabel is null (no button anywhere in the body)', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendShareExpiryWarningEmail } = await import('../src/services/shareExpiryWarningEmail.js');
    await sendShareExpiryWarningEmail({
      to: 'owner@user.com',
      name: null,
      dealName: 'Project Falcon',
      shareLabel: null,
      expiresAt: new Date('2026-09-01T14:00:00Z'),
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('The link you created for <strong>Project Falcon</strong>');
    expect(htmlArg).not.toContain('<a href');
    expect(htmlArg).toContain('Hi there,');
  });

  it('HTML-escapes the deal name and share label', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendShareExpiryWarningEmail } = await import('../src/services/shareExpiryWarningEmail.js');
    await sendShareExpiryWarningEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: '<Falcon> & Co',
      shareLabel: '<partner>',
      expiresAt: new Date('2026-09-01T14:00:00Z'),
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('&lt;Falcon&gt; &amp; Co');
    expect(htmlArg).toContain('&lt;partner&gt;');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendShareExpiryWarningEmail } = await import('../src/services/shareExpiryWarningEmail.js');
    const result = await sendShareExpiryWarningEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: null,
      expiresAt: new Date('2026-09-01T14:00:00Z'),
    });

    expect(result).toBe(false);
  });
});
