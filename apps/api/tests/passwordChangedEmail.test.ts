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

describe('sendPasswordChangedEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    const result = await sendPasswordChangedEmail({ to: 'user@user.com', name: 'Jamie' });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the configured from-address and subject when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'security@avise.io';
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    const result = await sendPasswordChangedEmail({ to: 'user@user.com', name: '<Jamie>' });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <security@avise.io>',
        to: 'user@user.com',
        subject: 'Your Avise password was changed',
      }),
    );
  });

  it('HTML-escapes the name and uses only the first name in the greeting', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    await sendPasswordChangedEmail({ to: 'user@user.com', name: '<Jamie> Smith' });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi &lt;Jamie&gt;,');
  });

  it('falls back to "there" when name is empty', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    await sendPasswordChangedEmail({ to: 'user@user.com', name: '' });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
  });

  it('never includes a link or button — this is a notice, not a call to action', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    await sendPasswordChangedEmail({ to: 'user@user.com', name: 'Jamie' });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).not.toContain('<a ');
    expect(htmlArg).not.toContain('<button');
    expect(htmlArg.toLowerCase()).toContain("if this wasn't you");
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    const result = await sendPasswordChangedEmail({ to: 'user@user.com', name: 'Jamie' });

    expect(result).toBe(false);
  });

  it('returns false when Resend throws', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockRejectedValueOnce(new Error('network down'));
    const { sendPasswordChangedEmail } = await import('../src/services/passwordChangedEmail.js');
    const result = await sendPasswordChangedEmail({ to: 'user@user.com', name: 'Jamie' });

    expect(result).toBe(false);
  });
});
