# TCPA Violation Evaluation Rubric

This document is the source of truth for evaluating whether an uploaded **audio** (call recording, voicemail) or **image** (screenshot of an SMS conversation, call log, etc.) contains a TCPA violation.

The AI must read this entire document before scoring any file.

For every file, the AI returns:

- A single integer **score from 0 to 10** indicating the likelihood and severity of a violation (definitions below).
- The **violation category** (or `none`).
- The **message type** (marketing, debt collection, informational, or unknown).
- A **short reasoning** citing evidence from the file.

---

## 1. Violation categories

There are four categories. The first three apply to both marketing and debt collection; the last applies to telemarketing only.

### 1.1 Pre-recorded voicemail

A voicemail whose audio is clearly **pre-recorded** (not a live human speaking to the recipient at that moment) is a TCPA violation on its own. No additional condition is required.

Signals to look for in audio:

- Generic, scripted-sounding delivery with no pauses for response.
- Identical wording that could be reused across recipients.
- No reference to the recipient's name, prior conversation, or anything personal.
- Audio that begins mid-sentence or has the cadence of a broadcast/IVR message.

### 1.2 Internal Do Not Call (IDNC) / Failure to Stop

The recipient sent an opt-out / stop request, and the company contacted them again after that.

**What counts as a stop request.** Any reasonable opt-out phrasing in a message *from the recipient*: `stop`, `no more`, `unsubscribe`, `do not text me`, `remove me`, etc. The exact word `STOP` is **not** required.

**The "one confirmation" carve-out.** The company is allowed to send **one** confirmation reply such as "You have been opted out." That confirmation does **not** count as a violation.

**The 24-hour grace window.** Apply at least a **24-hour** buffer between the stop request and any further message before calling it a violation.

**Marketing branch (TCPA):**

- After the stop request, ≥1 additional **marketing** message (text or call) more than 24 hours later → **TCPA violation**.

**Debt collection branch (not TCPA, separate pipeline):**

- After the stop request, ≥1 additional **debt-collection** contact via **any** channel (text, call, *or email*) → still a qualifying case, but it is routed to a separate (non-TCPA) pipeline. Flag it as `idnc_debt_collection`.

### 1.3 Quiet hours

Applies to **marketing or debt collection**.

- Calls or texts sent **at least 2 times** between **9:00 PM and 8:00 AM** (recipient local time) → violation.
- For marketing → TCPA violation.
- For debt collection → Florida state-law violation (not TCPA), still qualifying — flag as `quiet_hours_debt_collection`.

### 1.4 National Do Not Call Registry (NDNC)

Applies to **telemarketing only**. Debt collection does **not** qualify here.

- **Federal NDNC:** if the recipient's number is on the federal Do Not Call registry, **≥2 telemarketing texts within any 12-month window** → violation. The two messages can be far apart (e.g., December and February both count).
- **Florida DNC:** if the recipient's number is on Florida's state DNC list (or the company is in Florida and the number is on the Florida list), **even a single telemarketing text** is a violation.

> NDNC registration status must be confirmed via API — the file alone cannot prove it. If registry status is unknown, surface this in the reasoning and treat the NDNC category as **inconclusive** rather than scoring it as a violation.

---

## 2. Message-type classification

The AI must classify the content of the file before applying the rules.

### Marketing / telemarketing

The **purpose** of the message is ultimately to sell a product or service. The message itself does **not** have to contain a price or a direct sales pitch.

Examples that count as marketing:

- A "free webinar" invite where the webinar pitches a product.
- A "free consultation" invite from a service business.
- Any funnel whose endpoint is a sale.

### Debt collection

A communication attempting to collect on an alleged debt (overdue bill, loan, judgment, etc.).

### Informational

A purely informational notification with no sales or collections purpose (appointment reminders from a service the recipient is actively using, fraud alerts, two-factor codes, shipping updates, etc.).

**Informational messages do not qualify as violations** under any of the categories above.

---

## 3. Scoring rubric (0 – 10)

| Score | Meaning |
|------:|---------|
| **0** | No indication of any violation. File is informational, a single legitimate confirmation, or otherwise out of scope. |
| **1–2** | Weak signal. Mentions one of the trigger conditions but evidence is ambiguous (e.g., possibly marketing, possibly informational). |
| **3–4** | Some elements of a violation are visible but a key requirement is missing (e.g., a stop request is shown but no follow-up is in the file; quiet-hours timestamps exist but only one message is in range). |
| **5–6** | A violation is plausible. One category fits, but at least one supporting fact must be confirmed out-of-band (e.g., NDNC registry status, sender identity, recipient time zone). |
| **7–8** | A violation is likely. All elements visible in the file point to one of the four categories; only minor verification remains. |
| **9** | A violation is clearly evidenced in the file across one full category. |
| **10** | Multiple, independent violations are clearly evidenced in the file, **or** a single category is documented with overwhelming evidence (e.g., a pre-recorded voicemail that also continues after a clear stop request). |

Tie-breakers:

- If both marketing and debt collection signals are present, pick the classification that yields the higher-confidence violation and note the alternative.
- If a category is inconclusive solely because of missing external data (registry status, time zone, sender identity), do **not** invent the missing data — score it in the 1–6 band and explain what is still needed.

---

## 4. Required output shape

For each file, return a JSON object with this shape:

```json
{
  "score": 0,
  "category": "prerecorded_voicemail | idnc_failure_to_stop | idnc_debt_collection | quiet_hours | quiet_hours_debt_collection | ndnc_federal | ndnc_florida | none",
  "message_type": "marketing | debt_collection | informational | unknown",
  "needs_external_check": ["federal_ndnc_status", "florida_ndnc_status", "recipient_timezone", "sender_identity"],
  "reasoning": "Short paragraph citing the exact evidence in the file (timestamps, quoted text, audio cues) that supports the score and category."
}
```

`needs_external_check` is an array — empty when nothing external is required.

---

## 5. Quick reference

| Category | Applies to | File-only sufficient? | Trigger |
|---|---|---|---|
| Pre-recorded voicemail | All callers | Yes | A single pre-recorded voicemail |
| IDNC (failure to stop) — marketing | Marketing | Usually yes | Stop request, then ≥1 marketing message >24h later |
| IDNC (failure to stop) — debt collection | Debt collection | Usually yes | Stop request, then ≥1 debt-collection contact (any channel) |
| Quiet hours | Marketing or debt collection | Yes (need recipient time zone) | ≥2 calls/texts between 9 PM – 8 AM |
| Federal NDNC | Telemarketing only | No (registry check required) | ≥2 telemarketing texts within 12 months |
| Florida DNC | Telemarketing only | No (registry check required) | ≥1 telemarketing text |
