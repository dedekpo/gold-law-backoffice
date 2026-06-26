# TODO

Backlog for the defendant-identification / company-research flow. Nothing here is
implemented yet — this is a planning document.

---

## 1. Always do a Florida cross-lookup when the company is registered elsewhere

**Status:** Not implemented today.

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
case header produces `<case>.zip` (every company + all evidence + per-company
subfolders). Each zip carries `manifest.json` (machine-readable, maps onto the
future DB record) and `summary.txt` (human-readable handoff), plus the raw
evidence under `evidence/`. Stopgap until the database lands.

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
