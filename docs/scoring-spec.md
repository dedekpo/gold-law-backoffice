# Scoring Spec — TCPA IQ Case-Value Engine (0–100)

**Status:** source of truth for the case-value score. Implemented by `lib/scoring/`
(**pure, deterministic TypeScript** — no LLM, no network). Derived from the firm's
`TCPA IQ - Scoring Rubric`.

Companion doc: [`screening-spec.md`](./screening-spec.md) (gating, classification, the four screens).

> **The score is arithmetic, not a guess.** The LLM only extracts structured facts and the
> screening engine only decides which screens hit. This engine then *computes* the score from
> those inputs with fixed point tables. The same inputs always produce the same score.

---

## 0. Scoring unit & preconditions

- Scored **per company** (per potential lawsuit), **not** per upload batch. One intake → N
  scorecards.
- Only **TCPA-track** companies are scored here. Debt-collection-track companies are parked
  (see screening-spec §5).
- There is **no "can't ID" path** in scoring: if no defendant was identified, the pipeline
  exited earlier and this engine never runs. Every scored company is an identified entity.

---

## 1. Computation order

1. **Auto-decline (kill conditions).** If any kill condition is true → output `DECLINE`, stop.
   No score is produced. (§2)
2. **Additive score.** Sum the six factors → `raw` (0–100). (§3)
3. **Apply cap.** `final = min(raw, shellCap?)` — the shell cap is the only cap. (§4)
4. **Map to band** and emit the scorecard (breakdown + flagged unknowns). (§5–6)

---

## 2. Auto-decline (kill conditions, checked before scoring)

If either is true, the company is **declined** (no score):

- **Job / employment scam.**
- **True healthcare services.** Note the carve-out: **medical *device marketing* is NOT
  healthcare** — it stays viable. Only genuine healthcare *services* kill the case.

Source: extraction `killSignal` per the company's evidence.

---

## 3. The six factors (sum to 100)

| # | Factor | Max |
|---|---|---|
| 1 | Claim Type | 24 |
| 2 | Collectability | 24 |
| 3 | Willfulness / Treble | 18 |
| 4 | Violation Volume | 16 |
| 5 | Identifiability / Forum | 10 |
| 6 | Defensibility (consent/revocation) | 8 |

### 3.1 Claim Type — 24 max

Base = the **highest theory present** (from the four screens):

| Tier | Theory | Base | MVP |
|---|---|---|---|
| Tier 1 | Prerecorded/artificial voice · Internal DNC (64.1200(d)) | 18 | live (Screens 01, 02-marketing) |
| Tier 2 | Florida DNC / FTSA | 13 | **0 — DNC unverified, flagged** |
| Tier 3 | Quiet hours | 9 | live (Screen 03) |
| Tier 4 | National DNC registry | 7 | **0 — DNC unverified, flagged** |

**Stacking add-on** (over *distinct verified* theories present): **+3** for a 2nd, **+6** for 3+.
**Caps at 24.**

- MVP: Tiers 2 and 4 are unverified, so they contribute neither base nor a distinct theory for
  stacking; they only add a flagged unknown ("DNC status unverified — could raise score").
- "Distinct theory" = a distinct screen hit. Screens 01 and 02 both map to Tier 1 but are
  **distinct theories** for stacking (prerecorded voice vs. failure-to-stop are separate claims).

### 3.2 Collectability — 24 max

Base by employee profile (from enrichment):

| Profile | Base |
|---|---|
| 50+ employees | 18 |
| 11–50 employees | 13 |
| <10 employees (real/collectable) | 6 |
| no signal | 0 |

**Add-on:** **+6** for verified **$10M+ revenue OR confirmed public company**. **Caps at 24.**

### 3.3 Willfulness / Treble — 18 max — **highest single value applies (not additive)**

| Fact pattern | Points | MVP |
|---|---|---|
| Known repeat offender (prior TCPA settlement/judgment, did it again) | 18 | **not scored** (no firm list yet; hook left) |
| Kept contacting after a visible "STOP" | 12 | live (Screen 02 hit) |
| Contact to a National DNC–registered number | 6 | **dropped** (decision) |
| None visible | 0 | — |

**High-volume bonus (config, default OFF):** when `HIGH_VOLUME_WILLFULNESS.enabled` and the
company's volume ≥ `HIGH_VOLUME_WILLFULNESS.threshold` (default **10**), add **+6** to the
willfulness value, **capped at the 18 max**. This is an *additive* bonus on top of the highest
single value (a deliberate, documented deviation from "highest single applies"). Default OFF, so
MVP willfulness is effectively **12 (STOP ignored) or 0**.

