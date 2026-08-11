// Cheap regex/keyword filter that runs BEFORE the LLM classifier on each email.
// Goal: skip obvious non-deal traffic (newsletters, calendar invites, auto-replies,
// recruiter spam, internal team chatter) so we don't burn LLM cost on them.
//
// Pure function — no I/O. Returns { skip: boolean, reason?: string }.

export interface PreFilterInput {
  subject: string;
  snippet: string;
  fromEmail: string;
  labels: string[];
  headers: Record<string, string>;
  orgInternalDomain?: string | null;
}

export interface PreFilterResult {
  skip: boolean;
  reason?: string;
}

// Senders that almost never represent a deal opportunity.
const BLOCKED_DOMAINS = new Set([
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'monster.com',
  'calendly.com',
  'doodle.com',
  'youtube.com',
  'medium.com',
  'substack.com',
  'eventbrite.com',
  'meetup.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'reddit.com',
  'quora.com',
  'asana.com',
  'notion.so',
  'slack.com',
  'github.com',
  'gitlab.com',
]);

// Local-part patterns that indicate transactional / no-reply senders.
const NOREPLY_LOCALPART_RE =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|newsletter|digest|noreply|mailer-daemon|postmaster)/i;

// Subject patterns for auto-replies & out-of-office.
const AUTO_REPLY_SUBJECT_RE =
  /^(auto(matic)?\s*re(ply|:)|out\s*of\s*office|out\s*of\s*the\s*office|ooo\b|automatic\s*response|undeliverable|delivery\s*status\s*notification)/i;

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

function localPartOf(email: string): string {
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(0, at).trim().toLowerCase() : email.trim().toLowerCase();
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

export function shouldSkipForAI(input: PreFilterInput): PreFilterResult {
  const { subject, snippet, fromEmail, labels, headers, orgInternalDomain } = input;

  if (!fromEmail) return { skip: true, reason: 'no-from-address' };

  // RFC 3834 — explicit auto-reply marker.
  const autoSubmitted = headerValue(headers, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') {
    return { skip: true, reason: 'auto-submitted-header' };
  }

  // Bulk mail markers.
  if (headerValue(headers, 'List-Id') || headerValue(headers, 'List-Unsubscribe')) {
    return { skip: true, reason: 'bulk-list-headers' };
  }
  const precedence = headerValue(headers, 'Precedence');
  if (precedence && /bulk|junk|list|auto_reply/i.test(precedence)) {
    return { skip: true, reason: 'precedence-bulk' };
  }

  // Calendar invites — Gmail labels these with CATEGORY_PERSONAL but also tags
  // them with a Content-Type of text/calendar in the multipart. Headers we can
  // see at this layer: presence of "method=REQUEST" hint OR the X-Mailer.
  if (headerValue(headers, 'Content-Class')?.toLowerCase().includes('calendar')) {
    return { skip: true, reason: 'calendar-invite' };
  }

  // Gmail puts promo / social / forums into category labels.
  const labelStr = labels.join(',').toUpperCase();
  if (
    labelStr.includes('CATEGORY_PROMOTIONS') ||
    labelStr.includes('CATEGORY_SOCIAL') ||
    labelStr.includes('CATEGORY_FORUMS')
  ) {
    return { skip: true, reason: 'gmail-category-noise' };
  }
  if (labelStr.includes('SPAM') || labelStr.includes('TRASH')) {
    return { skip: true, reason: 'spam-or-trash' };
  }

  // Auto-reply / out-of-office subjects.
  if (AUTO_REPLY_SUBJECT_RE.test(subject)) {
    return { skip: true, reason: 'auto-reply-subject' };
  }

  // No-reply / mailer senders.
  if (NOREPLY_LOCALPART_RE.test(localPartOf(fromEmail))) {
    return { skip: true, reason: 'noreply-sender' };
  }

  // Hard blocklist by domain.
  const dom = domainOf(fromEmail);
  if (BLOCKED_DOMAINS.has(dom)) {
    return { skip: true, reason: `blocked-domain:${dom}` };
  }

  // Org-internal chatter — colleagues mailing each other from the same domain.
  if (orgInternalDomain && dom === orgInternalDomain.toLowerCase()) {
    return { skip: true, reason: 'org-internal' };
  }

  // Empty / very short bodies — nothing useful to classify.
  if ((subject + ' ' + snippet).trim().length < 20) {
    return { skip: true, reason: 'too-short' };
  }

  return { skip: false };
}
