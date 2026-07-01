# Implementation Plan — Screening → Identify → Score

Rework the intake tool from a single per-batch 0–10 "violation likelihood" score into the
firm's real workflow: **screen the evidence → (if there's a plausible claim) identify the
defendant(s) → score each company** against the firm's documents. The score is a deterministic
0–100 TCPA IQ scorecard, computed **per company (per potential lawsuit)**, not per upload batch.

Source documents (firm-provided, in `EXTRA_INFO/`):
- `Gold-Law-Intake-Screening-SOP` + `Gold-Law-Intake-Cheat-Sheet` — the screening / gating / routing logic.
- `TCPA IQ - Scoring Rubric` — the 0–100 case-value scoring engine.

Each step below is self-contained and meant to be executed and reviewed individually. Later
steps depend on earlier ones in the order given.

---

## Decisions locked (context for every step)

These were agreed during planning. Treat them as fixed unless this section is updated.

1. **Scoring unit = company, not batch.** One upload (an *intake*, one customer/GHL contact)
   can produce N *company cases*, each with its own screening result and scorecard.
2. **Naming:** keep `Case` to mean the *intake* (the uploaded batch). The score/screening/
   scorecard live on each `DefendantCandidate` (the *company case*). No rename for now.
3. **Determinism:** the LLM **extracts structured facts**; **deterministic TypeScript computes
   the screens and the score.** No LLM-produced numeric scores.
4. **Flow:** `screen (cheap intake gate) → identify (only if a claim is plausible) → screen+score per company`.
5. **SOL gate:** reject if the newest qualifying message is older than **4 years − 30 days**
   (i.e. under 30 days of filing runway). 30 days is a configurable constant. On an SOL reject,
   flag `notifyLeadImmediately`.
6. **DNC double-count / willfulness:** the DNC-contact willfulness aggravator is **dropped**.
   A volume-based **+6 willfulness** for high contact volume is a **config toggle, default OFF**,
   threshold **10+** contacts.
7. **Debt-collection track (narrowed):** debt collection is a **separate, non-TCPA track**. For
   MVP the **only** debt scenario handled is **IDNC: a STOP request followed by another *text***.
   In that case flag a **"Debt collection violation"** and route to the separate track — do **not**
   run it through the TCPA IQ engine. All other debt scenarios are out of scope for MVP.