### 3.4 Violation Volume — 16 max

Count of contacts attributable to **this company** (in-window):

| Contacts | Points |
|---|---|
| 10+ | 16 |
| 5–9 | 11 |
| 3–4 | 7 |
| 1–2 | 3 |
| 0 | 0 |

### 3.5 Identifiability / Forum — 10 max

From the SOS record + Florida cross-lookup:

| Situation | Points |
|---|---|
| Entity identified + suable in client's forum (FL nexus, or registered/serviceable in FL) | 10 |
| Entity identified, out-of-state but reachable (foreign registration / known HQ) | 6 |
| Identified but forum friction (generic registered agent only, no FL nexus, minimal footprint) | 3 |

(No "cannot ID" row — that path exits before scoring.)

### 3.6 Defensibility (consent / revocation) — 8 max

From extraction's consent posture:

| Posture | Points |
|---|---|
| Clean cold contact, no plausible consent | 8 |
| Ambiguous — some prior contact, consent unclear | 4 |
| Evidence of prior consent / established business relationship | 0 |

---

## 4. Cap (applied after the additive score)

**Uncollectable shell — convergent profile only.** If **all three** are true →
**cap `final` at 50**:

1. 1–2 employees, **AND**
2. no Secretary of State registration, **AND**
3. sub-$1M revenue.

All three required. One alone just scores low in Collectability; it does **not** cap. This is the
**only** cap. A perfect claim against a shell still lands in **Marginal** (low enough to flag as
not-a-standard-pursuit, high enough never to auto-reject — a monetization candidate).

---

## 5. Bands

| Score | Band | Meaning |
|---|---|---|
| 80–100 | **Priority** | pursue now (whale individual or class candidate) |
| 60–79 | **Solid** | standard intake |
| 40–59 | **Marginal** | only if cheap to develop, a volume play, or a monetization candidate |
| <40 | **Pass** | |

---

## 6. Scorecard output

Per company (mirrors the rubric's scorecard):

```
TCPA IQ SCORECARD — <Defendant legal name>
SCORE: <final> / 100 → BAND: <band>

SCORED FROM EVIDENCE
  Claim Type ........ <pts>/24  <basis>
  Collectability .... <pts>/24  <basis>
  Willfulness ....... <pts>/18  <basis>
  Volume ............ <pts>/16  <basis>
  Identifiability ... <pts>/10  <basis>
  Defensibility ..... <pts>/8   <basis>

CAP CHECK:   <not a shell — no cap | SHELL CAP — capped at 50 (raw was <raw>)>
KILL CHECKS: <passed | DECLINE — <reason>>

⚠ NEEDS INTAKE TO CONFIRM (could move the score)
  • <flagged unknowns…>
```

Structured shape (`Scorecard`): `{ factors: ScoreFactor[], raw, capApplied, final, band,
killCheck, unknowns: string[] }` where `ScoreFactor = { name, points, max, basis }`.

### Flagged unknowns assembled in MVP
- DNC tiers unverified (when Screen 04 applicable) → "DNC status unverified — could raise Claim Type."
- Full volume — "client may have more contacts than the evidence shows" (raises Volume).
- Consent history — "confirm no prior business relationship" (lowers Defensibility if found).

(Repeat-offender is **not** flagged in MVP per the locked decision.)

---

## 7. MVP stubs (slot left open, never faked)

| Input | MVP | Future |
|---|---|---|
| Claim Tiers 2 & 4 (DNC) | 0 points, flagged | award on verified DNC |
| Willfulness repeat-offender (18) | not scored | firm list / GHL |
| Willfulness high-volume (+6) | toggle OFF, threshold 10 | flip on if desired |

---

## 8. Worked example (regression target)

The rubric's own example must reproduce exactly (verified, non-MVP-stubbed inputs):

- Claim Type 18/24 — Tier 1 prerecorded + a 2nd distinct theory (×2 stack +3 → would be 21; the
  rubric shows 18 for Tier1+Tier4 where Tier 4 is DNC). **Note:** the published example mixes a
  DNC theory; the engine's unit test will encode the example with explicitly *verified* theories
  so the arithmetic (18 base + stacking, capped at 24) is asserted deterministically rather than
  depending on DNC. Target total **73 → Solid** with: Claim 18, Collectability 19, Willfulness 12,
  Volume 7, Identifiability 10, Defensibility 7.
