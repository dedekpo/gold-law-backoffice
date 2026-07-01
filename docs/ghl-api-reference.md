# GoHighLevel (HighLevel) API — Integration Reference

**Purpose:** a grounded reference for wiring the firm's GoHighLevel (HighLevel / LeadConnector)
account into this tool. The first need is to **fetch the client's phone number** from their GHL
contact so we can later run the **DNC lookup** (RealValidation) that feeds Claim-Type Tiers 2
(Florida DNC) and 4 (National DNC). See [`scoring-spec.md`](./scoring-spec.md) and
[`screening-spec.md`](./screening-spec.md).

> **Verification status.** Items marked ✅ were confirmed against HighLevel's live docs/search on
> 2026-06-30. Items marked ⚠️ are from prior knowledge and the SPA doc pages that don't render to
> plain text — **confirm against the live docs (links at the bottom) before coding them.**

---

## 0. The one thing to get right first

DNC is checked on the **consumer's** number — i.e. **our client** (the GoHighLevel contact created
from the Facebook lead form). The phone numbers inside the *evidence* (screenshots/voicemails) are
the **defendant's** and are used for identification, not DNC. So:

- **Client's number** → from the **GHL contact** → RealValidation DNC → unlocks DNC theories.
- **Defendant's number** → from the evidence → `web_search` / `sos_lookup`.

This integration is only about the **client's** number. The prerequisite is that a case in our app
carries the client's **GHL `contactId`** (or phone). Today our app has no GHL link — see §8 for how
the contactId should enter a case (manual first, webhook later).

---

## 1. API basics

| | |
|---|---|
| **Base URL** ✅ | `https://services.leadconnectorhq.com/` |
| **API generation** | v2 / "LeadConnector" (the legacy `rest.gohighlevel.com/v1` API is deprecated — do **not** build on it) |
| **Auth** ✅ | `Authorization: Bearer <token>` |
| **Version header** ✅ | `Version: 2021-07-28` (required on every v2 request) |
| **Accept** | `application/json` |
| **Content-Type** | `application/json` (on POST/PUT) |

Minimal request shape (✅ confirmed example):

```bash
curl --request GET \
  --url https://services.leadconnectorhq.com/contacts/<CONTACT_ID> \
  --header 'Accept: application/json' \
  --header 'Authorization: Bearer <PRIVATE_INTEGRATION_TOKEN>' \
  --header 'Version: 2021-07-28'
```

---

## 2. Authentication — Private Integration Token (recommended)

For a server-side, single-account integration like ours, use a **Private Integration Token (PIT)**
rather than the full OAuth marketplace-app flow. ✅

- It's a **static, scoped access token** that behaves like a fixed OAuth2 access token — it does
  **not** auto-refresh or expire daily (unlike OAuth tokens). ✅
- **Create it** in the GHL UI: Settings → "Private Integrations" → *Create new Integration* → name
  it → select scopes → copy the token. (Available at agency and sub-account/location level.) ✅
- **Rotation:** HighLevel recommends rotating every **90 days**. A rotation gives a **7-day overlap
  window** where both old and new tokens work; you can also "rotate and expire now" if compromised. ✅

**Scopes we need** ✅ (select only these — least privilege):
- `contacts.readonly` — read contact details (the phone number).
- `locations.readonly` — ⚠️ likely needed if we resolve/validate the location; confirm.

> **OAuth alternative:** only needed if this ever becomes a multi-account Marketplace app. Skip for
> now — a PIT is simpler and sufficient for one firm account.

**Secrets handling:** store the token in env, never in git (mirror `lib/provider.ts`). Suggested:
`GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID`, optional `GHL_API_BASE` (default the base URL above).

---

## 3. Key endpoints

### 3.1 Get a single contact (primary) ✅
```
GET /contacts/{contactId}
```
Returns the full contact. This is the main call once we have a `contactId` (from a webhook or
manual entry). The phone lives on the `phone` field.

### 3.2 Search contacts ⚠️
```
POST /contacts/search
```
The advanced-filter search. **The older `GET /contacts/` list endpoint is deprecated — use Search
Contacts instead.** ✅ Use this when we have a phone/email but not a `contactId`. The request body
takes `locationId` plus a `filters` array; exact filter schema for matching on phone/email is **not
confirmed here — verify the request body** in the live docs (§ Sources). Typical shape (⚠️ illustrative):

```jsonc
POST /contacts/search
{
  "locationId": "<LOCATION_ID>",
  "page": 1,
  "pageLimit": 20,
  "filters": [
    { "field": "phone", "operator": "eq", "value": "+13055550199" }
  ]
}
```

### 3.3 Duplicate lookup (phone/email → contact) ⚠️
```
GET /contacts/search/duplicate?locationId={id}&number={phone}
```
A lightweight "does a contact already exist for this phone/email" lookup that returns the matching
contact. Ideal for resolving a phone to a contact without paging search results. **Confirm the exact
path and query params** (`number` vs `phone`, `email`) before use.

