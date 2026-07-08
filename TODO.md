# TODO

Backlog for the defendant-identification / company-research flow. This is a
planning document — each item carries its own **Status** line.

---

## 1. Always do a Florida cross-lookup when the company is registered elsewhere

**Status:** Implemented. The identification route runs an additional Florida
`sos_lookup` for every confirmed non-Florida entity, dedupes per (legal name,
state) so the home and Florida foreign registrations are both kept, prefers the
Florida registered agent for service, and skips a redundant lookup when the
company is already a Florida entity (see `app/api/defendant-identification/route.ts`).

Original note retained for history:

Right now the `sos_lookup` agent only retries other states when the first state
returns *no match*. Once it finds the company (e.g. in California), it stops — it
never also checks Florida.

**What we want:** when we confirm a company in a non-Florida state, do an
*additional* `sos_lookup` in Florida for the same legal name, so we capture **both**
records:
- the home/domestic registration (legal name, state of formation, principal/mailing
  address), and
- the Florida **foreign registration**, if it exists — because that gives us the
  Florida registered agent, who is cheaper for us to serve even when the company is
  incorporated elsewhere.

**Why it matters:** serving the Florida agent is the firm's preference. A CA company
doing business in FL almost always has a FL registered agent on file in Sunbiz; we
should surface it.

**Gotchas to handle:**
- The route currently **dedupes** found entities by name across states (keeps one,
  prefers Active). That would collapse the CA record and the FL record into one and
  throw the FL agent away. Dedupe needs to become per-(name, state) so we keep both.
- The UI/candidate shape needs to show more than one official record per company
  (e.g. "Home registration" + "Florida registration"), and the registered-agent
  selection should prefer the Florida agent → else state of formation → else HQ state.
- Don't bill a redundant FL lookup when the company is already a Florida entity.

---

## 2. Attach the originating evidence (audio + images) to the company card

**Status:** Implemented. The agent now attributes each company to the exact
originating file(s) (`evidence_files` on the candidate); the company card and the
download manifest show only that company's evidence, falling back to all case
files (with a note) when nothing could be attributed.

When the agent identifies a company, the result is shown in the "Identified
companies" dropdown with no link back to the evidence it came from. If we find a
company, we currently can't tell *which screenshot / voicemail* produced it.

**What we want:** show the case's audio and image files **on the company card**, so
the proof and the identified company live in the same place.

**Why it matters:** the evidence (voicemail / SMS screenshot) is what substantiates
the violation against that specific company. Reviewers need proof + defendant
together to sign off.

**Notes:**
- The candidate already knows its originating case (`caseId` / `caseName` in the
  aggregated dropdown). We can pull that case's files and render thumbnails (reuse
  the existing `FileThumbnail` / `FileModal`).
- Keep the transcription/description text accessible too, not just the raw file.

---

## 3. Download everything for a found company as a single bundle (zip)

**Status:** Implemented (client-side zip via `fflate`). Per-company "Download" on
each company card produces `<company>.zip`, and a case-level "Download all" in the
case header produces `<case>.zip`. In the case zip each company gets its own
`companies/<slug>/` folder holding its manifest, summary, and the evidence
attributed to it; evidence tied to no company goes in an `Unattributed Evidence/`
folder. Each zip carries `manifest.json` (machine-readable, maps onto the future
DB record) and `summary.txt` (human-readable handoff). Stopgap until the database
lands.

We have no database yet, so found results only live in the browser session. We need
a way to export everything tied to a company so it can be filed/handed off.

**What we want:** a "Download" action on a found company that produces a single
bundle (e.g. a `.zip`) containing:
- the original audio file(s) and image screenshot(s),
- their transcriptions / descriptions,
- the TCPA evaluation (score, category, reasoning),
- the identified company info (web enrichment: website, goods/services, solvability,
  sources, notes),
- the full SOS record(s) (legal name, state of formation, principal/mailing
  addresses, registered agent + address, officers, EIN, filing URL) — including the
  Florida cross-lookup record from item #1 once that exists.

