import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', 'tests'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    env: {
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'test-key',
      // Blank by default so a developer's real local credentials (in
      // apps/api/.env) never leak into the test run — a test whose premise
      // is "Claude/OpenAI unavailable" would otherwise silently see a real
      // credential, skip its intended short-circuit, and make a live paid
      // API call instead (this is exactly how a test hung after
      // ANTHROPIC_OAUTH_TOKEN support was added — see
      // financialCrossVerify.test.ts's env-flag fall-through block). Tests
      // that need a credential present set it themselves, per-test/suite
      // (e.g. ai-client.test.ts's beforeEach), which still overrides this.
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_OAUTH_TOKEN: '',
    },
  },
});