### 3.4 Contact object — fields we care about ⚠️
Confirm names against the live response, but expect roughly:

| Field | Notes |
|---|---|
| `id` | the `contactId` |
| `locationId` | sub-account the contact belongs to |
| `phone` | **the number we need** — E.164 (`+1XXXXXXXXXX`) when set |
| `email` | secondary DNC/identity key |
| `firstName` / `lastName` / `name` | client name |
| `country` | e.g. `US` |
| `timezone` | ⚠️ if present, could later refine quiet-hours (we currently use the screenshot's local timestamp — see screening-spec §4; do **not** change that without a decision) |
| `state` / `city` / `address1` / `postalCode` | client location — relevant to the Florida-nexus / FL DNC logic |
| `dateAdded` | when the lead came in |
| `tags`, `source`, `customFields` | lead routing / provenance |

---

## 4. Rate limits ✅

Per Marketplace app (client) **per resource** (Location or Company):
- **Burst:** 100 requests / 10 seconds.
- **Daily:** 200,000 requests / day.

Response headers to read for backoff:
`X-RateLimit-Max`, `X-RateLimit-Remaining`, `X-RateLimit-Interval-Milliseconds`,
`X-RateLimit-Limit-Daily`, `X-RateLimit-Daily-Remaining`.

> Our usage is tiny (one contact fetch per intake), so limits aren't a concern — but mirror the
> existing rate-limit middleware (`lib/rate-limit.ts`) so a `429` is handled gracefully.

---

## 5. Errors & retries

- `401` — bad/expired token (or PIT rotated past its 7-day overlap) → surface a clear "reconnect GHL"
  error; don't retry blindly.
- `404` — unknown `contactId` / wrong location.
- `422` — bad request body (search filters).
- `429` — rate limited → back off using the `X-RateLimit-*` headers.
- Treat the phone fetch as **best-effort**: if GHL is unreachable, the case should still screen,
  identify, and TCPA-score — only the DNC theories stay unverified (exactly the MVP behavior). Never
  let a GHL outage block the pipeline.

---

## 6. Proposed implementation in this codebase

Keep it **deterministic backend code — not an agent tool, not an MCP** (a contactId→phone fetch has
nothing to reason about; the LLM should never touch it):

```
lib/ghl.ts
  getContact(contactId): Promise<{ phone, email, state, country, timezone, ... } | null>
  // thin wrapper: base URL + Bearer PIT + Version header; parses the fields in §3.4.
```

The result flows as a **structured fact** into the future DNC step (`lib/dnc.ts`, RealValidation),
whose boolean result feeds the deterministic scoring engine — the same way SOS records already do.
No change to the scoring engine's shape: it already leaves the DNC slot open (`scoring-spec §7`).

---

## 7. Webhooks (future — the automated intake path)

The end state: a GHL workflow/app **webhook** fires when a lead submits the Facebook form, POSTing
to an endpoint in our app that creates the case and pulls the contact (phone). ⚠️ Confirm the exact
event names and payload schema (e.g. `ContactCreate`, inbound-message events) and whether we use an
**App webhook** vs a **Workflow → Webhook** action. Until then, use the manual path (§8).

---

## 8. How a case gets its GHL contact (decision needed)

- **Manual (ship first):** the intaker pastes the GHL `contactId` (or the client's phone) when
  creating a case. Minimal work; unblocks DNC scoring without the webhook pipeline.
- **Automated (end state):** GHL webhook creates the case and supplies the `contactId` (§7).

Recommendation: **manual now, webhook later.**

---

## 9. Open questions to confirm with the firm / live docs

1. Which **account level** issues the PIT — agency or the specific **sub-account/location** the
   intake leads live in? (Determines `GHL_LOCATION_ID` and scope level.)
2. Exact **Search Contacts** request body and the **duplicate-lookup** params (§3.2–3.3).
3. Confirm the **contact field names** (§3.4), especially `phone` format and whether `state`/
   `timezone` are reliably populated.
4. Do leads carry the evidence (or a link to it) in **custom fields** we should read?
5. Webhook event names + payloads for the automated path (§7).

---

## Sources

- [HighLevel API Developer Portal](https://marketplace.gohighlevel.com/docs/)
- [Private Integrations token](https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/)
- [Scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/index.html)
- [Get Contacts (deprecated list)](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contacts/index.html)
- [Search Contacts (advanced)](https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced/index.html)
- [Create Contact (object fields reference)](https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact/index.html)
- [Private Integrations — everything you need to know](https://help.gohighlevel.com/support/solutions/articles/155000003054-private-integrations-everything-you-need-to-know)
- [Rate limits / OAuth FAQs](https://marketplace.gohighlevel.com/docs/oauth/Faqs/index.html)
