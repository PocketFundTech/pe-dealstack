/** QA #13: Firm Context showed markdown artifacts (#, **, extra line breaks). */
import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../src/utils/plainText.js';

describe('stripMarkdown', () => {
  it('cleans the artifacts the tester saw', () => {
    const md = `### Firm Overview\n\n**Acme Capital** is a *lower mid-market* buyout fund.\n\n\n\n## Thesis\n* Founder-led businesses\n- B2B services\n\n---\n\nSee [the deck](https://x.y) and \`notes\`.`;
    expect(stripMarkdown(md)).toBe(
      'Firm Overview\n\nAcme Capital is a lower mid-market buyout fund.\n\nThesis\n- Founder-led businesses\n- B2B services\n\nSee the deck and notes.',
    );
  });

  it('leaves ordinary text alone', () => {
    const t = 'We invest $5-20M per deal; #1 priority is margin.\n\nTarget: 2x MoM in 3*4 years';
    expect(stripMarkdown(t)).toBe(t);
  });

  it('keeps snake_case and math-like asterisks', () => {
    expect(stripMarkdown('field total_opex and 2*3*4')).toBe('field total_opex and 2*3*4');
  });
});
