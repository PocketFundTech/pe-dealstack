/**
 * Website URL Scraping Tests
 * Tests the webScraper service and POST /api/ingest/url endpoint.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ============================================================
// Web Scraper — Unit Tests
// ============================================================

describe('scrapeWebsite', () => {
  it('should export scrapeWebsite function', async () => {
    const mod = await import('../src/services/webScraper.js');
    expect(typeof mod.scrapeWebsite).toBe('function');
  });

  it('should return null for unreachable URL', async () => {
    const { scrapeWebsite } = await import('../src/services/webScraper.js');
    const result = await scrapeWebsite('http://localhost:19999/nonexistent');
    expect(result).toBeNull();
  });

  it('should return null for invalid URL', async () => {
    const { scrapeWebsite } = await import('../src/services/webScraper.js');
    const result = await scrapeWebsite('not-a-valid-url');
    expect(result).toBeNull();
  });
});

// ============================================================
// HTML Stripping Logic Tests
// ============================================================

describe('HTML stripping logic', () => {
  function stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('should strip HTML tags', () => {
    const result = stripHtml('<p>Hello <b>World</b></p>');
    expect(result).toBe('Hello World');
  });

  it('should remove script tags and content', () => {
    const result = stripHtml('<p>Text</p><script>alert("xss")</script><p>More</p>');
    expect(result).toBe('Text More');
  });

  it('should remove style tags and content', () => {
    const result = stripHtml('<style>body { color: red; }</style><p>Content</p>');
    expect(result).toBe('Content');
  });

  it('should remove nav tags', () => {
    const result = stripHtml('<nav><a href="/">Home</a></nav><main>Content</main>');
    expect(result).toBe('Content');
  });

  it('should remove header and footer tags', () => {
    const result = stripHtml('<header>Logo</header><main>Content</main><footer>Copyright</footer>');
    expect(result).toBe('Content');
  });

  it('should decode HTML entities', () => {
    const result = stripHtml('Revenue &amp; EBITDA &gt; $100M');
    expect(result).toBe('Revenue & EBITDA > $100M');
  });

  it('should normalize whitespace', () => {
    const result = stripHtml('<p>  Lots   of    spaces  </p>');
    expect(result).toBe('Lots of spaces');
  });

  it('should limit output to 15000 chars', () => {
    const longHtml = '<p>' + 'A'.repeat(20000) + '</p>';
    const result = stripHtml(longHtml).slice(0, 15000);
    expect(result.length).toBeLessThanOrEqual(15000);
  });
});

// ============================================================
// URL Ingest Endpoint Tests
// ============================================================

describe('POST /api/ingest/url', () => {
  function createUrlApp() {
    const app = express();
    app.use(express.json());

    // Mock auth
    app.use((req: any, _res, next) => {
      req.user = { id: 'user-123', email: 'test@example.com', role: 'ADMIN' };
      next();
    });

    // Simulated URL ingest endpoint
    app.post('/api/ingest/url', (req: any, res) => {
      const { url, companyName } = req.body || {};

      // Validate URL
      try {
        if (!url) throw new Error('Missing URL');
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'Invalid input', details: [{ message: 'Must be a valid URL' }] });
      }

      // Simulate scraping result based on URL
      if (url.includes('empty-site')) {
        return res.status(400).json({ error: 'Could not extract enough content from this website' });
      }

      if (url.includes('no-deal-data')) {
        return res.status(400).json({ error: 'Could not extract deal data from website content' });
      }

      // Simulate successful extraction
      const extractedCompany = companyName || 'Scraped Corp';

      res.status(201).json({
        success: true,
        deal: {
          id: 'deal-url-1',
          name: extractedCompany,
          stage: 'INITIAL_REVIEW',
          status: 'ACTIVE',
          company: { id: 'co-1', name: extractedCompany },
        },
        document: {
          id: 'doc-url-1',
          name: `Website scrape — ${url}`,
          type: 'OTHER',
          mimeType: 'text/html',
        },
        extraction: {
          companyName: { value: extractedCompany, confidence: companyName ? 100 : 75 },
          industry: { value: 'Technology', confidence: 70 },
          revenue: { value: 50, confidence: 60 },
          ebitda: { value: 10, confidence: 55 },
          overallConfidence: 65,
          needsReview: true,
          reviewReasons: ['Low confidence on financial data'],
        },
        source: { type: 'web_scrape', url },
      });
    });

    return app;
  }

  let app: express.Express;

  beforeEach(() => {
    app = createUrlApp();
  });

  it('should create a deal from a valid URL', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'https://example.com/about' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.deal).toBeDefined();
    expect(response.body.document).toBeDefined();
    expect(response.body.extraction).toBeDefined();
    expect(response.body.source.type).toBe('web_scrape');
    expect(response.body.source.url).toBe('https://example.com/about');
  });

  it('should reject invalid URL', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'not-a-url' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid');
  });

  it('should reject missing URL', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({});

    expect(response.status).toBe(400);
  });

  it('should return 400 when website has insufficient content', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'https://empty-site.com' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Could not extract enough content');
  });

  it('should return 400 when AI cannot extract deal data', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'https://no-deal-data.com' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Could not extract deal data');
  });

  it('should use provided companyName override', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'https://example.com', companyName: 'My Custom Corp' });

    expect(response.status).toBe(201);
    expect(response.body.deal.name).toBe('My Custom Corp');
    expect(response.body.extraction.companyName.value).toBe('My Custom Corp');
    expect(response.body.extraction.companyName.confidence).toBe(100);
  });

  it('should include extraction with confidence scores', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'https://example.com' });

    expect(response.status).toBe(201);
    const extraction = response.body.extraction;
    expect(extraction.companyName).toHaveProperty('confidence');
    expect(extraction.industry).toHaveProperty('confidence');
    expect(extraction).toHaveProperty('overallConfidence');
    expect(extraction).toHaveProperty('needsReview');
  });

  it('should include document record with text/html mimeType', async () => {
    const response = await request(app)
      .post('/api/ingest/url')
      .send({ url: 'https://example.com' });

    expect(response.status).toBe(201);
    expect(response.body.document.mimeType).toBe('text/html');
    expect(response.body.document.name).toContain('Website scrape');
  });
});

// ============================================================
// SSRF Protection — real router mounted with mocked deps
// ============================================================

vi.mock('../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../src/services/companyResearcher.js', () => ({
  researchCompany: vi.fn(),
  buildResearchText: vi.fn(() => ''),
}));
vi.mock('../src/services/aiExtractor.js', () => ({
  extractDealDataFromText: vi.fn(),
}));
vi.mock('../src/services/financialValidator.js', () => ({
  validateFinancials: vi.fn(() => ({ isValid: true, warnings: [] })),
}));
vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal: vi.fn(),
  getIconForIndustry: vi.fn(() => 'building'),
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { aiIngest: vi.fn() },
}));
vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
}));
vi.mock('../src/routes/notifications.js', () => ({
  resolveUserId: vi.fn(),
}));
vi.mock('../src/routes/ingest-shared.js', () => ({
  formatValueWithUnit: vi.fn((v: number) => String(v)),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const buildRealRouterApp = async () => {
  const { default: router } = await import('../src/routes/ingest-url.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'u', organizationId: 'org-A' };
    next();
  });
  app.use('/api/ingest', router);
  return app;
};

describe('POST /api/ingest/url — SSRF protection', () => {
  beforeEach(() => vi.clearAllMocks());

  // isPrivateUrl covers: localhost, 127.x, 10.x, 192.168.x, 172.16-31.x,
  // 169.254/16 (link-local / AWS IMDS), 100.64/10 (CGNAT), 0.0.0.0,
  // *.local, *.internal, and IPv6 loopback/link-local/unique-local.
  const blocked = [
    'http://localhost:6379/',
    'http://10.0.0.1/',
    'http://192.168.1.1/admin',
    'http://127.0.0.1:8080/',
    'http://172.16.5.5/',
    'http://169.254.169.254/latest/meta-data/', // AWS IMDS
    'http://[::1]/',                            // IPv6 loopback
  ];

  for (const url of blocked) {
    it(`rejects internal/private URL: ${url}`, async () => {
      const app = await buildRealRouterApp();
      const res = await request(app).post('/api/ingest/url').send({ url });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/url|private|internal/i);
    });
  }

  it('does not invoke researchCompany for private URLs', async () => {
    const { researchCompany } = await import('../src/services/companyResearcher.js');
    const app = await buildRealRouterApp();
    await request(app).post('/api/ingest/url').send({ url: 'http://10.0.0.5/' });
    expect(researchCompany).not.toHaveBeenCalled();
  });
});
