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

describe('sendSignatureCompletedEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendSignatureCompletedEmail } = await import('../src/services/signatureCompletedEmail.js');
    const result = await sendSignatureCompletedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      documentName: 'Mutual NDA',
    });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the configured from-address and a dealName-built subject when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'notify@avise.io';
    const { sendSignatureCompletedEmail } = await import('../src/services/signatureCompletedEmail.js');
    const result = await sendSignatureCompletedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      documentName: 'Mutual NDA',
    });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <notify@avise.io>',
        to: 'owner@user.com',
        subject: 'The NDA for Project Falcon was just signed',
      }),
    );
  });

  it('HTML-escapes name, dealName, and documentName and contains no link/button', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendSignatureCompletedEmail } = await import('../src/services/signatureCompletedEmail.js');
    await sendSignatureCompletedEmail({
      to: 'owner@user.com',
      name: '<Jamie> Smith',
      dealName: '<Falcon> & Co',
      documentName: 'NDA <v2>',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi &lt;Jamie&gt;,');
    expect(htmlArg).toContain('&lt;Falcon&gt; &amp; Co');
    expect(htmlArg).toContain('NDA &lt;v2&gt;');
    expect(htmlArg).not.toContain('<a ');
    expect(htmlArg).not.toContain('href=');
  });

  it('falls back to "there" when name is missing', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendSignatureCompletedEmail } = await import('../src/services/signatureCompletedEmail.js');
    await sendSignatureCompletedEmail({
      to: 'owner@user.com',
      name: null,
      dealName: 'Project Falcon',
      documentName: 'Mutual NDA',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendSignatureCompletedEmail } = await import('../src/services/signatureCompletedEmail.js');
    const result = await sendSignatureCompletedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      documentName: 'Mutual NDA',
    });

    expect(result).toBe(false);
  });

  it('returns false when Resend throws', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockRejectedValueOnce(new Error('network down'));
    const { sendSignatureCompletedEmail } = await import('../src/services/signatureCompletedEmail.js');
    const result = await sendSignatureCompletedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      documentName: 'Mutual NDA',
    });

    expect(result).toBe(false);
  });
});