8. **DNC lookup is OUT of MVP.** No RealValidation/GHL integration yet. Screen 04 and Claim-Type
   Tiers 2 (FL DNC) & 4 (Nat'l DNC) are **detected and flagged as "unverified — pending DNC API,"**
   award **no** points, and appear as score-raising unknowns. The engine leaves the slot open.
9. **Repeat-offender list is OUT of MVP.** Willfulness top tier (18, prior settlement/judgment)
   is not scored and not flagged; a hook is left for when the firm list / GHL lands.
10. **Quiet hours timezone:** treat the **screenshot's displayed timestamp as the client's local
    time**. No timezone conversion, no "timezone unconfirmed" flag.
11. **Database:** none yet (session-only, as today). All new types must be shaped so a future DB
    layer just persists them — design the serialization, not a redesign.

Kept from the current app (reused, not rebuilt): audio transcription, image description, audio
forensics, the defendant-identification agent (`web_search` / `fetch_page` / `sos_lookup`), the
Florida cross-lookup, SOS record handling, enrichment, and the zip export.

---

## Step 1 — Write the two spec docs (source of truth)

**Goal:** encode the firm documents as two precise specs the code implements. Nothing is coded
against vibes; these are the reference for Steps 3–4.

**Deliverables:**
- `docs/screening-spec.md`:
  - SOL gate (4yr − 30d, per-message date-of-receipt, `notifyLeadImmediately`).
  - Message classification: telemarketing / debt collection / informational (with the
    "free webinar / funnel ends in a pitch = telemarketing" rule).
  - The four screens with exact triggers and the evidence each needs:
    01 Prerecorded voice · 02 Failure to stop (IDNC, one-confirmation carve-out + 24h buffer)
    · 03 Quiet hours (2+ contacts 9PM–8AM, screenshot timestamp = local) · 04 DNC registry
    (telemarketing only — MVP: detect + flag unverified).
  - Two-track routing (TCPA vs debt-collection) and the narrowed debt scope (Decision 7).
- `docs/scoring-spec.md`:
  - The six factors with full point tables (Claim Type 24 / Collectability 24 / Willfulness 18 /
    Volume 16 / Identifiability 10 / Defensibility 8), stacking add-ons, kill conditions,
    the shell cap (1–2 emp AND no SoS AND sub-$1M → cap 50), bands, and the scorecard output
    format (mirrors the PDF: per-factor breakdown, cap check, kill checks, "needs intake to
    confirm" unknowns).
  - MVP stubs called out inline: DNC tiers (no points, flagged), repeat-offender (not scored),
    high-volume willfulness toggle.

**Acceptance:** both docs reviewed and approved; factor maxes sum to 100; every locked decision
above is reflected.

**Notes:** `docs/tcpa-evaluation.md` is superseded — its screen/detection content migrates into
`screening-spec.md`; its 0–10 scoring section is dropped. (Actual file removal is Step 9.)

---

## Step 2 — Domain types & data model

**Goal:** define every new shape up front so the engines, routes, and UI share one vocabulary.

**Files:** `lib/types.ts`.

**Work items:**
- `ExtractedContact` / `EvidenceFacts` — the normalized fact set produced by extraction: per
  message/contact `{ file, direction (consumer|company), timestamp, dateReceived, channel
  (text|call|voicemail|email), messageType, isStopRequest, isOptOutConfirmation, isPrerecorded,
  consentSignal, killSignal (job_scam|true_healthcare|none), contentSummary }`.
- `Track = "tcpa" | "debt_collection"`.
- `ScreenResult` per screen `{ screen, hit: boolean, track, basis, unverified?: boolean }`.
- `KillCheck { declined: boolean, reason?: "job_scam" | "true_healthcare" }`.
- `ScoreFactor { name, points, max, basis }`; `Scorecard { factors, raw, capApplied, final,
  band, unknowns: string[], killCheck }`.
- `IntakeGate { solPass: boolean, notifyLeadImmediately: boolean, hasPlausibleClaim: boolean,
  declineReason?: string }`.
- Extend `DefendantCandidate` with `track`, `screens: ScreenResult[]`, `scorecard`.
- Extend `Case` with `gate?: IntakeGate`; **remove** the old `Evaluation`/score fields from `Case`.
- Add a `SOL_BUFFER_DAYS = 30` constant and a `HIGH_VOLUME_WILLFULNESS` config flag (default off,
  threshold 10).

**Acceptance:** types compile; old `Evaluation`-on-`Case` references identified for later steps;
shapes are serializable (DB-ready).

---

## Step 3 — Deterministic scoring engine

**Goal:** a pure function implementing `scoring-spec.md` exactly. No network, no LLM. (No
automated tests per decision — correctness verified by reading + the worked example by hand.)

**Files:** `lib/scoring/` (`engine.ts`).

**Work items:**
- `scoreCompany(input) → Scorecard` where input = `{ theories, screens, volumeCount,
  collectability (from enrichment), forum (from SOS/FL), defensibility (consent posture),
  willfulness signals, killCheck, flags }`.
- Implement: kill-condition short-circuit → six additive factors → stacking add-ons → shell cap
  → band mapping → unknowns assembly.
- MVP behavior: DNC tiers contribute 0 points but push a string into `unknowns`; repeat-offender
  absent; high-volume willfulness gated behind the config flag.

**Acceptance:** each factor, the stacking add-ons, the shell cap (all-three vs one-of), the band
boundaries, and kill-condition decline behave per `scoring-spec.md`; the worked example checks out.

---

## Step 4 — Deterministic screening engine (gate + four screens + kill checks)

**Goal:** a pure module implementing `screening-spec.md`. Takes `EvidenceFacts`, returns gate +
per-company screen results + kill check. (No automated tests per decision.)

**Files:** `lib/screening/` (`gate.ts`, `screens.ts`, `index.ts`).

**Work items:**
- `evaluateIntakeGate(facts) → IntakeGate` — SOL (4yr − 30d, per message), plausible-claim check.
- `runScreens(companyFacts) → ScreenResult[]` — the four screens over one company's evidence,
  including: IDNC one-confirmation carve-out + 24h buffer; quiet-hours 2+ contacts 9PM–8AM using
  the screenshot timestamp as local; debt-collection narrowing (Decision 7); DNC marked unverified.
- `checkKillConditions(companyFacts) → KillCheck` (job scam; true healthcare, with the
  device-marketing-stays-viable carve-out).
- Volume counting: contacts attributable to the company.

**Acceptance:** each screen (hit / near-miss / miss), the 24h buffer, the confirmation carve-out,
debt-vs-marketing routing, the SOL boundary at exactly 4yr − 30d, and both kill conditions
(including the healthcare carve-out) behave per `screening-spec.md`.

---

## Step 5 — Extraction pass + intake gate route

**Goal:** turn raw evidence into the normalized `EvidenceFacts`, then run the intake gate. This
replaces the old `tcpa-evaluation` route's role.

**Files:** new `app/api/extract-screen/route.ts`; client wiring in `app/page.tsx`.

**Work items:**
- Multimodal extraction (reads images directly + audio transcriptions + forensics) → `EvidenceFacts`
  via structured `Output`, temperature 0 + seed (determinism).
- Run `evaluateIntakeGate`; if the intake is declined (SOL or no plausible claim), set
  `Case.gate`, surface the decline, and **do not** trigger identification.
- Replace the `evaluateCase` effect in `page.tsx` with this extract→gate step.

**Acceptance:** an informational-only or time-barred upload is declined here and never reaches
identification; a plausible upload produces facts and proceeds.

---

## Step 6 — Rewire identification route to screen + score per company

**Goal:** after defendants are identified, run the four screens and the scorecard **per company**,
using each company's attributed evidence + its SOS/FL/enrichment data.

**Files:** `app/api/defendant-identification/route.ts`, `lib/agents/defendant-agent.ts` (only if
the enrichment output needs an extra collectability field).

**Work items:**
- After candidates + SOS + FL + enrichment are assembled, for each candidate:
  - gather its attributed `EvidenceFacts` (via existing `evidence_files`),
  - `runScreens` + `checkKillConditions`,
  - derive forum (from SOS/FL nexus), collectability (from enrichment), defensibility,
    willfulness, volume,
  - `scoreCompany` → attach `scorecard`, `screens`, `track`.
- Pass the extracted facts from Step 5 into this route (currently only category/message_type
  context is passed).

**Acceptance:** a multi-company intake yields one scorecard per company with independent bands;
a debt-collection IDNC company is flagged on the debt track and carries no TCPA score.

---

## Step 7 — Frontend / UX refactor

**Goal:** make the per-company scorecard the centerpiece; surface gates and tracks clearly.

**Files:** `components/evaluation.tsx`, `components/company-card.tsx`, `components/case-detail.tsx`,
`components/case-sidebar.tsx`, `app/page.tsx`.

**Work items:**
- Intake view: client + files + **gate banner** (SOL pass/fail with a loud "⚠ notify lead
  immediately" on SOL reject; decline reason when no claim).
- Company card: scorecard (score/100, band chip, factor breakdown), four-screen results, track
  badge (TCPA vs Debt collection), flagged unknowns, plus the existing SOS records / evidence /
  download.
- Replace the 0–10 `ScoreBadge` with a 0–100 band-colored badge (Priority/Solid/Marginal/Pass).
- Sidebar: show per-company bands so reviewers triage by band.

**Acceptance:** verified in the running app — declined intake shows the banner and no companies;
a scored intake shows correct per-company scorecards and bands.

---

## Step 8 — Export / manifest update (DB-ready)

**Goal:** each company bundle carries its full new record.

**Files:** `lib/export.ts`.

**Work items:**
- Add the per-company `scorecard`, `screens`, and `track` to `manifest.json` and `summary.txt`.
- Add the intake `gate` outcome to the case-level bundle.
- Keep shapes aligned with the future DB record.

**Acceptance:** a downloaded company zip contains its scorecard + screening results + track;
manifest stays machine-readable.

---

## Step 9 — Cleanup & doc reconciliation

**Goal:** remove superseded code/docs and fix drift.

**Work items:**
- Delete `app/api/tcpa-evaluation/route.ts` and `docs/tcpa-evaluation.md`.
- Remove dead `Evaluation`-on-`Case` code paths.
- Update `TODO.md` (item #1 Florida cross-lookup is already implemented — mark done) and any other
  stale references.
- Update `AGENTS.md`/README pointers to the two new specs if needed.

**Acceptance:** no references to the old evaluation route/doc remain; `tsc` and lint pass.

---

## What's intentionally stubbed in MVP (leave the slot open, never fake)

| Capability | MVP behavior | Future |
|---|---|---|
| DNC verification (RealValidation) | detect + flag "unverified", 0 points | add `lib/dnc.ts`, award Tiers 2/4 |
| Client phone source (GHL) | not linked | manual entry, then GHL webhook |
| Repeat-offender list | not scored, no flag | firm list / GHL → willfulness 18 |
| High-volume willfulness +6 | config toggle, default OFF (10+) | flip on if desired |
| Database | session-only | persist the already-DB-shaped types |
