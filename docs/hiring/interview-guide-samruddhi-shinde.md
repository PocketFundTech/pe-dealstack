# Interview Script — Samruddhi Shinde (22B1539)

**Role:** Full-Stack + AI Engineer (junior) · Format: Q&A, easy → medium → hard
**Her anchors:** Node/Express + JWT food-delivery app (MongoDB), React/TS voice PDF-chat
with Gemini RAG, KratiTech CV internship, Flutter budget tracker.
**Known gaps:** never used Postgres/SQL in a project; no agent frameworks; all solo-scale work.

---

## Part 0 — Introduction (5 min, no grading)

**Q0.1 — "Tell me about yourself and the project you're most proud of. Why that one?"**
Listen for: picks a project she built herself and explains *why* it was hard (not just what
it does). Energy and ownership matter more than the specific project.
🚩 Describes projects in resume-bullet language with no personal detail.

**Q0.2 — "What do you know about what we're building?"**
Listen for: did any homework at all (AI for PE/M&A deal teams, document-heavy).
Great: asks a question back about the product.

---

## Part 1 — EASY: generic + project level (10 min)

**Q1 — "In your food-delivery app, what happens step by step when a user logs in?"**
✅ Expected: Server looks up user → bcrypt compares password against stored hash → issues a
signed JWT → client stores it and sends it on every request in the Authorization header →
Express middleware verifies the token and attaches the user.
⭐ Bonus: mentions salt rounds, token expiry, httpOnly cookie vs localStorage.
🚩 "The password is checked in the database" (i.e., stored plaintext) or thinks JWT is encrypted.

**Q2 — "Why do we hash passwords with bcrypt instead of just storing them or using plain SHA-256?"**
✅ Expected: If the DB leaks, plaintext passwords are exposed; bcrypt is slow on purpose and
salted, so rainbow-table and brute-force attacks are expensive. SHA-256 is fast — bad for passwords.
🚩 Can't explain what a salt is even after a hint.

**Q3 — "What's the difference between GET, POST, PUT, DELETE — and where did you use them in your API?"**
✅ Expected: Read / create / update / delete, mapped to her own endpoints (menu fetch, add
to cart, place order). Knows status codes basics (200/201/400/401/404/500).
🚩 Only ever wrote POST for everything.

**Q4 — "In your PDF chatbot, explain in simple words: what is RAG and why did you need it?"**
✅ Expected: The model can't hold/see the whole PDF (context limits, cost), so we split the
doc into chunks, convert chunks to embeddings (vectors capturing meaning), store them, find
the chunks most similar to the question, and give only those to Gemini with the question.
⭐ Bonus: mentions chunk overlap and why.
🚩 "Gemini just reads the PDF" — the tutorial did the thinking.

**Q5 — "Which Python data structure would you use to count orders per restaurant from a list of orders? Show me."**
✅ Expected: dict / defaultdict / Counter, written fluently in a few lines.
🚩 Hesitates on basic dict operations.

---

## Part 2 — MEDIUM: applied, our-stack adjacent (20 min)

**Q6 — "You used Context API + useReducer for your cart. Why not useState? And when does Context become a problem?"**
✅ Expected: Cart is shared across many components (prop drilling); reducer centralizes
add/remove/update logic with predictable transitions.
⭐ Great: knows every consumer re-renders when context value changes → split contexts or
memoize; distinguishes client state from server state (React Query/SWR).
🚩 "It was recommended" with no trade-off reasoning.

**Q7 — SQL modeling (live, we use Postgres, she used Mongo). "Model our domain: firms have deals, deals have documents, contacts can be on many deals. Sketch tables, then write the query to fetch all contacts on a deal."**
✅ Expected: `firms`, `deals(firm_id)`, `documents(deal_id)`, `contacts`, and a join table
`deal_contacts(deal_id, contact_id)` — spots the many-to-many. Writes a working 2-JOIN query.
⭐ Great: adds org_id/tenancy on every table, unique constraint on the join pair, indexes on FKs.
🚩 Embeds contacts as an array inside deals (Mongo habit), can't write a JOIN.

