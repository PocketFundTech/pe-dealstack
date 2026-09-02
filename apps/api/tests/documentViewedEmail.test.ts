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

describe('sendDocumentViewedEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    const result = await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: 'Healthcare partner',
    });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with a subject naming the deal when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'notify@avise.io';
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    const result = await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: 'Healthcare partner',
    });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <notify@avise.io>',
        to: 'owner@firm.com',
        subject: 'Project Falcon was just viewed',
      }),
    );
  });

  it('mentions the share label in the body when one is present', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: 'Healthcare partner',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Healthcare partner');
  });

  it('falls back to generic "your shared deal" copy when shareLabel is null', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      shareLabel: null,
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Your shared deal');
    expect(htmlArg).not.toContain('&ldquo;');
  });

  it('falls back to generic copy when shareLabel is undefined', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Your shared deal');
  });

  it('HTML-escapes the deal name and share label', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: '<Project> & Co',
      shareLabel: '<VIP> partner',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('&lt;Project&gt; &amp; Co');
    expect(htmlArg).toContain('&lt;VIP&gt; partner');
    const subject = resendSend.mock.calls[0][0].subject;
    expect(subject).toBe('&lt;Project&gt; &amp; Co was just viewed');
  });

  it('falls back to "there" when name is empty or null', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    await sendDocumentViewedEmail({ to: 'owner@firm.com', name: null, dealName: 'Project Falcon' });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    const result = await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
    });

    expect(result).toBe(false);
  });

  it('returns false when Resend throws', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockRejectedValueOnce(new Error('network down'));
    const { sendDocumentViewedEmail } = await import('../src/services/documentViewedEmail.js');
    const result = await sendDocumentViewedEmail({
      to: 'owner@firm.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
    });

    expect(result).toBe(false);
  });
});
