# Interview Script — Vikash Chahar (22B3034)

**Role:** Full-Stack + AI Engineer (junior) · Format: Q&A, easy → medium → hard
**His anchors:** MyLeading Campus frontend internship (React ERP dashboard, role-based
access, multilingual chatbot w/ Wit.ai + OpenRouter + Ollama/Qwen, spaCy NLU), AI Finance
Platform (Next.js, TS, PostgreSQL, Prisma, Clerk, ArcJet, Gemini OCR), ShopSensei
(React/TS/Node/PostgreSQL, JWT, OAuth, Stripe), C++ DSA mentor.

**Known probes:**
- **Tutorial-clone risk (main one):** AI Finance Platform matches a famous YouTube
  build-along; his project bullets are near-identical to another applicant's (Neeraj
  Bajiya). Also "scaling to 50K+ users" on a self-project is almost certainly inflated.
  The whole medium tier is designed to detect what he actually understands vs. followed.
- **AI depth is thin:** no RAG, no agents, no embeddings work on resume — chatbot work is
  intent-detection + API calls. Test concepts, expect less than Samruddhi here.
- **Python is his third language** (JS/TS and C++ first) — our AI pipeline is Python.

Format: 60 min → 5 intro · 10 easy · 20 medium · 20 hard · 5 his questions.

---

## Part 0 — Introduction (5 min, no grading)

**Q0.1 — "Tell me about yourself and the project you're most proud of — and what part of it was genuinely yours, not from a guide or tutorial?"**
(Asking this up front, kindly, sets the honesty tone for the interview.)
Listen for: candid distinction between followed and built. Owning "I learned X from a
tutorial, then added Y myself" is a *good* sign, not a bad one.
🚩 Claims everything was from scratch — then fails the deep-dives later.

**Q0.2 — "What do you know about what we're building?"**
Any homework (AI for PE/M&A deal teams, document-heavy) is a plus.

---

## Part 1 — EASY: generic + project level (10 min)

**Q1 — "In ShopSensei, what happens step by step when a user logs in — both the JWT path and the Google OAuth path?"**
✅ Expected: JWT path — verify password (bcrypt), sign token, client sends it per request,
middleware verifies. OAuth path — redirect to Google, callback with code, exchange for
profile, create/find user, then issue own session/JWT.
⭐ Bonus: why you still issue your own token after OAuth; token storage trade-offs.
🚩 Can't explain what the OAuth redirect/callback actually does — copied the auth library
config without understanding.

**Q2 — "Why does the Stripe payment flow happen on your server and not directly from the React frontend?"**
✅ Expected: Secret key must never reach the browser; server creates the payment intent /
session, client only confirms. Trusting the client with amounts = users pay ₹1 for anything.
⭐ Bonus: webhooks for payment confirmation, idempotency.
🚩 "Frontend calls Stripe directly with the key in an env file" — env vars in frontend
bundles are public.

**Q3 — "Your ERP dashboard had role-based, permission-controlled navigation. Where do the permission checks live — frontend, backend, or both — and why?"**
✅ Expected: Both — frontend hides UI for UX, but backend must enforce on every API call
because the client can be manipulated.
🚩 "The frontend hides the buttons" as the security model. (Directly relevant to us — our
CRM is multi-tenant; this is a disqualifying misunderstanding if he holds it firmly.)

**Q4 — "Explain what Prisma gives you over writing raw SQL. Any downsides?"**
✅ Expected: Type-safe queries, migrations, less boilerplate. Downsides: less control,
awkward for complex queries/aggregations, need to watch generated SQL.
⭐ Bonus: mentions N+1 patterns or when he dropped to raw SQL.
🚩 Thinks Prisma *is* the database.

**Q5 — Quick Python warm-up (his 3rd language, ours for AI): "List of transaction dicts, some amounts are strings or missing — sum valid amounts per category. Talk me through it."**
✅ Expected: Gets there with dict/defaultdict + try/except or isinstance, maybe slower than
in JS but functional.
🚩 Genuinely stuck on Python basics — matters because our extraction pipeline is Python.

