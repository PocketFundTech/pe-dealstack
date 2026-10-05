/** 5 Oct testing, item 11: document-request emails landing in spam (code side). */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const sent: any[] = [];
vi.mock('resend', () => ({ Resend: class { emails = { send: async (m: any) => { sent.push(m); return { error: null }; } }; } }));
process.env.RESEND_API_KEY = 're_test';
process.env.RESEND_FROM_EMAIL = 'requests@mail.avise.io';

const { sendDocRequestEmail, docRequestSender } = await import('../src/services/docRequestEmail.js');

describe('document request email', () => {
  it('has a named sender, Reply-To the requester, and a plain-text part', async () => {
    await sendDocRequestEmail({
      to: 'cfo@target.com', recipientName: 'Ana', dealName: 'Project Neptune', firmName: 'Acme Capital',
      url: 'https://app.avise.io/upload/tok', items: [{ label: 'FY2024 P&L', required: true }, { label: 'Cap table', required: false }],
      replyTo: 'analyst@acme.com',
    });
    const m = sent.at(-1);
    expect(m.from).toBe('Acme Capital via Avise <requests@mail.avise.io>');
    expect(m.replyTo).toBe('analyst@acme.com');
    expect(m.text).toContain('Acme Capital has requested some documents for Project Neptune.');
    expect(m.text).toContain('- Cap table (optional)');
    expect(m.text).toContain('https://app.avise.io/upload/tok');
    expect(m.html).toContain('Upload documents');
  });

  it('sanitises the sender name', () => {
    expect(docRequestSender('a@b.co', 'Evil "Co" <x@y.z>')).toBe('Evil Co x@y.z via Avise <a@b.co>');
    expect(docRequestSender('a@b.co', null)).toBe('Avise <a@b.co>');
  });
});
