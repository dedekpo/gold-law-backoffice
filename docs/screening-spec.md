# Screening Spec — Gating, Classification & the Four Screens

**Status:** source of truth for the screening half of the pipeline. Implemented by
`lib/screening/` (deterministic) on top of the facts produced by the extraction pass.
Derived from the firm's `Gold-Law-Intake-Screening-SOP` and `Gold-Law-Intake-Cheat-Sheet`.

Companion doc: [`scoring-spec.md`](./scoring-spec.md) (the 0–100 case-value engine).

> Screening answers two questions: **is there a claim at all**, and **which track** (TCPA vs
> debt collection). It does **not** produce the case-value score — that is the scoring engine,
> which runs per company after a defendant is identified.

---

## 0. Where screening runs in the pipeline

```
Upload (intake) → transcribe/describe + forensics
  → EXTRACT facts            (LLM → normalized EvidenceFacts)
  → INTAKE GATE              (this doc §1–2) ── declined ──► stop, surface reason
  → IDENTIFY defendant(s)    (only if the gate passed)
  → PER-COMPANY SCREEN       (this doc §3–5, over each company's attributed evidence)
  → PER-COMPANY SCORE        (scoring-spec.md)
```

Screening is applied **twice on purpose**:

1. **Intake gate (cheap, batch-level).** Over *all* the intake's evidence: is any qualifying
   message inside the SOL window, and is there *any* plausible violation? If not, decline the
   intake and never spend identification effort. (§1–2)
2. **Per-company screen (full, after identification).** The four screens run over each
   identified company's *attributed* evidence (via `evidence_files`), because different
   companies in one intake can have different violations. This is the input to scoring. (§3–5)

---

## 1. First gate — the 4-year SOL clock

The TCPA statute of limitations is **four years**, measured from the **date of receipt** of each
qualifying voicemail/text (the clock runs from when the consumer got it). This gate runs
**before everything else** — a time-barred lead is rejected no matter how strong the violation.

Rules (deterministic):

- **`SOL_BUFFER_DAYS = 30`** (configurable constant).
- A message **qualifies** if it is a potential violation contact (a telemarketing/debt text,
  call, or voicemail — not a pure informational notice).
- For each qualifying message compute `ageDays = now − dateReceived`.
  - `ageDays > 4 years` → that message is **time-barred** (drops out; does not count).
  - `ageDays > 4 years − SOL_BUFFER_DAYS` (i.e. under 30 days of runway) → also treated as
    **non-viable to file** (drops out).
- **Explicit-year requirement (critical).** A message can be time-barred **only** when a
  **4-digit year is explicitly visible** in the evidence. Messaging and email apps show only the
  month/day for **recent (current-year)** messages and add the year **only for older** ones — so a
  date with no visible year is recent *by the apps' own convention* and is treated as **in-window**.
  The extractor sets `dateReceived` only when a year is shown (and flags `dateReceivedYearShown`);
  it never guesses a year. The gate only applies the SOL math to explicit-year dates.
- **Gate outcome:**
  - Time-bar (`solPass = false`, `notifyLeadImmediately = true`, decline `"time-barred"`) **only**
    when **every** qualifying message has an explicit-year date **and** all are outside the viable
    window. If any qualifying message lacks a visible year (or has no date), it is in-window and the
    gate passes.
  - Otherwise `solPass = true`.
- **Unclear / missing dates pass.** A qualifying message with no visible year (or no date) is **not**
  rejected — it is treated as in-window and surfaced as a flagged unknown to confirm at intake. The
  chance such a message is actually >4 years old is thin (apps would show the year), so we accept it.

> **`notifyLeadImmediately`** mirrors the SOP: the instant an SOL problem is spotted, the lead
> must be told right away so they can seek other counsel while they still can. The UI surfaces
> this loudly.

---

## 2. Intake-level "is there a plausible claim?"

After the SOL gate, the intake proceeds to identification **only if** at least one in-window
qualifying message shows a *potential* violation under any of the four screens (§3). This is a
coarse OR over the extracted facts — full screen evaluation happens per company later.

- All evidence is **informational** (appointment reminders, shipping updates, 2FA codes, fraud
  alerts) → no claim → decline, reason `"no-claim-informational"`. Do **not** identify.
- Otherwise → `hasPlausibleClaim = true`, proceed to identification.

---

## 3. Message classification (per message)

Every message is classified by the extraction pass; the screens key off it.

| Class | Definition | Track |
|---|---|---|
| **Telemarketing** | Purpose is ultimately to sell — now or eventually. A "free webinar" / freebie that pitches at the end **counts**. If selling is the goal anywhere in the funnel, it's telemarketing. | TCPA (FTSA overlay if Florida) |
| **Debt collection** | Attempting to collect an alleged debt (overdue bill, loan, judgment). | Debt collection (FDCPA + FL) — **separate, non-TCPA track** |
| **Informational** | Pure notice — no sale, no debt (appointment, shipping, account alert, 2FA). | None — no claim |

---

## 4. The four screens (run per company)

