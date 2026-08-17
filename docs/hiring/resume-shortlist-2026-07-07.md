# Resume Shortlist — Full-Stack + AI Engineer (32 IIT Bombay resumes, screened 2026-07-07)

Scored against `job-description-fullstack-ai-engineer.md`: Node/TypeScript, React/Next.js,
Postgres/Supabase, LLM APIs in production, agent frameworks, end-to-end shipping.

> **Update (2026-07-07): founder decision — bachelor's students only.** M.Tech candidates
> are out of scope. See the **B.Tech-only shortlist** section immediately below; the original
> full-pool ranking is kept underneath for reference.

---

## B.Tech-only shortlist (final)

Pool: 12 B.Tech/B.S. candidates (roll `22B*`) + 1 dual-degree edge case.

### Tier 1 — send take-home assignment

1. **Vikash Chahar — 22B3034, Economics B.S., CPI 7.51** ⭐ new top pick
   - Strongest JS/TS full-stack in the batch: React ERP dashboard internship (role-based
     access control, multilingual chatbot with intent detection, Ollama + Qwen), ShopSensei
     (React, TypeScript, Node, PostgreSQL, JWT/OAuth, Stripe), AI Finance Platform
     (Next.js, Prisma, Gemini, Clerk).
   - Watch-out: flagship self-projects are tutorial-derived and share bullet text with
     Neeraj Bajiya's resume. The take-home is the real test.

2. **Hansraj Mina — 22B2471, Metallurgy B.Tech, CPI 7.01**
   - ClearTax AI/ML intern — production chatbot work (NLU tuning, API integration,
     deployment, measurable CSAT lift) in a **fintech** domain. Cipla DS intern.
   - CrewAI + LangChain multi-agent project; React/Next.js (SSR, hooks) on E-Cell website;
     500+ LeetCode problems, contest rating 1635.

3. **Samruddhi Shinde — 22B1539, Energy B.Tech, CPI 7.23**
   - Node/Express + JWT + bcrypt backend with React frontend (food-delivery app);
     voice-enabled PDF chat in **React/TypeScript** with Gemini RAG pipeline; Flutter +
     Firebase budget tracker; KratiTech CV internship (YOLOv8, tracking).
   - Best genuine Node-backend signal among the bachelors.

### Tier 2 — phone-screen if Tier 1 disappoints

4. **veenus — 22B0704, Civil B.Tech, CPI 5.45**
   - ZeTheta internship: fintech platform deployed on AWS with **Supabase auth (1000+
     users)** and OpenRouter multi-LLM integration — the most on-stack internship in the
     bachelor pool. Biosky ML intern (DINO, autoencoders).
   - Risk: lowest CPI of all 32; rest of portfolio is CV/ML, not product.

5. **Sumit Adikari — 22B0615, Civil B.Tech, CPI 5.59**
   - NL→SQL LLM agent (Llama + DuckDB), ScrapeGraphAI + Playwright scraping platform,
     LangChain + ChromaDB RAG, QLoRA fine-tune of Llama 3.1 8B for a finance chatbot.
   - Strong applied-LLM tinkerer; no frontend, no TS, low CPI.

6. **Ujala Garhwal — 22B2501, Metallurgy B.Tech, CPI 5.98**
   - AI teaching assistant: RAG over PDFs/YouTube with LangChain + FAISS, Whisper STT,
     FastAPI–Streamlit; BERT fine-tuning; NoQs ML intern (Flask app deployed on AWS).
   - All Python; internship is the same cohort program as an M.Tech applicant's (identical
     project + metric), so treat it as coursework-grade.

7. **Rahul Kumar — 21D180034, Dual Degree (B.Tech+M.Tech), CPI 6.86** *(edge case —
   include only if "bachelor's" means the UG entry route rather than degree title)*
   - Built nanoGPT from scratch (transformer internals — rare depth in this pool); local
     RAG assistant; GPT-4 Vision video-annotation internship; prompt-optimization
     internship at ZeroCode.

### Not shortlisted (bachelor pool)

| Candidate | Roll | Reason |
|---|---|---|
| Neeraj Bajiya | 22B3026 | Projects duplicate Vikash Chahar's bullets verbatim; CPI 6.87 — interview the original |
| Ayush Salvi | 22B2503 | Analytics/consulting profile; CPI 5.84 |
| Sachin Yadav | 22B2222 | One local RAG chatbot; rest mech coursework |
| Rohan Badgujar | 22B2196 | Excellent controls/UAV engineer — wrong role |
| Devansh Nigam | 22B2173 | Mech course projects; no relevant stack |
| Simran Luha | 22B0334 | Finance/PM/marketing profile, not engineering |

