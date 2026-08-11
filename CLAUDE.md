# CLAUDE.md

## Reminders

- **AI classifier needs a current-date injection.** The extraction prompts in `apps/api/src/services/aiExtractor.ts` and the financial agent under `apps/api/src/services/agents/financialAgent/` don't tell the model what today's date is, so period inference (FY/LTM/"current quarter") drifts. Pass the current date into the system prompt at call time, don't hardcode it.
- **NDA signature push detection is disabled outside prod.** Drive `files.watch` (webhook + cron) is commented out in `apps/api/src/app-lite.ts` and `apps/api/src/services/legalDocSendService.ts` because `*.vercel.app` can't be GCP-domain-verified. Active detection runs via on-demand polling (`legalDocSignaturePollService` + `POST /legal-documents/check-signatures`). Before shipping to the verified custom domain, re-enable push — steps in `docs/nda-signature-detection-setup.md` ("Enabling push in production").