**Why it matters:** it's the interim handoff/archive mechanism before the database
exists — one self-contained package per company with proof + all research.

**Notes:**
- Consider a manifest (JSON or a readable summary) inside the zip alongside the raw
  files so the bundle is self-describing.
- Design the export shape so it maps cleanly onto the future database record (so the
  eventual DB migration is straightforward).

---

## 4. Audio forensic analysis (automated / pre-recorded voicemail detection)

**Status:** Implemented. Each audio file is analyzed (after transcription, in
parallel with the rest of the pipeline) by `/api/audio-forensics` — Gemini 2.5-pro
reads the actual audio and returns a structured `AudioForensics` report
(automated likelihood 0–10, is-pre-recorded conclusion, technical factors,
personalization analysis for dynamic insertion / AI cloning). Shown in the file
modal (+ a likelihood badge on the audio thumbnail) and included in every
download: structured in `manifest.json`, appended in full under each recording in
`summary.txt`, and as a standalone per-recording `<file> — Forensic Analysis.txt`
next to the audio. Per-company docs in the case bundle are scoped to that
company's evidence; the case-wide TCPA evaluation lives only in the root (kept in
a standalone single-company download, which has no root).

---

## 5. Prior-defendant check against the GHL "Defendants" custom object

**Status:** Not started. The GHL API access is validated (branch `ghl-integration`);
the temporary test page at `/ghl-test` proves the fetch works end-to-end.

The firm keeps every company it has already sued in a GoHighLevel **custom object**
called Defendants. When the agent identifies a company, it should check that list
and **flag the company card** when it's a prior defendant.

**What we want:** after the agent confirms a company (post SOS-lookup, when we have
the legal name), search the Defendants object and, on a match, set a flag on the
candidate (e.g. `prior_defendant: true` + the matched record) rendered as a clear
badge on the company card — "we already sued this company, don't file again."

**Why it matters:** we don't want to sue the same company twice. Today that check
is manual memory; this makes it automatic on every investigation.

**How to fetch** (the `/ghl-test` page + `app/api/ghl-test/route.ts` proxy are
temporary and will be removed — these examples are the durable reference):

Env: `GO_HIGH_LEVEL_TOKEN` (Private Integration token) and
`GO_HIGH_LEVEL_LOCATION_ID`, both already in `.env`.

```bash
# Search Defendants records by (fuzzy) name — POST, note the JSON body
curl -X POST "https://services.leadconnectorhq.com/objects/custom_objects.defendants/records/search" \
  -H "Authorization: Bearer $GO_HIGH_LEVEL_TOKEN" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{
    "locationId": "'$GO_HIGH_LEVEL_LOCATION_ID'",
    "page": 1,
    "pageLimit": 20,
    "query": "Sunshine Marketing"
  }'
```

```ts
// Same call from server-side TypeScript
const res = await fetch(
  "https://services.leadconnectorhq.com/objects/custom_objects.defendants/records/search",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GO_HIGH_LEVEL_TOKEN}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      locationId: process.env.GO_HIGH_LEVEL_LOCATION_ID,
      page: 1,
      pageLimit: 20,
      query: legalName, // free-text over the object's searchable properties
    }),
  },
);
```

Related endpoints (all `GET`, same auth headers, no body):
- `/objects/?locationId={locationId}` — list object schemas (source of truth for
  the `custom_objects.defendants` key and its `searchableProperties`)
- `/objects/custom_objects.defendants/records/{id}` — one record

**Gotchas to handle:**
- `query` is free-text over the object's **searchable properties** — make sure the
  defendant-name field is marked searchable in the GHL schema, or name queries
  return nothing.