### What you lose by dropping M.Techs
The two best document-extraction matches (Garima Jain, Saiteja Dubbas) were M.Techs.
Nobody in the B.Tech pool has shipped document/financial extraction. Compensate by making
the take-home (`assignment-financial-extraction-pipeline.md`) the primary filter and
weighting it over the resume.

---

## Original full-pool ranking (all 32, for reference)

**Batch-level caveat:** every candidate is a 2026-graduating IIT Bombay student (campus batch).
Nobody meets the "3+ years production TypeScript" bar — treat this pool as **intern / new-grad
founding-junior** hires, not the senior second-engineer the JD describes.

---

## Tier 1 — Interview (send take-home assignment)

### 1. Garima Jain — 24M0772, CSE M.Tech, CPI 9.0 ⭐ top pick
- **Best JD match in the pool.** Only CSE candidate; GATE CS AIR 82.
- Full-stack finance app: Next.js, Prisma, **Supabase**, Clerk, Gemini receipt-scan OCR.
- **Intuceo internship = document extraction** (invoice metadata/line-items via Pydantic
  schemas, embeddings-based template classification, LlamaExtract pipeline) — directly our
  financial-extraction problem.
- LLM research depth: RLHF alignment thesis, multilingual jailbreak benchmark (CS626),
  GNN retrieval for QA. Real systems coursework (xv6, multithreaded HTTP server in C).
- Gap: Python-leaning; Next.js project is tutorial-derived (see note below). Verify TS depth.

### 2. Vikash Chahar — 22B3034, Economics B.S.
- Strongest **JS/TS full-stack** signal: React ERP dashboard internship (role-based access,
  multilingual chatbot w/ intent detection, Ollama + Qwen), ShopSensei (React, TS, Node,
  PostgreSQL, JWT/OAuth, Stripe), AI Finance Platform (Next.js, Prisma, Gemini, Clerk).
- Gap: flagship self-projects are tutorial-derived (see note); CPI 7.51; econ background.
  Take-home will show whether he can build off-script.

### 3. Santhosh Kumar — 24M0010, Aero M.Tech, CPI 9.04
- Broadest **GenAI engineering** portfolio: RAG with hybrid search (BM25+vector) +
  re-ranking + caching; multimodal support agent with **function calling and multi-model
  routing across OpenAI/Claude/Gemini**; Whisper+diarization minutes pipeline with Notion/
  Jira/Slack integrations; Django e-commerce deployed on AWS; Django Channels realtime chat.
- Gap: Python/Django stack, not Node/React. Would need to convert; raw ability is clearly there.

### 4. Saiteja Dubbas — 24M0316, Geoinformatics M.Tech, CPI 8.77
- Two real **LLM-in-production internships**: DocRack AI (LangChain compliance agents for
  Aditya Birla, Llama-3 QLoRA fine-tuning, async FastAPI + Docker pipelines) and NoQs
  (Flask REST API, Azure, Docker + GitHub Actions CI/CD).
- Self-built MLOps CD pipeline with test gates. Gap: no React/TS; Python-only.

### 5. Hansraj Mina — 22B2471, Metallurgy B.Tech, CPI 7.01
- **ClearTax AI/ML intern** — production chatbot work (NLU tuning, API integration,
  deployment, measurable CSAT lift) — real LLM-in-prod signal, fintech domain.
- Cipla DS intern; CrewAI+LangChain+Ollama multi-agent travel planner; React/Next.js
  (SSR, hooks) on E-Cell website; 500+ LeetCode, contest rating 1635.
- Gap: web work is club-level; verify depth of the ClearTax contribution.

## Tier 2 — Backup / phone-screen if Tier 1 thins out

### 6. Samruddhi Shinde — 22B1539, Energy B.Tech, CPI 7.23
- Node/Express + JWT + React + MongoDB food-delivery app; voice PDF-chat in
  **React/TypeScript** + Gemini RAG; YOLO pose-analysis internship (KratiTech).
- Decent JS full-stack + RAG mix, but all self-project scale.

### 7. veenus — 22B0704, Civil B.Tech, CPI 5.45
- ZeTheta internship: fintech platform **deployed on AWS with Supabase auth for 1000+
  users**, OpenRouter multi-LLM integration — very on-stack. Biosky ML intern (DINO, autoencoders).
- Gap: lowest CPI in pool; projects otherwise CV-heavy; single-name resume needs ref check.

### 8. Sumit Adikari — 22B0615, Civil B.Tech, CPI 5.59
- NL→SQL LLM agent (Llama + DuckDB), ScrapeGraphAI+Playwright scraping platform,
  LangChain+ChromaDB RAG, **QLoRA fine-tune of Llama 3.1 8B** for a finance chatbot, STGCN research.
