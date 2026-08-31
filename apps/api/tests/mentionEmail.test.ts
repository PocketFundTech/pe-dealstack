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

describe('sendMentionEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    const result = await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: 'Can you take a look at this?',
    });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the configured from-address and a subject naming the mentioner and deal', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'notify@avise.io';
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    const result = await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: 'Can you take a look at this?',
    });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <notify@avise.io>',
        to: 'recipient@user.com',
        subject: 'Alex mentioned you in Project Falcon',
      }),
    );
  });

  it('HTML-escapes the recipient name, mentioner name, deal name, and note excerpt', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    await sendMentionEmail({
      to: 'recipient@user.com',
      name: '<Jamie> Smith',
      mentionedByName: '<Alex> Doe',
      dealName: 'Deal & Co <Ltd>',
      noteExcerpt: '<script>alert(1)</script> & "quoted"',
    });

    const call = resendSend.mock.calls[0][0];
    expect(call.subject).toBe('&lt;Alex&gt; Doe mentioned you in Deal &amp; Co &lt;Ltd&gt;');
    expect(call.html).toContain('Hi &lt;Jamie&gt;,');
    expect(call.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
    expect(call.html).not.toContain('<script>alert(1)</script>');
  });

  it('falls back to "there" when recipient name is missing', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    await sendMentionEmail({
      to: 'recipient@user.com',
      name: null,
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: 'hello',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
  });

  it('truncates noteExcerpt to 150 characters', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    const longNote = 'x'.repeat(300);
    await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: longNote,
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('x'.repeat(150));
    expect(htmlArg).not.toContain('x'.repeat(151));
  });

  it('omits the excerpt block entirely when noteExcerpt is empty or missing', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).not.toContain('border-left:3px solid #003366');
  });

  it('never includes a call-to-action button/link since the in-app notification already links there', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: 'hello',
    });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).not.toContain('<a ');
    expect(htmlArg).not.toContain('href=');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    const result = await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: 'hello',
    });

    expect(result).toBe(false);
  });

  it('returns false when the Resend client throws', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockRejectedValueOnce(new Error('network down'));
    const { sendMentionEmail } = await import('../src/services/mentionEmail.js');
    const result = await sendMentionEmail({
      to: 'recipient@user.com',
      name: 'Jamie',
      mentionedByName: 'Alex',
      dealName: 'Project Falcon',
      noteExcerpt: 'hello',
    });

    expect(result).toBe(false);
  });
});