**Q8 — "A user uploads a 200-page PDF to your chat app and the browser freezes. What's happening and how do you fix it?"**
✅ Expected: Parsing on the main thread blocks the UI → move extraction server-side (or a
web worker), process in chunks, show progress.
⭐ Great: payload limits, background job + status polling, why server-side is right for a
multi-user product.
🚩 "Show a spinner" (doesn't identify blocking as the cause).

**Q9 — "Your KratiTech tracking system — what data structures held the state? How did you handle a person leaving and re-entering the frame?"**
(Resume-inflation detector — she must go deeper than the bullet.)
✅ Expected: Concrete internals — dict keyed by track ID with centroid/joint-angle history,
some state machine for loitering vs dumping, track-loss timeout and re-ID handling.
🚩 Repeats "BoT-SORT and MediaPipe" but can't describe one data structure or edge case.

**Q10 — "In your RAG pipeline: how did you pick chunk size, and what goes wrong when retrieval returns the wrong chunks?"**
✅ Expected: Honest trial-and-error on chunk size; knows failure modes — answer spans two
chunks, tables get mangled, irrelevant chunks mislead the model.
⭐ Great: top-k tuning, metadata filtering, re-ranking, citing sources so users can verify.
🚩 Never evaluated retrieval quality at all and can't name one failure mode.

**Q11 — Python hygiene. "You're starting a real Python service others will run. How do you set up environments, dependencies, and validation of incoming data?"**
✅ Expected: venv/conda + pinned requirements, basic debugging beyond print.
⭐ Great: type hints + Pydantic for validating structured data (directly our extraction
stack), pytest habit.
🚩 Colab-only workflow, no concept of reproducibility.

---

## Part 3 — HARD: production & design, our product (20 min)

**Q12 — The money question. "We extract financials from deal documents (CIMs, Excel) and the numbers MUST be right — but LLMs hallucinate. Design an extraction pipeline we can trust."**
✅ Expected: Structured output (JSON schema / function calling), a validation layer,
cross-checks (line items sum to totals, YoY sanity), low-confidence fields flagged for
human review instead of silently guessed.
⭐ Great: grounding — store source page/cell next to every number so a human can verify in
one click; eval set of labeled documents to measure accuracy over time; temperature 0;
"the model proposes, the system verifies."
🚩 "Better prompt / better model" as the entire answer.

**Q13 — "What's the difference between your RAG chatbot and an agent? When would you give the model tools instead of just context?"**
✅ Expected: RAG = retrieve-then-answer, one shot. Agent = loop where the model chooses
actions (query DB, call API, search), observes results, iterates. Tools when you need live
data or side effects.
⭐ Great: agent failure modes — infinite loops, compounding errors, cost — so you constrain
tools, add stop conditions, human-in-the-loop for risky actions.
🚩 Thinks an agent is a chatbot with a personality prompt.

**Q14 — Collaborative design. "Design 'deal Q&A': user asks *what was 2023 EBITDA for this deal?* and the system answers from that deal's uploaded documents. Whiteboard the flow with me."**
✅ Expected: Retrieval scoped to that deal's documents only; embeddings + vector search;
answer with citation; if the answer isn't present, say so — never guess.
⭐ Great: financials already extracted into a structured table should be queried directly
(don't re-read the PDF every question); mentions access control / tenant isolation; asks
"what if two documents disagree?" — that question alone is a strong hire signal.
🚩 No document scoping (would leak other deals' data), no citation, no "I don't know" path.

**Q15 — "Next.js dashboard takes 3 seconds before anything renders. Walk me through your debugging process — process first, fixes second."**
✅ Expected: Measure before fixing — network tab: is it one slow API, a sequential fetch
waterfall, huge payload, or blocking render? Then: parallelize, paginate, cache.
⭐ Great: server-side fetching / server components, streaming + Suspense, skeletons,
moving heavy work off the request path.
🚩 Random fixes with no diagnosis.

**Q16 — "Tell me about a time an AI coding tool (Copilot/Cursor/ChatGPT/Claude) gave you wrong code. How did you catch it?"**
✅ Expected: A concrete story — hallucinated API, subtle logic bug — caught by reading,
testing, or docs. Shows she reviews AI output.
🚩 "It's never wrong" or "I don't use them" (JD requires daily AI-tool fluency).

---

## Scoring

| Area | 1 (no-hire) | 3 (bar) | 5 (strong) | Score |
|---|---|---|---|---|
| Own-project depth (Q1, Q9, Q10) | Bullet-level recall | Explains internals | Teaches you something | |
| Full-stack fundamentals (Q1–Q3, Q6) | Gaps in basics | Solid + trade-offs | Production instincts | |
| SQL modeling (Q7) | Can't model M:N | Tables + JOIN correct | Tenancy, constraints, indexes | |
| Python (Q5, Q11) | Hesitant | Fluent | Pydantic/typing/test instincts | |
| AI reasoning (Q4, Q12–Q14) | Buzzwords | Understands limits | Verification-first design | |
| AI-tool fluency (Q16) | None/blind trust | Daily + reviews | Sharp failure story | |

**Decision guide:** The easy tier catches fundamentals gaps; the medium tier catches resume
inflation (Q7, Q9, Q10 especially); the hard tier is where the hire decision lives — Q12 and
Q14 mirror the real product. Don't penalize for not knowing LangGraph/Supabase/Postgres by
name — those are learnable in weeks. Penalize for bluffing, and reward "I don't know, but
here's how I'd figure it out."