- Company names never match byte-for-byte ("Sunshine Marketing, LLC" vs "Sunshine
  Marketing Inc"). Query with the confirmed legal name, then judge the returned
  candidates with the same suffix-stripping normalizer the identification route
  already uses (`normalizeName` / `namesMatch` in
  `app/api/defendant-identification/route.ts`).
- The Private Integration needs the **Objects — Read** scopes
  (`objects/schema.readonly`, `objects/record.readonly`).
- Check should run per confirmed candidate (including synthesized-from-SOS ones),
  and a lookup failure must not sink the investigation — flag as "check failed",
  don't block.

---

## 6. DNC (Do-Not-Call) registry lookup as agent enrichment

**Status:** Not started — implementation (and API provider) yet to be decided.

**What we want:** during enrichment, check the consumer's phone number against the
National Do-Not-Call registry and surface the result on the case/company.

**Why it matters:** calls/texts to a number on the DNC registry are a separate
TCPA violation track (47 CFR § 64.1200(c)) — a registered number materially
strengthens the case and should feed the screens/scorecard, not just be a note.

**Open questions:**
- Which API? The official registry (telemarketer side) vs third-party lookup
  services (e.g. reputation/compliance APIs) — pricing, terms, and whether
  registration *date* is available (we need "was it registered at the time of the
  call", not just "is it registered today").
- Where it hooks in: alongside the SOS/enrichment pass in defendant
  identification, or earlier at extraction time when the consumer's number is
  first known.
- The consumer's own number must be reliably extractable from the evidence first
  (it usually appears in screenshots/voicemail metadata; today extraction focuses
  on the *sender*).

---

## 7. Webhook-driven investigations from the GHL pipeline (cards in/out)

**Status:** Not started. Design below is validated against the API on the
`ghl-integration` branch, but nothing is implemented.

**What we want:** when a card (opportunity) is moved into the **"Ready for AI
investigation"** column in GHL, a webhook triggers the agent automatically. When
the investigation finishes:
- create **N new cards** — one per company found — carrying the investigation
  result, and
- **delete or move** the original card (decide which; move-to-an-"Investigated"
  stage is safer/auditable than delete),
- place the new cards in the correct column for the outcome (e.g. by score band).

**Why it matters:** removes the manual upload flow entirely — intake drops a card
in a column, investigated companies come out as cards, one card per defendant.

**Building blocks (already validated):**
- **Trigger:** Private Integrations can't subscribe to app webhook events
  (`OpportunityStageUpdate` needs a Marketplace App). Use a GHL **Workflow**
  instead: trigger "Pipeline Stage Changed" filtered to the "Ready for AI
  investigation" stage → **Custom Webhook** action POSTing the opportunity id to
  our endpoint (e.g. `/api/ghl-intake`).
- **Fetch the evidence:** `GET /opportunities/{id}` → `customFields` file arrays
  hold the uploaded screenshots/audio. The `msgsndr-private.storage.googleapis.com`
  URLs download with a plain unauthenticated GET (verified). Route each file by
  `meta.mimetype` (`image/*` / `audio/*`).
- **Run the existing pipeline server-side:** description/transcription →
  extract-screen → defendant-identification (the long-running job pattern the
  route already uses fits a webhook: ack fast, work in background). AMR audio
  decode currently happens client-side (`lib/audio.ts`) and needs a server port.
- **Create result cards:** `POST /opportunities/` with `locationId`, `pipelineId`,
  `pipelineStageId` (target column), `contactId` (from the original card), name =
  company, monetaryValue, and custom fields for score/flags. Stage ids come from
  `GET /opportunities/pipelines?locationId=…`.
- **Move/close the original:** `PUT /opportunities/{id}` with the new
  `pipelineStageId` (or `DELETE /opportunities/{id}` if we really want deletion).

**Gotchas to handle:**
- **Idempotency:** workflows can re-fire (card dragged out and back in, workflow
  re-published). Key runs on opportunity id + stage-entry timestamp so we never
  double-investigate or double-create cards.
- **Zero companies found:** decide the outcome column (e.g. "Needs manual
  review") instead of silently leaving the card.
- **Auth the webhook:** the endpoint must reject calls that aren't from our
  workflow (shared secret header configured in the workflow's webhook action).
- Investigations take ~10 minutes and the job store is in-memory — a deploy/restart
  mid-run loses the job; the card must not be stranded in a "processing" state
  with no retry path.