Each screen runs over **one company's attributed, in-window evidence** and returns a
`ScreenResult { screen, hit, track, basis, unverified? }`. A company may hit several screens
(this is what scoring's "stacking" rewards).

### Screen 01 — Prerecorded Voice
- **Trigger:** a voicemail that is pre-recorded / artificial / robotic (not a live person).
  **A single prerecorded voicemail is the violation by itself.**
- **Signal source:** the extraction `isPrerecorded` flag, corroborated by the audio-forensics
  `is_likely_prerecorded` / `automated_likelihood` already produced per recording.
- **Applies to:** any call. **Track:** TCPA. **Maps to:** Claim Tier 1.

### Screen 02 — Failure to Stop (IDNC)
- **Trigger:** the consumer sent any reasonable opt-out (`stop`, `unsubscribe`, `no more`,
  `remove me`, `do not text me`, …) and was contacted again afterward.
- **Carve-out:** **one** automated confirmation reply ("You've been opted out") is allowed and
  does **not** count.
- **Buffer:** apply a **24-hour** buffer between the opt-out and the counted follow-up. A sent
  "Stop" bubble often has **no visible timestamp** — in that case fall back to the **thread order**
  (a company message appearing after the opt-out counts) rather than dropping the theory; the 24h
  buffer is confirmed by timestamps only when both messages carry one. The extractor also infers an
  undated message's time from its neighbours so the accurate buffer path can still apply.
- **Marketing branch:** opt-out → ≥1 further **marketing** message (text or call) >24h later →
  **hit, track = TCPA**, maps to Claim Tier 1 (Internal DNC, 64.1200(d)).
- **Debt-collection branch (MVP-narrowed):** opt-out → ≥1 further **text** in a
  debt-collection context >24h later → **hit, track = debt_collection**, basis
  `"Debt collection violation"`. **Not scored by the TCPA engine** — routed to the separate
  track. (Per the locked MVP scope, only a follow-up *text* is handled; follow-up calls/emails
  are out of scope for now.)

### Screen 03 — Quiet Hours
- **Trigger:** **2+ contacts** (calls or texts) sent between **9:00 PM and 8:00 AM**.
- **Timezone:** treat the **screenshot's displayed timestamp as the consumer's local time** —
  no conversion, no "timezone unconfirmed" flag.
- **Marketing branch:** **hit, track = TCPA**, maps to Claim Tier 3.
- **Debt-collection branch:** out of MVP scope (debt scope is limited to Screen 02 text
  follow-ups). Do not produce a debt-track quiet-hours hit for now.

### Screen 04 — Do-Not-Call Registry  *(interim: operator attestation)*
- **Trigger:** telemarketing **only** (debt collection never applies). The consumer's number is
  on a DNC list:
  - **Federal NDNC:** ≥2 telemarketing texts within any 12-month window (the two can be far
    apart — Dec + Feb both count).
  - **Florida DNC:** even a **single** telemarketing text (always check the FL list when the
    consumer or company is in Florida).
- **Registration source (interim, until the registry API check lands):** two case-level
  checkboxes at case creation — "National DNC" and "Florida DNC" — ticked by an **intaker after
  a manual lookup on the registry sites**. This is an operator attestation of a performed check,
  NOT the client's word (which is still never taken as a confirmed hit).
  - **Florida confirmed** → hit (≥1 telemarketing contact), unlocks Claim Tier 2.
  - **National confirmed** → hit only with ≥2 telemarketing contacts, unlocks Claim Tier 4.
    With a single contact the basis explains the federal 2-contact rule and no tier unlocks.
  - Both confirmed → one hit carrying both tiers (they count as distinct theories for stacking).
- **Unchecked boxes mean "not confirmed"** — either nobody looked or the lookup was negative —
  so the screen keeps its prior behavior: `hit = false, unverified = true`, no Claim Tier 2/4
  points, surfaced as the score-raising unknown (`"DNC status unverified — pending registry
  check"`).
- **When the API lands:** the checkboxes are replaced by an automated lookup of the client's
  number; `unverified` clears the same way.

---

## 5. Two-track routing summary

| Screen | Telemarketing → | Debt collection → | Informational |
|---|---|---|---|
| 01 Prerecorded voice | TCPA | (n/a) | no claim |
| 02 Failure to stop (IDNC) | TCPA | **Debt track** (text follow-up only, MVP) | no claim |
| 03 Quiet hours | TCPA | out of MVP scope | no claim |
| 04 DNC registry | TCPA *(hit only with an operator-attested registration)* | (n/a) | no claim |

- **TCPA-track** companies flow into the scoring engine (`scoring-spec.md`).
- **Debt-collection-track** companies are **detected, flagged, and parked** — not scored by the
  TCPA engine. (A separate FDCPA scoring rubric is future work; FDCPA also has its own, shorter
  SOL, so it is deliberately kept off this path.)
- **Informational-only** intakes are declined at the gate (§2).

---

## 6. MVP stubs (detected, never faked)

| Capability | MVP behavior |
|---|---|
| DNC verification | operator-attested checkboxes (manual registry lookup); no attestation → `unverified = true`, 0 points, flagged unknown |
| Recipient timezone | not needed — screenshot timestamp treated as local |
| Debt-collection track | only Screen 02 text follow-up; routed + parked, not scored |
| Repeat-offender list | not used in screening (see scoring-spec §Willfulness) |
