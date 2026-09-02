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

describe('sendDealStageChangedEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendDealStageChangedEmail } = await import('../src/services/dealStageChangedEmail.js');
    const result = await sendDealStageChangedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      oldStage: 'SCREENING',
      newStage: 'DILIGENCE',
    });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the configured from-address and a subject naming the deal and new stage', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'notify@avise.io';
    const { sendDealStageChangedEmail } = await import('../src/services/dealStageChangedEmail.js');
    const result = await sendDealStageChangedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      oldStage: 'SCREENING',
      newStage: 'DILIGENCE',
    });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <notify@avise.io>',
        to: 'owner@user.com',
        subject: 'Project Falcon moved to DILIGENCE',
      }),
    );
  });

  it('HTML-escapes the deal name, stages, and name, and uses only the first name in the greeting', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDealStageChangedEmail } = await import('../src/services/dealStageChangedEmail.js');
    await sendDealStageChangedEmail({
      to: 'owner@user.com',
      name: '<Jamie> Smith',
      dealName: '<Falcon> & Co',
      oldStage: 'SCREENING',
      newStage: 'DILIGENCE',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi &lt;Jamie&gt;,');
    expect(htmlArg).toContain('&lt;Falcon&gt; &amp; Co');
  });

  it('falls back to "there" when name is missing', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendDealStageChangedEmail } = await import('../src/services/dealStageChangedEmail.js');
    await sendDealStageChangedEmail({
      to: 'owner@user.com',
      name: null,
      dealName: 'Project Falcon',
      oldStage: 'SCREENING',
      newStage: 'DILIGENCE',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendDealStageChangedEmail } = await import('../src/services/dealStageChangedEmail.js');
    const result = await sendDealStageChangedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      oldStage: 'SCREENING',
      newStage: 'DILIGENCE',
    });

    expect(result).toBe(false);
  });

  it('returns false when Resend throws', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockRejectedValueOnce(new Error('network error'));
    const { sendDealStageChangedEmail } = await import('../src/services/dealStageChangedEmail.js');
    const result = await sendDealStageChangedEmail({
      to: 'owner@user.com',
      name: 'Jamie',
      dealName: 'Project Falcon',
      oldStage: 'SCREENING',
      newStage: 'DILIGENCE',
    });

    expect(result).toBe(false);
  });
});