- Strong applied-LLM tinkerer; gap: low CPI, no frontend, no TS.

### 9. Anuj Yadav — 24M2012, SysCon M.Tech, CPI 8.08
- Widest agent-framework exposure: CrewAI + **GitHub MCP server**, AutoGen (5-agent
  research assistant, human-in-the-loop), Google ADK A2A, DSPy financial analyst (Flask).
- Gap: all self-projects, no internship, no React/TS, skills list is thin (no listed JS).

### 10. Rahul Kumar — 21D180034, Env Sci dual degree, CPI 6.86
- Built **nanoGPT from scratch** (transformer internals — rare depth signal in this pool),
  local RAG assistant, two AI internships (GPT-4 Vision video annotation; prompt-optimization
  pipelines at ZeroCode). FastAPI/Streamlit/AWS tooling.
- Gap: no React/Node; CPI modest.

## Not shortlisted (with reason)

| Candidate | Roll | Reason |
|---|---|---|
| Sanku Venkatesh | 24M2002 | Robotics/CV (ROS, Gazebo); no web, no LLM |
| Shivanshi Dubey | 24M1876 | Corrosion ML + one Ollama RAG app; no SWE stack |
| Vijay Kumar Shah | 24M1850 | Thin-film materials; "Basic C, Python" — no overlap |
| Nenavath Manipal Naik | 24M1648 | Combustion CFD; no programming beyond MATLAB |
| Prakash Kumar Behera | 24M1647 | CFD/thermal (CPI 9.21 but zero stack overlap) |
| Om Prakash Patel | 24M1644 | ML-for-heat-transfer + Coursera RAG; weak SWE signal |
| Ranjeet Singh | 24M1628 | Udemy-cert-level ML; no dev experience |
| Rahul K. Vishwakarma | 24M1522 | OR/MILP optimization; no web/LLM |
| Abhishek Kumar | 24M1363 | Energy systems; Python is a cert, not practice |
| Avinash Kumar Singh | 24M0606 | One LangChain RAG project; rest geospatial analytics |
| Sakshi Hulawale | 24M0573 | Solid ML/forecasting but zero web/LLM-app work |
| Ishrat Jan | 24M0321 | Strong CV/ViT research; no product engineering |
| Utsav Saraswat | 24M0206 | Good full-stack-ML breadth (Flask, Docker, AWS) but no LLM/JS depth — borderline |
| Shivendraraj Godbole | 24M0051 | Aero design + basic ML; Tata Tech was CAD work |
| Manish Lakhode | 24M0040 | Data-analytics self-projects only |
| Rohan Badgujar | 22B2196 | Impressive controls/UAV engineer — wrong role |
| Devansh Nigam | 22B2173 | Mech course projects; no relevant stack |
| Sachin Yadav | 22B2222 | One local RAG chatbot; rest mech/ML coursework |
| Neeraj Bajiya | 22B3026 | Projects near-duplicate Vikash Chahar's (same tutorials, same bullets); CPI 6.87 — take the original |
| Ayush Salvi | 22B2503 | Analytics/consulting profile; CPI 5.84 |
| Ujala Garhwal | 22B2501 | Decent RAG + Flask/AWS but CPI 5.98 and thinner than Tier 2 — borderline |
| Simran Luha | 22B0334 | Finance/PM/marketing profile, not engineering |

---

## Flags noticed during screening

1. **Tutorial-clone projects are rampant.** The "AI Finance Platform" (Next.js + Prisma +
   Clerk + Arcjet + Gemini receipt scanning) appears nearly verbatim on Garima Jain's,
   Vikash Chahar's, and Neeraj Bajiya's resumes — it's a well-known YouTube build-along.
   Same for "Cartoon Face Generator" and "SmartCart/ShopSensei" (Chahar vs. Bajiya share
   bullet text). The NoQs "Auto Image Caption Generator" internship appears on both Saiteja
   Dubbas's and Ujala Garhwal's resumes with the identical BLEU score — cohort program, not
   individual work. **The take-home assignment is therefore the real filter** — it can't be
   completed by following a tutorial.
2. **Seniority mismatch with the JD.** If you need the "3+ yrs production TS" second
   engineer, this campus pool doesn't supply it; these are strong intern/junior candidates.
3. Recommended next step: send `assignment-financial-extraction-pipeline.md` to Tier 1
   (it matches Garima's and Saiteja's document-extraction background — you'll get real signal),
   and `assignment-lead-scraping-pipeline.md` to Tier 2 if you want a second funnel.
