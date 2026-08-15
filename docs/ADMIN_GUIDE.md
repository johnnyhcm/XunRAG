# XunRAG System Administrator Guide (English)

> Version: 1.0 (open source)
> Audience: IT staff and policy library administrators responsible for deploying, configuring and operating the system
> Companion docs: `README.md` (installation), `USER_GUIDE.md` (end-user manual)
> For first-time deployment, follow Chapter 4 "Initial Configuration" in order; for daily operations, use the chapter index.
>
> **Terminology note**: All UI terms in this guide match the English interface of the system exactly (e.g. "Q&A Configuration", "Efficient mode", "AI searchable").

---

## Table of Contents

1. [System Design Philosophy (read first)](#1-system-design-philosophy-read-first)
2. [Architecture & Requirements](#2-architecture--requirements)
3. [Installation & Deployment](#3-installation--deployment)
4. [Initial Configuration (8 steps)](#4-initial-configuration-8-steps)
5. [Policy Management Guide](#5-policy-management-guide)
6. [Users & Permissions Guide](#6-users--permissions-guide)
7. [Model Connection Guide](#7-model-connection-guide)
8. [Q&A Configuration Reference](#8-qa-configuration-reference)
9. [Q&A Routing](#9-qa-routing)
10. [Security Settings](#10-security-settings)
11. [Statistics & Logs](#11-statistics--logs)
12. [Backup & Restore](#12-backup--restore)
13. [Monitoring & Troubleshooting](#13-monitoring--troubleshooting)
14. [Security Hardening Checklist](#14-security-hardening-checklist)
15. [Appendix: Environment Variables & Glossary](#15-appendix-environment-variables--glossary)

---

## 1. System Design Philosophy (read first)

> Why design philosophy first? Because **every configuration in this system revolves around one core pipeline**. Without understanding the pipeline, you won't know "what to change and why". This chapter is the map for all subsequent chapters.

### 1.1 The Core Business Pipeline

```
Policy Governance → Retrieval → Generation → Action
```

| Stage | What it does | Quality depends on | Where admins operate |
|---|---|---|---|
| Policy Governance | Ingest policies (format/slicing/security level/versioning) | **Slicing quality** | Policy Management (Ch. 5) |
| Retrieval | Find the most relevant policy clauses | **Retrieval parameters** | Q&A Configuration → Retrieve (Ch. 8) |
| Generation | Compose trustworthy answers from retrieved evidence | **Prompts** | Q&A Configuration → Generate (Ch. 8) |
| Action | Push process links / contacts / risk alerts | **Routing data** | Q&A Routing (Ch. 9) |

**In one sentence**: governance decides "is there good material", retrieval decides "is it found accurately", generation decides "is the answer trustworthy", routing decides "does it close the loop to action". The four stages are chained — **quality in an earlier stage amplifies or dilutes the effect of later stages**. This is why the system insists on "govern first, then ingest".

### 1.2 The Two-Mode Architecture (understand the different tuning approaches)

The system offers two Q&A modes with **fundamentally different tuning approaches**:

| Dimension | Efficient mode (default) | Smart mode |
|---|---|---|
| Orchestration | **Workflow**: fixed steps, code-controlled | **Agentic**: AI plans its own steps, constrained only by prompts |
| Framework | LangGraph.js | Pi SDK |
| Retrieval | Vector RAG (BM25 lexical + vector semantic + rerank) | Full-text lexical search (grep style) |
| Retrieval unit | Chunks | Full text / chunks |
| Answer style | Fast, stable, cost-efficient | Deep, thorough, multi-step reasoning |
| **How to tune** | **Tune parameters** (retrieval params, timeouts, Top-K) | **Tune prompts** (system prompt, tool description) |

**Efficient mode internal pipeline** (know where each "Retrieve" config acts):

```
User question
  → [1 Understand] Intent recognition (LLM): split multi-intents, detect missing info, detect human-handoff
  → [2 Retrieve] Parallel retrieval: BM25 lexical + vector semantic → RRF fusion → rerank
              → applicability weighting (applicable rules) → language weighting → dedup
  → [3 Organize] Assemble context (Top-K chunks + user profile) → LLM streaming generation → citations
  → [4 After answering] Process link card / contact card / risk alert
```

**Smart mode pipeline**:
```
User question → Agent plans → calls policy_grep tool (retrieves on demand, multiple times)
  → judges sufficiency → synthesizes → streaming answer (cites source sections)
```

> **Mode selection advice**: use Efficient mode for daily high-frequency simple queries (fast, stable, cheap); use Smart mode for complex cross-clause questions requiring reasoning. Both can coexist; employees switch manually.

### 1.3 Dual Storage Architecture (know where data lives)

| Storage | Content | Location |
|---|---|---|
| SQLite (metadata) | Users / libraries / lines / versions / chunks / configs / conversations | `data/policybot.db` |
| Chroma (vectors) | Policy chunk vectors + BM25 index | `data/vector-db/` |

- On startup the system runs an **index consistency check** (compares effective versions in SQLite against Chroma vectors, cleans orphans) — normally no manual intervention needed.
- ⚠️ **Backups must cover both stores** (the backup script in Ch. 12 already does); if manually clearing data, clear both.

### 1.4 Three-Layer Permission Model

| Layer | Model | Controls | Configured in |
|---|---|---|---|
| Functional permission | RBAC roles | Who can use which admin functions (user mgmt / config / policy mgmt…) | Roles & Permissions (6.2) |
| Data permission | ABAC attribute rules | Who can **see** which policies (Visibility); which policies AI prioritizes (Applicability) | Library/file editing (6.3/6.4) |
| Security level | Levels + behavior policy | Protection per level (watermark/copy protection/AI searchable/audit) | Security Settings (Ch. 10) |

---

## 2. Architecture & Requirements

### 2.1 Processes & Ports

| Process | Tech | Default port | Role |
|---|---|---|---|
| backend | Node.js (Express + TS) | 3000 | Business orchestration (auth/policy/Q&A/config/stats) |
| python | Python (FastAPI) | 8001 | Search engine (convert/embed/retrieve/rerank) |
| frontend | Vite (React dev server) | 5173 | Dev only; production served via NSSM |

### 2.2 Data Directories

```
data/
├── policybot.db      # SQLite main DB
├── vector-db/        # Chroma vector store
├── uploads/          # Original policy files archive
├── certs/            # HTTPS certificates
├── logs/             # Logs (chat/audit/app/alerts)
├── backup/           # Automated backups
└── pi-sessions/      # Smart mode session memory
```

### 2.3 Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | Backend runtime |
| Python | ≥ 3.12 | Search engine |
| pandoc | ≥ 3.0 | Word conversion (via pypandoc) |
| GPU (optional) | 8GB VRAM+ | Local model inference (tested: RTX 5070 8G runs 9B smoothly); CPU works without GPU |

**Model files** (required before first use; download with `python tools/download_models.py`):
- `bge-m3` embedding model → `models/embedding/bge-m3/`
- `bge-reranker-v2-m3` reranker → `models/reranker/bge-reranker-v2-m3/`
- Local LLM (optional) → `models/llm/<name>/` (GGUF files)

---

## 3. Installation & Deployment

### 3.1 Development Mode (quick verification, ~10 min)

```bash
npm install                      # install dependencies
pip install -r requirements.txt  # Python dependencies

# Terminal 1: search engine
python app/python/server.py      # listens on 8001

# Terminal 2: backend + frontend
npm run dev                      # backend 3000 + frontend 5173
```

Open **`https://localhost:5173`** in a browser (note: https; for the self-signed certificate click "Advanced → Proceed").
Login: Employee No. `A001`, initial password `Pass1234` (forced password change on first login).

> ⚠️ **Development-mode warning**: this mode is for quick verification only — **no NSSM process guard (a dead process is not restarted) and no automatic backup**. For real use, follow Section 3.2 for production deployment.

**Verification**: after login → Policy Management → create a library → upload a policy → publish → back to home → ask a question about that policy → you should get an answer with citations.

### 3.2 Production Mode (Windows services)

```bash
npm run build                                   # build artifacts
node scripts/gen-cert.mjs                       # generate HTTPS certificate (replace with real cert for production)
powershell -ExecutionPolicy Bypass -File scripts\install-services.ps1      # register NSSM services (admin)
powershell -ExecutionPolicy Bypass -File scripts\register-schedules.ps1    # register scheduled tasks (health/backup/monitor)
```

**NSSM services** (auto-restart on crash + start on boot):
- `policybot-backend` (port 3000)
- `policybot-python` (port 8001)

**Production environment variables (mandatory)** — see Appendix for the full table:
- `POLICYBOT_MASTER_KEY` (encryption key, 32-byte hex)
- `POLICYBOT_INITIAL_PASSWORD` (override the default initial password)
- `HTTPS_ENABLED=1` + `HTTPS_CERT` / `HTTPS_KEY` (real certificates)
- `BIND_HOST=0.0.0.0` (only if LAN access is needed)

> ⚠️ **Dev vs production differences** (known pitfalls): production runs `node dist/main.js`; resource paths resolve from the project root. NSSM services run under a system account, so the secrets directory must be pointed to explicitly via `POLICYBOT_SECRETS_DIR` (default is `~/.policybot-secrets/` in the user profile).

### 3.3 LAN Access

1. Open the firewall: run `scripts\firewall-open.bat` as admin (opens 5173/3000/8001)
2. Clients access: `https://<server-IP>:<port>`
3. Production recommendation: use a real certificate (avoid manual trust on every client); or deploy an internal enterprise CA.

---

## 4. Initial Configuration (8 steps)

> **Why the order matters**: each step's output is the prerequisite of the next — model first to verify Q&A; policy first to verify permissions; users first to verify visibility. **Following the order avoids rework.**

### Step 1: Log in and change the password

- Entry: open the system in a browser → login page
- Steps: Employee No. `A001` / initial password `Pass1234` → forced password change → set a new password (≥8 chars, upper + lower case + digits)
- Verify: log in again with the new password

### Step 2: Configure Model Connection (Q&A cannot work without a model)

- Entry: top nav "System Configuration" → "Model Connection" (or `/console/config/model`)
- Choose one:
  - **Cloud API** (recommended to start): select "Cloud API" → provider `DeepSeek` (or others) → paste API Key → click "Refresh models" → confirm the model appears → select a model (e.g. `deepseek-v4-flash`)
  - **Local model**: select "Local model" → enter model file path (GGUF) → adjust parameters per GPU (7.3) → save
- Verify: the **AI status light** at the top should turn green (cloud = provider/model/key configured; local = model loaded)
- Common issues: Key shows "not configured" — confirm it was saved (after switching provider, the old key is not reused, re-enter); local model loading takes 30–60 s

### Step 3: Create a policy library and upload policies

- Entry: top nav "Policy Management" (`/admin`)
- Steps:
  1. Click "New" (create library) → enter Name (required), Description (optional) → **visibility/applicability can be configured later (Step 6)** → create
  2. Enter the library → click upload → select a Word (.docx) or Markdown file
- Verify: the file appears in the list; conversion status changes from converting to preview

### Step 4: Confirm slicing and publish

- Entry: Policy Management → the file → slice preview
- Steps:
  1. **Review the auto-slicing**: the system has split the policy into chunks by headings; verify section assignment
  2. **Adjust slices**: drag boundaries / merge / split; mark irrelevant paragraphs (cover/TOC/headers) as not-indexed
  3. Confirm → click publish → set the effective date (today by default; a future date = pending)
- Verify: the policy is visible under "Policy" in the employee view; ask a question at home → retrievable
- **Why this matters**: a chunk is the smallest retrieval unit — too fragmented = incomplete context; too coarse = imprecise hits. **Governance quality directly determines Q&A quality** (the pipeline in Ch. 1)

### Step 5: Create users

- Entry: top nav "System Configuration" → "User Management" (`/console/users`)
- Choose one:
  - **Single creation**: "New" → Employee No. (required), Name (required), Email, Department, Region, Contract type, Level, Position → save (initial password Pass1234, forced change on first login)
  - **CSV batch import**: download the template → fill columns (Employee No./Name/Email/Department/Region/Contract type/Level/Position/Status) → upload → review the import report (values not in the dictionary are blanked and flagged)
- Verify: new users appear; log in as one of them
- **Tip**: user attributes (Department/Region/Contract type) are the data source for permission rules (Step 6) — **the more accurate the attributes, the more accurate permissions and personalization**

### Step 6: Configure permissions (core step)

**6a. Configure roles (functional permission — who can manage what)**
- Entry: "System Configuration" → "Roles & Permissions" (`/console/groups`)
- Steps: create a role → check functions (Policy Management / User Management / Config Management / Statistics…) → check managed scope (libraries) → add members (manual, or dynamic rules matching attributes automatically)
- Verify: log in as a member → only authorized admin functions are visible

**6b. Configure visibility (data permission — what employees can see)**
- Entry: Policy Management → library → "Edit" → visibility conditions
- Steps: set library-level visibility rules (e.g. Department = HR OR Region = Mainland), supporting AND/OR combinations
- Verify: log in as a regular employee → unauthorized policies are invisible (list/search/direct URL all blocked — "as if they don't exist")

**6c. Configure applicability (what AI prioritizes — optional but recommended)**
- Entry: same as above, edit library/file → applicability
- Explanation: applicability differs from visibility (see 6.4) — **a policy can be visible but not prioritized by AI** (e.g. US branch policies are visible to China HR, but not prioritized when answering Chinese employees' leave questions)
- Verify: ask the same question as users from different regions → answers cite different policies

### Step 7: Configure Q&A routing (optional)

- Entry: "System Configuration" → "Q&A Routing" (`/console/config/routes`)
- Steps:
  - "Topics": confirm/adjust the 6 built-in topics (Leave/Attendance/Travel/Expense/Expat/Other) — names, keywords, scope
  - "Processes": add processes (e.g. Leave → OA application URL)
  - "Routes": configure contact persons per topic (select a user, optionally a region)
- Verify: ask "I want to take leave" → a process link card appears at the end of the answer; reply "transfer to human" → a contact card appears

### Step 8: End-to-end verification

Using an employee account, check:
- [ ] Login, home suggestions, both modes selectable
- [ ] A question retrieves relevant policies from the department; citations clickable to the source
- [ ] An irrelevant question → rejected ("Not found in the policy library.")
- [ ] Unauthorized policies invisible (including search)
- [ ] Replying "transfer to human" → contact card
- [ ] Reading policy full text → watermark shown (default on)

---

## 5. Policy Management Guide

> Entry: top nav "Policy Management" (`/admin`). This page is the main hub for the policy lifecycle.

### 5.1 Policy Library Management

**Create a library** — click "New":

| Field | Description | Advice |
|---|---|---|
| Name | Required, e.g. "Attendance & Leave Policies" | Name by business topic for easy browsing |
| Description | Optional | One-line scope description |
| Library visibility | Empty = visible to all; otherwise only users matching rules see it | See 6.3 |
| Library applicability | Empty = applies to all; otherwise AI prioritizes applicable policies | See 6.4 |

**Library actions**: Disable (all files in the library become unsearchable/unreadable), Edit attributes, Delete (empty libraries only).

### 5.2 Upload & Conversion

- Supported formats: **Word (.docx) and Markdown (.md)** — PDF is not supported (governance philosophy in 1.1: if the Word original cannot be found, governance is not done yet)
- After upload the system automatically:
  - Converts Word → Markdown (pandoc), extracts images
  - Detects language, marks cover/TOC/headers/footers
  - Marks conversion quality: `ok` / `need_review` (e.g. documents without heading styles)
- **Common conversion results**:
  - Heading recognition: built-in heading styles → auto levels; no heading styles → heuristic inference ("Chapter/Article/一、" patterns); still no headings → marked `need_review`
  - Tables: simple tables → Markdown pipe tables; complex tables (merged cells) → "field: value" text lines; bilingual text preserved

### 5.3 Slicing (core governance action — always confirm manually)

| Action | Entry | Description |
|---|---|---|
| View slices | File → slice preview | See each chunk's content and section assignment |
| Adjust slices | Slice preview page | Drag boundaries, merge/split; mark paragraphs "not indexed" (visible in the original only) |
| Heading handling | Slice preview page | Headings merge into their chunk by default (so heading words are searchable); split manually to make a heading its own chunk |

**Slicing quality criteria**: a chunk should be a complete "clause/section" — enough context (condition + conclusion) without excessive redundancy.

### 5.4 Publishing & Version Management

| Action | Description | Effective rule |
|---|---|---|
| Publish | Set effective date | A future date = pending (auto-switches on the effective date, no manual action) |
| Edit version | Modify effective date etc. | Some fields locked once published |
| Retire version | Stop using | No longer retrieved by AI nor readable by employees |
| Delete | Draft/unpublished only; published cannot be deleted | Retire first |
| Disable library | Library-level switch | All files in the library become unsearchable/unreadable |

**Effective-version logic**: a policy line may have multiple versions; the system determines the "current effective version" by effective dates — **AI retrieval only uses the current version; employees only read the current version**. Publishing a new version automatically closes the previous version's effective range.

**All actions are logged** (audit log, see 11.2).

### 5.5 Security Level Assignment

- Every policy **must have a security level** (security baseline)
- Levels and behavior policies are configured in "Security Settings" (Ch. 10)
- Key mechanism: for levels with `AI searchable = off` — **humans can read, AI never cites** (prevents AI from leaking confidential content)

---

## 6. Users & Permissions Guide

### 6.1 User Management

> Entry: "System Configuration" → "User Management" (`/console/users`)

**Single creation**: New → Employee No. (required) + Name (required) + Email + attribute fields → save.
**CSV batch import**:
1. Download the template (columns: Employee No./Name/Email/Department/Region/Contract type/Level/Position/Status)
2. Fill it (option values must match the "User Attributes" dictionary, otherwise the column is blanked and reported)
3. Upload → review the import report (created/skipped/blanked details)
4. Imported users get initial password `Pass1234` + forced change on first login

**Other actions**: Reset password (to initial, inform offline), Disable/Enable (a disabled user immediately loses all access), Edit attributes.

### 6.2 Roles & Permissions (RBAC — functional permission)

> Entry: "System Configuration" → "Roles & Permissions" (`/console/groups`)

**A role = members + functions + managed scope** (union across roles):

| Dimension | How to configure | Description |
|---|---|---|
| Members | Manual + dynamic rules | Dynamic rules match user attributes automatically (effective immediately on hire/transfer/leave) |
| Functions | Checkboxes | Policy Management / User Management / Role Management / Config Management / Statistics / Library Global Management |
| Managed scope | Check libraries | Libraries this role can manage (or All libraries) |

**Built-in roles**:
- **System admin group**: all functions + all libraries (security red line — manual members only, excluded from dynamic rules)
- **Employee group**: query function only (default for everyone)

**Dynamic rule syntax** (automatic member matching):
- Conditions within the same rule group = AND (all must match)
- Different rule groups = OR (any one matches)
- Operators: `in` (includes) / `not_in` (excludes)
- Example: `Region ∈ [Beijing, Shanghai] AND Department = HR` → matching members join automatically

### 6.3 Visibility (ABAC — data permission)

> **Controls "who can see"**. Two levels:
> Library-level visibility conditions (empty = visible to all) → file-level inherits or narrows the library (**never exceeds the library**)

- Where: Policy Management → edit library/file → visibility
- Rule form: `field ∈ value` combinations (AND/OR); fields come from user attributes (Department/Region/Contract type/Level/Position…)
- **Dynamic**: attribute changes take effect immediately (no re-login)
- **Anti-probing**: unauthorized content "does not exist" — hidden from lists, not hit by search, 403 on direct URL

**Example** (attendance library):
```
Library visibility: Department = HR OR Contract type = Regular
  └─ Shenzhen attendance rules (file): Region = Shenzhen AND Contract type = Regular   ← narrowed within the library
```

### 6.4 Applicability (the difference from visibility — commonly confused)

| | Visibility | Applicability |
|---|---|---|
| Meaning | **Who can see** | **Whose policies AI prioritizes** |
| Mechanism | Hard filter (not matching = invisible) | Soft ranking (not matching = deprioritized, not hidden) |
| Scenario | Data security boundary | Answer accuracy |

**Example**: China HR can view US branch policies (visible), but when she asks "how many days of leave can I take", AI does not prioritize US policies (not applicable) — it prioritizes policies applicable to her region. **Advice**: for policies spanning regions/departments, configure applicability so AI selects accurately.

**Where**: Policy Management → edit library/file → applicability (same rule form as visibility; file-level inherits library-level).

### 6.5 User Attribute Dictionary

> Entry: "System Configuration" → "User Attributes" (`/console/config/fields`)

Manages the attribute fields users can edit (**data source for permission rules and personalized answers**):

| Setting | Description |
|---|---|
| Field type | Option (single) / Multi / Text |
| Required | Validated on create/import |
| Inject into Q&A context | Whether used for personalized answers (built-in core fields on by default; reserved fields off) |
| Option maintenance | Value/label separation (value stable for matching; label editable and multilingual) |

Built-in core fields: Department, Region, Contract type, Level, Position (cannot be disabled/deleted). 10 reserved custom fields (custom_1~10) can be enabled per organization needs.

---

## 7. Model Connection Guide

> Entry: "System Configuration" → "Model Connection" (`/console/config/model`)
> The **AI status light** at the top (10-second polling): cloud = provider/model/key status; local = model/engine/VRAM.

### 7.1 Choose the Access Mode

| Mode | Data flow | Scenario |
|---|---|---|
| Cloud API | Questions + policy content sent to an external LLM service | Best quality, no strict data-egress restrictions |
| Local model | All inference on-premises, **data never leaves the intranet** | Strict compliance (finance/government) |

> Switching: one-click Segmented control at the top (saved immediately); switching does not clear configured API Keys.

### 7.2 Cloud API Configuration Steps

1. Access mode → "Cloud API"
2. Provider: `DeepSeek` (recommended) / `OpenAI` / `Anthropic` / `Custom` (OpenAI-compatible endpoint)
3. API Key: paste and save (**AES-256-GCM encrypted storage**, plaintext never persisted; stored per provider, no re-entry when switching providers)
4. Model: click "Refresh models" → select (e.g. `deepseek-v4-flash`)
5. Click "Test connection" to verify
6. Verify: the status light turns green

**Key security**: keys are encrypted at `~/.policybot-secrets/llm.key.<provider>.enc`; the encryption key comes from the `POLICYBOT_MASTER_KEY` environment variable (mandatory in production). **After changing provider without entering a new key, the old key is invalidated** (prevents accidental reuse).

### 7.3 Local Model Configuration Steps

1. Download a GGUF model → put it in `models/llm/<name>/`
2. Access mode → "Local model" → enter the model file path
3. Adjust parameters per GPU:

| Parameter | Default | Advice |
|---|---|---|
| Context length | 16384 | ≤16K for 8GB VRAM; raise with more VRAM |
| KV quantization | On | Saves VRAM; off for large VRAM (slightly better precision) |
| GPU layers | 40 | -1=all GPU / 0=CPU / N=first N layers; must be explicit on Windows |
| Thinking mode | Off | Local 9B thinking costs more than it helps; keep off |
| Concurrency | 2 | Concurrent requests (queue beyond); raise with more VRAM |
| Queue timeout | 60000ms | Cancel when queued over 60s |

4. Save → wait for model loading (30–60 s, light turns green)
5. Verify: ask a question → normal answer; `nvidia-smi` shows VRAM usage

**Performance reference**: RTX 5070 8G runs 9B Q4 smoothly; local inference is slower (2–5 s per turn); Smart mode with multi-step tool calls may take 30–90 s for the first token — **normal, do not mistake for a hang**.

### 7.4 Model Reasoning Switches

| Setting | Default | Effect |
|---|---|---|
| Efficient mode · Model reasoning `efficient.reasoning` | Off | On = deeper thinking when generating (slower/costlier); off = fast & stable. **Internal steps (intent recognition) unaffected** |
| Smart mode · Model reasoning `smart.reasoning` | On | On = deep & thorough (default); off = lower cost/latency |

> Where: Q&A Configuration → Efficient mode Tab → "3. Organize answer" section / Smart mode Tab → "Thinking" section.

---

## 8. Q&A Configuration Reference

> Entry: "System Configuration" → "Q&A Configuration" (`/console/config/params`)
> **Page structure & common operations**:
> - Top: AI status light
> - Three tabs: **Efficient mode / Smart mode / General**
> - Each tab is organized into section cards (Efficient: "1. Understand question" / "2. Retrieve policies" / "3. Organize answer" / "4. After answering"; Smart: "Prompts" / retrieval / "Thinking"; General: "Home welcome area" / "UI copy" / "Feedback" / "Session" / "Tool" / "Security")
> - **How to edit**: edit locally (changed items are highlighted blue with an "Unsaved" tag) → click "Save changes (N)" at the top right of the section card → **saved = effective immediately, no restart**
> - Each item can be "Reset to default"; user-facing copy items (i18n) show an English value editor (orange "EN missing" tag when empty)

### 8.1 Efficient Mode: Understand (intent recognition)

> UI location: Efficient mode Tab → "1. Understand question"

| Setting | Default | Effect | When to adjust |
|---|---|---|---|
| Intent recognition prompt `efficient.intent.prompt` | Built-in | Tells AI how to split the user question (action intent × business topic); `{topics}/{intent_types}/{processes}` are injected from dictionaries | **Never remove the placeholders**; append rules for enterprise-specific terms |
| Max intents `efficient.intent.max_intents` | 5 | Max independent intents per question | Questions usually have 1–3; too high introduces noise |
| Intent timeout `efficient.intent.timeout_ms` | 20000ms | Intent recognition call timeout | Raise when the model is slow |

**Purpose**: decides "does AI understand the question correctly" — a wrong intent split = retrieval in the wrong direction. If answers are off-topic, check here first.

### 8.2 Efficient Mode: Retrieve (decides "how accurately it finds")

> UI location: Efficient mode Tab → "2. Retrieve policies". **This section's parameters directly affect retrieval quality and cost — the main tuning battlefield.**

**Retrieval strategy switches**

| Setting | Default | Effect & impact | When to adjust |
|---|---|---|---|
| Hybrid retrieval `efficient.retrieve.hybrid` | On | On = BM25 lexical + vector semantic dual-path fusion (fuller recall); off = vector only | Turn off only when pure vector is sufficient and you want to save compute; **lexical path matters for exact terms (clause numbers, proper nouns) — keep on** |
| Rerank `efficient.retrieve.rerank` | On | On = bge-reranker re-scores candidates (clear precision gain, ~1s); off = skip (faster) | Off only when speed matters and precision is acceptable; **keep on for quality-first scenarios** |

**Recall quantity parameters** (how much material AI gets)

| Setting | Default | Effect & impact | When to adjust |
|---|---|---|---|
| Top-K `efficient.retrieve.top_k` | 5 | Chunks entering generation | **Too small** = insufficient information (incomplete answers/rejections); **too large** = longer context (cost ↑, noise ↑). Raise when answers are incomplete |
| Fused candidates `efficient.retrieve.fused_candidates` | 20 | Candidates before rerank | Usually fixed; raise when retrieval quality is poor |
| RRF fusion k `efficient.retrieve.rrf_k` | 60 | Fusion parameter (higher = more averaged) | Usually fixed |

**Lexical parameters** (BM25, usually no adjustment)

| Setting | Default | Description |
|---|---|---|
| BM25 k1 `efficient.retrieve.bm25_k1` | 1.5 | Term-frequency saturation |
| BM25 b `efficient.retrieve.bm25_b` | 0.75 | Document-length normalization |

**Applicability weighting** (used with the applicability rules in 6.4)

| Setting | Default | Effect & impact | When to adjust |
|---|---|---|---|
| Applicable boost α `efficient.retrieve.applicable_boost` | 0.3 | Policies matching applicability → score ×(1+α) | **Raise to make AI more "personalized" (prioritize applicable policies)**; but too high may crowd out truly relevant general policies |
| Inapplicable penalty β `efficient.retrieve.inapplicable_penalty` | 0.15 | Clearly not applicable → ×(1-β) | Raise when cross-region/department policies are common |

**Timeout parameters** (prevent single-turn hangs)

| Setting | Default | Description |
|---|---|---|
| Request timeout `efficient.request.timeout_ms` | 30000ms | Whole-turn timeout |
| Retrieval timeout `efficient.retrieve.timeout_ms` | 30000ms | Python /search timeout |
| Branch timeout `efficient.branch.timeout_ms` | 15000ms | Per-intent branch timeout (degrades to empty, doesn't drag down the whole turn) |

**Tuning logic for this section**: if retrieval is poor, first confirm **hybrid/rerank are on** → then adjust **Top-K** → finally fine-tune **applicability weights**. Don't touch BM25 parameters first.

### 8.3 Efficient Mode: Generate (decides "how trustworthy the answer is")

> UI location: Efficient mode Tab → "3. Organize answer"

| Setting | Default | Effect & impact | When to adjust |
|---|---|---|---|
| Generation system prompt `efficient.generate.prompt` | Built-in | Behavior constraints (sectioning/citations/rejection/prompt-injection defense); `{reject_text}/{profile_section}` injected | Append enterprise style requirements; **do not remove the injection-defense clause** |
| Low-confidence words `efficient.generate.low_confidence_words` | not found…\|cannot determine… | Answer containing these words → judged low-confidence | Adjust for enterprise vocabulary (\| separated) |
| Max rounds `efficient.generate.max_rounds` | 5 | Max Q&A rounds per session | Raise for multi-turn follow-up needs (note resources) |
| Generation timeout `efficient.generate.timeout_ms` | 60000ms | Streaming generation timeout | Raise when the model is slow |
| Model reasoning `efficient.reasoning` | Off | See 7.4 | On for deeper answers (slower/costlier) |

**Anti-hallucination mechanism** (admins should know): when retrieval returns **0 hits, the system rejects directly** (no LLM generation) — a code-level guarantee, not prompt-dependent. So "incomplete answers" should be debugged in **retrieval** (8.2), not the generation prompt.

### 8.4 Efficient Mode: After Answering (external copy)

> UI location: Efficient mode Tab → "4. After answering". **All are employee-facing texts, customizable** (bilingual maintenance supported).

| Setting | Default | When shown |
|---|---|---|
| Reject text `efficient.reply.reject_text` | Not found in the policy library. | No retrieval hits / irrelevant question |
| Clarify text `efficient.reply.clarify_text` | To give you a more accurate answer, please provide: | Question lacks key info (e.g. travel allowance without a city) |
| Contact text `efficient.reply.contact_text` | Your question needs human assistance. Contacting the following colleagues: | Employee replies "transfer to human" |
| Topic guide text `efficient.reply.topic_guide_text` | To find the right contact, please specify your topic (e.g. travel, attendance, expat, expense). | Human handoff without a recognized topic |
| Action text (process) `efficient.reply.action_process_text` | Go to process | Process link card button |
| Action text (query hint) `efficient.reply.action_query_text` | Would you like to apply? | Weak hint after query-type answers |

**Master switch**

| Setting | Default | Description |
|---|---|---|
| Efficient mode enabled `efficient.mode.enabled` | On | Off = employees no longer see Efficient mode (Smart only); indexing unaffected; can be re-enabled anytime |

### 8.5 Smart Mode: Prompts (the AI's behavioral boundary)

> UI location: Smart mode Tab → "Prompts" section. **The main tuning area for Smart mode is prompts (not parameters).**

| Setting | Default role | When to adjust |
|---|---|---|
| Agent system prompt `smart.prompt.system` | Answer style & boundaries (evidence-only, injection defense, concise-first) | Rewrite for enterprise tone (formal/friendly) |
| Clarify-first `smart.prompt.clarify` | Topic-only questions (e.g. "leave") → clarify first, don't list everything | Keep; strengthen if answers get verbose |
| Process dictionary injection `smart.prompt.process_dict` | Push process links when users want to apply (`{processes}` injected) | Keep (don't remove the placeholder) |
| Personalization prompt `smart.prompt.profile` | Injects user attributes (`{profile_fields}`); for eligibility only, never discloses identity | Keep |
| Risk alert prompt `smart.prompt.risk` | Appends a "⚠️ Risk alert" block for prohibitive/mandatory clauses (basis + consequence + correct action) | Keep/strengthen for strict compliance |

### 8.6 Smart Mode: Retrieval

> UI location: Smart mode Tab → retrieval section

| Setting | Default | Description |
|---|---|---|
| Retrieval unit `smart.retrieve.unit` | Full text | Full text = match by section blocks (complete context); chunks = match by indexed chunks (more precise). **Full-text citations may look fragmented (bilingual headings split)** — switch to chunks if it bothers you |
| Grep top-N `smart.retrieve.grep_top_n` | 10 | Max hits returned per policy_grep call |
| policy_grep tool description `smart.tool.policy_grep_desc` | Built-in | Teaches AI how to use the search tool (synonyms joined with \|, one concept per search) |

### 8.7 General Configuration

> UI location: General tab. **These affect all users' experience.**

**Home welcome area (home)**

| Setting | Default | Description |
|---|---|---|
| Suggestions `common.home.suggestions` | ["How many annual leave days?"…] | Recommended questions on the employee home (list type) |
| Product name `common.home.title` | 企业政策 AI | Top bar + home title (**global brand name — change here**) |
| Subtitle `common.home.subtitle` | 政策了然于胸，行动自有分寸 | Home slogan |
| Greeting enabled `common.home.greeting_enabled` | On | "Good morning, {name}" greeting |
| Greetings `common.home.greeting_morning/afternoon/evening` | Good morning/afternoon/evening | Per-period copy |

**UI copy** `common.ui.stage_recognize/retrieve/generate/thinking/default`: stage messages during Q&A (Understanding your question… / Retrieving policies… / Organizing answer… / AI thinking… / Processing…).

**Feedback** `common.feedback.reasons`: reasons shown when employees downvote (Inaccurate / Not found / Hard to understand / Wrong citation / Other).

**Session** `common.session.expire_hours` (default 24h): session expiry (co-exists with the round limit; whichever triggers first).

**Tool timeouts**: `convert.timeout_ms` (120000ms, Word conversion) / `ingest.timeout_ms` (300000ms, chunk indexing). Raise for large files or slow models.

---

## 9. Q&A Routing

> Entry: "System Configuration" → "Q&A Routing" (`/console/config/routes`). Four tabs: Topics / Intents / Processes / Routes.
> **Purpose**: lets AI move "from answer to action" — detects a user wants to do something → pushes a process link; detects a user needs a human → pushes a contact.

### 9.1 Topics (policy_topics)

| Field | Description | Advice |
|---|---|---|
| Name / English name | Display names | Match employee vocabulary |
| Keywords | Synonyms (Leave: vacation/annual leave/marriage leave/maternity leave/sick leave) | **Cover common enterprise wording** — determines intent-recognition recall |
| Scope | What it covers / doesn't cover | **Injected into the intent prompt**; clear scopes greatly reduce misclassification |

Built-in 6 topics (Leave/Attendance/Travel/Expense/Expat/Other). **Enterprise-specific business** (e.g. "overtime approval" under Attendance) can be tuned via keywords and scope.

### 9.2 Processes (processes)

| Field | Description |
|---|---|
| Name / English name | Display (e.g. "Leave") |
| URL | Process application link (OA/Feishu deep link etc.) |
| Topic | Fallback (pushed by topic when no exact flow match) |
| Keywords | Auxiliary matching |

**Mechanism**: employee intent = apply for a process ("I want to take leave") → AI matches the process → a **process link card** at the end of the answer; for query-type intents ("how many leave days") with a matching process, a weak hint "Would you like to apply?" is appended.

### 9.3 Routes (contact persons, topic_routes)

| Field | Description |
|---|---|
| Topic | Business topic |
| Region | Optional — **region-level contacts take priority**, topic-level fallback otherwise |
| Contact | Selected from users (contact info auto-filled) |

**Mechanism**: employee explicitly asks for a human ("transfer to human"/"find someone") → match contact by "topic + employee region" → push a contact card.

**Example**: Leave topic → Region = Guangdong → contact = 李婷 (HRBP); no region → topic-level fallback contact.

---

## 10. Security Settings

> Entry: "System Configuration" → "Security Settings" (`/console/config/security`). Blocks: Security levels / level behavior / read protection / login security / audit log.

### 10.1 Security Levels `security.levels`

- Built-in 4 levels: Public / Internal / Confidential / Top secret (levels can be added/edited, with Chinese and English names)
- Policies must choose a level (5.5)

### 10.2 Level Behavior Policy `security.policy` (core security mechanism)

Each level has **4 independent switches** (the behavior matrix columns):

| Switch | Effect | Typical config |
|---|---|---|
| Browse watermark | Watermark (user name + employee no. + time) tiled on the read page (traceable screenshots) | Confidential: on |
| Copy protection | Disable selection/copy on the read page | Internal: on |
| **AI searchable** | Off = humans can read, **AI never cites** (hard filter) | Confidential: off (prevent AI leaks) |
| Browse audit | Record who read this level's documents | Confidential: on |

> Note: **unauthorized access attempts (403) are always recorded** (no switch) — someone trying to access an unauthorized policy is a security event, independent of the target level.

**Built-in default policy**: Public (no protection, AI searchable) / Internal (copy protection, AI searchable) / Confidential (watermark + copy protection + **AI not searchable** + audit) / Top secret (same as Confidential + audit).

> **Advice for admins**: for high-sensitivity policies (HR, compensation, audit), make sure `AI searchable = off` — when employees ask related questions, AI will not cite these contents (prevents sensitive information leaking through AI).

### 10.3 Read Protection (global switches)

| Switch | Default | Description |
|---|---|---|
| Browse watermark `common.security.watermark_enabled` | On | Global watermark (level policy takes precedence) |
| Copy protection `common.security.copy_protect_enabled` | On | Global copy protection |

### 10.4 Login Security

| Switch | Default | Description |
|---|---|---|
| Force password change on first login `common.security.force_change_on_first_login` | Off | Users must change the password before use (created/imported/reset users trigger). **Recommended on for production** |

### 10.5 Audit Log Viewer

- The Security Settings page can browse audit logs (chat/audit), by day
- Full log files live in `data/logs/` (see 11.2)

---

## 11. Statistics & Logs

### 11.1 Statistics (entry: top nav "Statistics" `/stats`)

| Report | Content | How to use (management value) |
|---|---|---|
| KPI cards + mode comparison | Sessions / avg rounds / token usage / avg latency, Efficient vs Smart | Evaluate cost & experience of both modes → decide default mode/model |
| Trend + hourly distribution + feedback | Sessions per day, top-3 regions, up/downvotes per day | Observe usage activity; schedule maintenance in troughs; region differences guide rollout |
| Citation ranking + top-10 policies | Libraries/policies ranked by citations | **High-frequency policies** may need updates or promotion; **low-citation policies** may be unknown to employees |

### 11.2 Log System (data/logs/)

| Directory | Records | Use |
|---|---|---|
| `chat/` | Every Q&A turn (question/answer/citations/metrics/latency) | Q&A quality review, AI optimization material |
| `audit/` | Admin operations (upload/publish/retire/delete/feedback) | **Compliance audit** (policy actions leave traces) |
| `app/` | Runtime (startup/errors/indexing) | Fault location |
| `alerts/` | Alert records (health check / monitoring triggers) | Ops event history |

- Format: JSON Lines (one record per line, timestamped)
- Split by day; auto-rotates at 200MB (.1/.2)
- **Audit logs are not auto-cleaned** (compliance requirement; archive manually)

### 11.3 Continuous Optimization with Data (AI-Native loop)

1. **Review chat logs** → find high-frequency questions with poor answers
2. **Tune prompts** (Ch. 8) → all prompts configurable in the UI, effective immediately
3. **Feed back into business**:
   - High-frequency questions → distill FAQs into home suggestions (8.7)
   - Hard-to-understand clauses → suggest policy revisions to the owner
   - Contradictory/outdated references → schedule policy updates (version management in 5.4)

---

## 12. Backup & Restore

### 12.1 Automated Backup

```bash
node scripts/backup.mjs                          # manual backup (keeps last 14 by default)
BACKUP_DIR=D:/backup node scripts/backup.mjs      # back up to another disk/network (recommended in production)
node scripts/backup.mjs --keep 30                 # keep 30
```

- Contents: SQLite main DB (online hot backup, non-blocking) + vector store + uploads + smart session memory
- Validates SQLite readability after backup
- **Production recommendation**: `register-schedules.ps1` registers a daily 03:00 auto-backup; point the backup dir to a different disk/network share

### 12.2 Restore

```bash
node scripts/restore.mjs data/backup/2026-08-13_21-48-29            # preview + confirm (refuses while services run)
node scripts/restore.mjs data/backup/2026-08-13_21-48-29 --yes      # skip confirmation
node scripts/restore.mjs data/backup/2026-08-13_21-48-29 --stop     # auto-stop services then restore (admin)
```

**Fail-safe design**: before restoring, the "current (possibly newer) data" is backed up to `data/backup/_pre-restore-<timestamp>/` (reversible); validates SQLite readability after restore; dual-store consistency is synced automatically on backend startup.

---

## 13. Monitoring & Troubleshooting

### 13.1 Health & Monitoring System (registered by register-schedules.ps1)

| Tool | Frequency | Role | Alerting |
|---|---|---|---|
| `health-check.mjs` | every 1 min | Fast faults: backend/python liveness & hang; after N consecutive failures → auto-restart NSSM services (low-level alert) or manual alert (no NSSM) | `data/logs/alerts/` + optional webhook |
| `monitor.mjs` | every 5 min | Slow variables: disk (threshold 80%) / memory (90%) / service state; **alerts only on state changes** (dedup, no spam) | Same |
| Backup task | daily 03:00 | Full backup | Failure alert |

- Custom thresholds: `DISK_THRESHOLD` / `MEM_THRESHOLD` / `FAIL_THRESHOLD` env vars
- Enterprise alerting: `MONITOR_WEBHOOK` env var (POST JSON to corporate IM/email gateway)

### 13.2 Troubleshooting Quick Reference (symptom → diagnose → fix)

| Symptom | Possible cause | Steps |
|---|---|---|
| **All answers rejected ("Not found in the policy library.")** | ① Policy not published/not yet effective ② Library disabled ③ Model not configured ④ Python down | ① Check version status in Policy Management ② library status ③ Model Connection AI light ④ `curl localhost:8001/health` |
| **Retrieval intermittent** | ① Multiple backend instances fighting for port 3000 ② Python in-memory index anomaly | ① `netstat -ano \| grep 3000` — exactly one listener, kill the rest ② restart Python (BM25 auto-rebuilds) |
| **An employee can't see a policy** | Visibility rules not matched | Check the user's attributes vs the policy's visibility conditions (6.3); temporarily widen the rule to verify |
| **AI cites policies it shouldn't (cross-region)** | Applicability not configured | Configure applicability for the policy (6.4 / 8.2 weights) |
| **Local model slow/hangs** | Local inference is inherently slow | 2–5s per turn for 9B, 30–90s first token in Smart mode = normal; confirm VRAM (`nvidia-smi`); consider cloud mode |
| **No policies visible after login** | Visibility + attributes mismatch | Check 6.3; note `AI searchable = off` policies are readable but never cited |
| **Service restart loop** | Production build issue | Check `data/logs/alerts/` and NSSM logs; confirm `npm run build` artifacts complete (`dist/` contains main.js) |
| **Frontend blank page** | Dev-mode Vite cache | Restart the vite dev server; in production check build artifacts/static hosting |
| **HTTPS certificate warning** | Self-signed certificate | Expected (trust once per client); use a real certificate in production |

### 13.3 Manual Ops Commands

```bash
# Service management (NSSM)
tools/nssm/nssm.exe status policybot-backend     # status
tools/nssm/nssm.exe restart policybot-backend     # restart

# Index consistency repair
node scripts/sync-index.mjs --dry-run             # preview orphans
node scripts/sync-index.mjs                       # clean

# Full reindex (policy data and vectors out of sync)
node scripts/reindex-all.mjs
```

---

## 14. Security Hardening Checklist

**Mandatory (verify each before production):**

- [ ] Set `POLICYBOT_MASTER_KEY` (32-byte hex) — key separation, no auto-generation on disk
- [ ] Set `POLICYBOT_INITIAL_PASSWORD` to override the default initial password
- [ ] Security Settings: enable "Force password change on first login"
- [ ] Enable HTTPS (`HTTPS_ENABLED=1` + real certificates)
- [ ] The admin account (A001) password changed from the initial one
- [ ] Every policy has a security level; `AI searchable = off` for Confidential and above (humans can read, AI never cites)
- [ ] Visibility configured (employees see only what they should)

**Recommended:**

- [ ] `BIND_HOST=0.0.0.0` only when LAN access is needed (default 127.0.0.1 does not expose)
- [ ] Configure `CORS_ORIGINS` whitelist (tighten cross-origin in production)
- [ ] Back up to another disk/network (`BACKUP_DIR`)
- [ ] Register scheduled tasks (health/monitor/backup)
- [ ] Archive audit logs regularly (compliance)
- [ ] Review chat logs regularly (FAQ distillation, policy revision suggestions)

**Security design notes** (know the capability boundary):
- API keys encrypted at rest (AES-256-GCM), plaintext never persisted
- Passwords stored as scrypt salted hashes
- Session tokens expire in 7 days; logout revokes
- Anti-probing: unauthorized content "does not exist" (search/direct URL both blocked)
- Frontend leak prevention = watermark traceability + copy protection (**raises the cost, does not guarantee prevention** — DevTools/OCR/photos can still bypass)

---

## 15. Appendix: Environment Variables & Glossary

### 15.1 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Backend port |
| `BIND_HOST` | 127.0.0.1 | Backend bind address (set 0.0.0.0 for LAN) |
| `HTTPS_ENABLED` | off | 1 enables HTTPS |
| `HTTPS_CERT` / `HTTPS_KEY` | data/certs/ | Certificate/key paths |
| `HTTPS_PORT` | 3443 | HTTPS port |
| `SQLITE_PATH` | data/policybot.db | SQLite path |
| `PYTHON_BASE_URL` | http://localhost:8001 | Python search engine URL |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` | — | DeepSeek key (fallback when not configured in UI) |
| `DEEPSEEK_MODEL` | deepseek-v4-flash | Default model (highest ops priority) |
| `AUTH_MODE` | production | production = login required; demo = X-User-Id fallback (testing only) |
| `POLICYBOT_MASTER_KEY` | — | Encryption key (32B hex, mandatory in production) |
| `POLICYBOT_INITIAL_PASSWORD` | Pass1234 | Initial password override |
| `POLICYBOT_SECRETS_DIR` | ~/.policybot-secrets | Secrets directory (must be set for NSSM service accounts) |
| `POLICYBOT_CHROMA_PATH` | data/vector-db | Vector store path |
| `POLICYBOT_SKIP_SYNC` | — | 1 = skip startup index sync (testing only) |
| `CORS_ORIGINS` | localhost | CORS whitelist (comma-separated) |
| `POLICYBOT_HYBRID` / `POLICYBOT_RERANK` / `POLICYBOT_TOPK` | 1/1/5 | Retrieval switches (env overrides, highest priority) |
| `VITE_PORT` / `BACKEND_PORT` | 5173/3000 | Dev ports |
| `POLICYBOT_PYTHON` / `POLICYBOT_NODE` | auto-detect | Interpreter paths for service scripts |
| `MONITOR_WEBHOOK` / `DISK_THRESHOLD` / `MEM_THRESHOLD` / `FAIL_THRESHOLD` | —/80/90/3 | Monitoring/alerting |

### 15.2 Glossary

| Term | Meaning |
|---|---|
| Library / Line / Version | Library = topic collection; line = a policy's stable identity; version = a point-in-time snapshot (switched by effective dates) |
| Chunk | The smallest retrieval unit of a policy (auto-split by headings, manually adjustable) |
| Visibility | Who can see (hard filter, ABAC) |
| Applicability | Whose policies AI prioritizes (soft ranking, ABAC) |
| Security level policy | Per-level protections (watermark/copy protection/AI searchable/audit) |
| RRF fusion | Merge algorithm for dual-path results (BM25 + vector, rank-based) |
| Rerank | Re-scoring candidates with a reranker model (precision gain) |
| Efficient mode | Workflow orchestration (LangGraph + vector RAG) |
| Smart mode | Agentic orchestration (Pi SDK + full-text retrieval) |
| policy_grep | Smart mode's permission-scoped full-text search tool |
| Index consistency | Comparison & cleanup between SQLite effective versions and Chroma vectors |

---

> This document is kept consistent with the source code (config keys, defaults and commands verified against current code). If discrepancies are found, the code prevails — please report them.
