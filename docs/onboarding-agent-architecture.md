# Avise -- Onboarding & Firm Research Agent Architecture

## 1. User Flow: Signup to Dashboard

```mermaid
flowchart TD
    A[signup.html] -->|Account created| B[onboarding.html]
    B --> C{Welcome Screen}
    C -->|"Let's go" button| D[Checklist View]
    C -->|"Skip setup"| J[dashboard.html]

    D --> E["Task 1: Define Investment Focus\n(website, LinkedIn, fund size, sectors)"]
    E -->|Triggers enrichment| F["Task 2: Upload Your First Deal\n(CIM dropzone or sample deal)"]
    F --> G["Task 3: Invite Your Team\n(email + role rows, optional)"]
    G --> H[Completion Screen]

    H -->|"Open your deal"| I[deal.html?id=...]
    H -->|No deal uploaded| J

    subgraph Enrichment["Firm Research Agent (background)"]
        E1[POST /api/onboarding/enrich-firm]
        E1 --> E2[Agent runs 15-25s]
        E2 --> E3[Results shown on completion screen]
    end

    E -.->|Website/LinkedIn submitted| E1
```

**Key points:**
- New users land on `onboarding.html` after signup (dashboard.html checks onboarding status and redirects).
- Welcome screen is a 2-column layout: hero text on the left, checklist preview on the right.
- The 3-task checklist is sequential. Task 3 (Invite Team) is optional and can be skipped.
- Completion screen shows dynamic findings from the firm research agent (sectors, fund size, portfolio companies). If the agent is still running, it shows a "processing" state.
- Confetti animation plays on completion. User is redirected to their deal page or dashboard.
- Returning users who completed onboarding are never shown the flow again.

---

## 2. Firm Research Agent: LangGraph Pipeline

```mermaid
flowchart LR
    START(( )) --> scrape
    scrape --> searchFirm
    searchFirm --> searchPerson
    searchPerson --> synthesize
    synthesize --> verify
    verify --> save
    save --> END(( ))

    subgraph scrape["1. Scrape"]
        S1["Fetch homepage + 10 subpages\n(about, team, portfolio, strategy...)\nSSRF protection, 15s timeout\n20K char cap"]
    end

    subgraph searchFirm["2. Search Firm"]
        SF1["3 DuckDuckGo queries:\n- firmName private equity\n- firmName portfolio deals\n- firmName fund raise"]
    end

    subgraph searchPerson["3. Search Person"]
        SP1["LinkedIn slug extraction\nDDG: LinkedIn profile search\nDDG: person-firm co-occurrence"]
    end

    subgraph synthesize["4. Synthesize"]
        SY1["GPT-4o structured extraction\nZod schema validation\n8 strict accuracy rules"]
    end

    subgraph verify["5. Verify"]
        V1["Cross-validate portfolio cos\n(DDG co-occurrence)\nPerson-firm match check\nSector source backing\nSet confidence: high/medium/low"]
    end

    subgraph save["6. Save"]
        SV1["FirmProfile -> Organization.settings\nPersonProfile -> User.onboardingStatus\nAudit trail (last 5 runs)"]
    end
```

**Data flow through the pipeline:**

| State Field | Written By | Read By |
|---|---|---|
| `websiteText` | scrape | synthesize |
| `firmSearchResults` | searchFirm | synthesize, verify |
| `personSearchResults` | searchPerson | synthesize, verify |
| `firmProfile` | synthesize | verify, save |
| `personProfile` | synthesize | verify, save |
| `sources` | synthesize | save |
| `steps` | all nodes (append-only) | returned to caller |
| `status` | save | returned to caller |

---

## 3. System Integration: Where Enriched Data Flows

```mermaid
flowchart TB
    subgraph Onboarding["Onboarding Flow (apps/web/)"]
        ON1[onboarding.html]
        ON2[onboarding-flow.js]
        ON3[onboarding-tasks.js]
    end

    subgraph Agent["Firm Research Agent (apps/api/)"]
        AG1["POST /api/onboarding/enrich-firm"]
        AG2["firmResearchAgent/index.ts\nrunFirmResearch()"]
    end

    subgraph Storage["Supabase Storage"]
        DB1["Organization.settings JSONB\n(FirmProfile)"]
        DB2["User.onboardingStatus JSONB\n(PersonProfile)"]
    end

    subgraph Consumers["Data Consumers"]
        DC1["Deal Chat\n(system prompt injection:\nstrategy, sectors, check size,\nportfolio, investment criteria)"]
        DC2["Settings Page\n(Firm Profile section\nwith Refresh button)"]
        DC3["Completion Screen\n(dynamic findings display)"]
    end

    ON1 -->|User fills website + LinkedIn| AG1
    AG1 --> AG2
    AG2 --> DB1
    AG2 --> DB2

    DB1 --> DC1
    DB1 --> DC2
    DB1 --> DC3
    DB2 --> DC2
```

**Integration points:**

1. **Onboarding flow** -- Task 1 triggers enrichment when the user submits their website/LinkedIn URL. Results appear on the completion screen.
2. **Deal Chat** -- The firm profile is injected into the deal chat system prompt, giving the AI context about the firm's strategy, target sectors, check size, portfolio, and investment criteria. Users can ask "does this deal match our criteria?" and get informed answers.
3. **Settings page** -- A "Firm Profile" section displays the enriched data with a "Refresh" button that re-runs the agent.

---

## File Map

| Component | Files |
|---|---|
| Onboarding frontend | `apps/web/onboarding.html`, `apps/web/onboarding-flow.js`, `apps/web/onboarding-tasks.js` |
| Signup page | `apps/web/signup.html` |
| Agent entry point | `apps/api/src/services/agents/firmResearchAgent/index.ts` |
| Agent graph | `apps/api/src/services/agents/firmResearchAgent/graph.ts` |
| Agent state | `apps/api/src/services/agents/firmResearchAgent/state.ts` |
| Agent nodes | `apps/api/src/services/agents/firmResearchAgent/nodes/{scrape,searchFirm,searchPerson,synthesize,verify,save}.ts` |
| Web search util | `apps/api/src/services/webSearch.ts` |
| API route | Mounted under `/api/onboarding/` |