---

## Part 2 — MEDIUM: tutorial-detector + applied depth (20 min)

**Q6 — THE deep-dive. "Open up the AI Finance Platform. Draw me the database schema — every table, every relation. Then: which part did you change or add beyond the original design?"**
(This is the tutorial-detector. He listed Next.js + Prisma + PostgreSQL — someone who built
it can reproduce the schema cold.)
✅ Expected: Reproduces users/accounts/transactions/budgets tables with correct FKs and
enums, explains why transactions reference both user and account.
⭐ Great: candidly says which parts came from the guide and shows a genuine extension —
a new feature, a fixed bug, a changed model — with reasons.
🚩 Can't sketch the schema of "his own" project, or claims full originality but stumbles
on basics. If Q6 fails, the resume's strongest line is hollow — weigh heavily.

**Q7 — Follow-up: "Your resume says the finance app scaled to 50K+ users. Tell me about that — where was it deployed, what did you observe?"**
✅ Acceptable: honest walk-back ("that was the target/load-test number/from the tutorial
demo") — honesty here partially redeems Q6.
⭐ Great: real deployment story (Vercel + hosted Postgres, connection limits, cold starts).
🚩 Doubles down with vague hand-waving. Integrity signal, not a knowledge one.

**Q8 — "Gemini receipt scanning: what exactly did you send to Gemini, what came back, and what happens when the model reads a number wrong?"**
✅ Expected: Image + prompt requesting structured JSON (amount, date, merchant, category);
parse the response; knows models misread receipts.
⭐ Great: JSON-mode/schema enforcement, user confirmation step before saving ("model
proposes, user verifies"), retry/fallback on malformed JSON.
🚩 Never saw it fail, no validation of what got saved to the DB. (This is our core product
problem in miniature — weight it.)

**Q9 — Internship deep-dive. "The multilingual chatbot: walk me through one message end to end — Marathi voice input to answered intent. Where do Wit.ai, OpenRouter, Ollama and spaCy each sit, and why so many components?"**
✅ Expected: Coherent pipeline (voice→text, intent/entity extraction, routing, response
generation) with a reason each piece exists (e.g., local Ollama for cost/privacy,
OpenRouter for bigger models).
⭐ Great: latency/accuracy trade-offs between local Qwen and hosted models, fallbacks when
intent confidence is low.
🚩 Can't explain why the stack has four AI components — suggests he wired up what he was
told without understanding boundaries.

**Q10 — SQL, live (he claims PostgreSQL). "In your finance schema: write the query for total spend per category for one user in the last 30 days, highest first. Then — what index makes it fast at 10M rows?"**
✅ Expected: GROUP BY with SUM, WHERE on user + date, ORDER BY — written fluently.
⭐ Great: composite index on (user_id, date), knows why it beats separate indexes.
🚩 Can't write GROUP BY without Prisma holding his hand — means "PostgreSQL" on the resume
is really "Prisma."

**Q11 — React performance. "Your ERP dashboard grows: 50 widgets, one slow. Every keystroke in the search box re-renders everything. Diagnose and fix."**
✅ Expected: State placement — lift the search state down/isolate it; memoize expensive
children (React.memo/useMemo); identify re-render cause with profiler.
⭐ Great: virtualization for long lists, debouncing the search, server-side filtering.
🚩 "Use useEffect" / random hook-shuffling without a mental model of re-renders.

---

## Part 3 — HARD: production & design, our product (20 min)

**Q12 — The money question (same for all candidates). "We extract financials from deal documents (CIMs, Excel) and the numbers MUST be right — LLMs hallucinate. Design an extraction pipeline we can trust."**
✅ Expected: Structured output (JSON schema/function calling), validation layer,
cross-checks (line items sum to totals), low-confidence → human review, never silently guess.
⭐ Great: grounding — source page/cell stored next to every number; labeled eval set to
measure accuracy over time; temperature 0; "model proposes, system verifies."
(His Q8 receipt-scanning experience is the seed — see if he generalizes it.)
🚩 "Better prompt / better model" as the whole answer.

**Q13 — "You've called LLM APIs directly. What's an agent, how is it different, and when is an agent the wrong choice?"**
✅ Expected: Agent = loop where the model picks actions/tools (query DB, call API), observes
results, iterates — vs. single-shot calls. Wrong choice when a deterministic pipeline or
one call does the job.
⭐ Great: failure modes — loops, compounding errors, cost — so constrain tools, stop
conditions, human-in-the-loop for side effects.
🚩 No concept beyond "chatbot." (Expected weaker here than Samruddhi — grade the reasoning,
he has no RAG/agent background.)

**Q14 — Collaborative design. "Design 'deal Q&A': user asks *what was 2023 EBITDA for this deal?*, answered from that deal's uploaded documents. Whiteboard it."**
✅ Expected: Documents scoped per deal (tenancy — connect to his own RBAC internship work),
retrieval or structured lookup, citation, explicit "not found in documents" path.
⭐ Great: query already-extracted financials table instead of re-reading PDFs each time;
asks "what if two documents disagree?" — strong hire signal.
🚩 No scoping (cross-deal leakage), no citations, guesses when the answer is absent.
(He hasn't built RAG — walk him to it and grade how fast he picks it up. Speed of uptake
here IS the interview signal for him.)

**Q15 — Full-stack systems. "Receipt upload feels slow: user uploads → Gemini call takes 8s → UI is frozen. Redesign the flow."**
✅ Expected: Don't block the request — async processing (job/queue), return immediately,
show pending state, update via polling or websocket/refresh.
⭐ Great: idempotency, retry on model failure, timeout handling, optimistic UI with
editable extraction result.
🚩 "Make Gemini faster" / synchronous 8s request is fine.

**Q16 — "Tell me about a time an AI coding tool (Cursor/Copilot/ChatGPT/Claude) gave you wrong code. How did you catch it?"**
✅ Expected: Concrete story, caught by reading/testing/docs — shows he reviews AI output.
🚩 "It's never wrong" or doesn't use them. (Given the tutorial-heavy resume, no story here
compounds the Q6/Q7 concern: it suggests shipping unreviewed output is the default.)

---

## Scoring

| Area | 1 (no-hire) | 3 (bar) | 5 (strong) | Score |
|---|---|---|---|---|
| Authenticity (Q0.1, Q6, Q7) | Bluffs, schema fails | Honest about tutorial vs own | Real extensions, candid | |
| Full-stack (Q1–Q4, Q11, Q15) | Config-level recall | Explains + trade-offs | Production instincts | |
| SQL depth (Q6, Q10) | Prisma-only | Fluent GROUP BY/JOINs | Indexing, scale thinking | |
| Python (Q5) | Stuck | Functional | Fluent | |
| AI reasoning (Q8, Q12–Q14) | Buzzwords | API-level + validation instinct | Verification-first design | |
| AI-tool fluency (Q16) | None/blind trust | Daily + reviews | Sharp failure story | |

**Decision guide:** For Vikash the interview hinges on **Q6 + Q7 (authenticity)** and
**Q12 + Q14 (can he think beyond API calls)**. If he reproduces his schema cold, is honest
about what came from tutorials, and picks up the RAG design quickly in Q14, he's the
strongest stack-fit in the pool — hire. If Q6 collapses and he doubles down on the 50K-users
claim, the resume is a house of cards regardless of how well he talks — pass, and note that
Neeraj Bajiya (near-identical resume) inherits the same verdict.

**Compare with Samruddhi:** he should beat her on Next.js/TS/SQL depth; she beats him on
RAG/Python. If both pass, the tiebreaker is Q12/Q14 reasoning quality — that's the job.
