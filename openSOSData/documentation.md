API Documentation
Complete reference for the OpenSOSData REST API

Authentication
All authenticated endpoints require your API key in the x-api-key header.

x-api-key: osd_8628777d...
Base URL: https://api.opensosdata.com

POST/v1/lookup
Look up a business entity by name and state. Returns formation details, registered agent, principal address, officers, and filing URL.

Cost: $0.0314 per lookup

Request Body
Field Type Required Description
entity_name string Yes Business name to search (2-200 chars)
state string Yes Two-letter state code (e.g. DE, CA, FL)
searchType string No business_entity (default) or ucc
Query Parameters
Param Type Description
fresh boolean Legacy parameter — all lookups now return fresh data by default
Request Body
Field Type Required Description
entity_name string Yes Name to search. Searches debtor by default; set searchBy to secured_party to search by secured party instead.
state string Yes Two-letter state code (e.g. CO, FL, MA)
searchType string Yes Must be ucc
searchBy string No Set to secured_party to search by secured party name instead of debtor. Supported states: AL, CA, CO, CT, FL, ID, KY, MA, MT, NC, RI
dateAfter string No Return only filings filed after this date. Format: YYYY-MM-DD. Supported states: CO, CA, ID, MT
dateBefore string No Return only filings filed before this date. Format: YYYY-MM-DD. Supported states: CO, CA, ID, MT
Note: Some states (AL, CA, ID, KY, MT, NC) use a workaround for secured party search — results may be limited if the secured party name doesn't also appear as a debtor entity in that state's index. States with native secured party search (CO, CT, FL, MA, RI) do not have this limitation.

Example Request
curl -X POST https://api.opensosdata.com/v1/lookup \
 -H "x-api-key: osd_8628777d..." \
 -H "Content-Type: application/json" \
 -d '{"entity_name":"Apple Inc","state":"DE"}'
Example Response 200
{
"success": true,
"data": {
"entityName": "APPLE INC.",
"entityType": "Corporation",
"entityId": "3284652",
"status": "Good Standing",
"formationDate": "01/03/1977",
"registeredAgentName": "CORPORATION TRUST COMPANY",
"registeredAgentAddress": "1209 ORANGE ST",
"registeredAgentCity": "WILMINGTON",
"registeredAgentState": "DE",
"registeredAgentZip": "19801",
"officers": [
{ "name": "TIM COOK", "title": "CEO" }
],
"sosUrl": "https://icis.corp.delaware.gov/...",
"scrapedAt": "2026-05-06T08:00:00.000Z"
},
"cost": 0.0314,
"state_scraper_version": "3.0",
"scraper_built_at": "2026-04-01T00:00:00.000Z"
}
Error Responses
Status Body Cause
401 {"error":"Missing or invalid API key"} No x-api-key header or key is revoked
400 {"error":"Invalid request body"} Missing fields or invalid state code
404 {"success":false,"error":"Entity not found","cost":0} No match on that state's SOS site (not billed)
202Async Lookups
Some states require CAPTCHAs or multi-step scraping. When the lookup cannot complete immediately, the API returns 202 Accepted with a jobId. Poll for the result using the status endpoint.

202 Response
{
"success": true,
"async": true,
"jobId": "clx1abc2def3ghi4jkl",
"message": "Lookup queued. Poll GET /v1/lookup/status/{jobId} for result.",
"pollInterval": 3000,
"estimatedSeconds": 60
}
GET/v1/lookup/status/:jobId
Poll this endpoint until status is complete or failed. Recommended interval: 3 seconds.

curl https://api.opensosdata.com/v1/lookup/status/clx1abc2def3ghi4jkl \
 -H "x-api-key: osd_8628777d..."
Polling Responses
Status Meaning Action
pending / processing Lookup still running Wait pollInterval ms, then retry
complete Result ready in result field Read result — same shape as a 200 response
failed Scraper error Check error field for details
POST/v1/lookup (UCC)
Search UCC (Uniform Commercial Code) filings by debtor name. Returns lien records including secured parties, collateral descriptions, and filing dates.

Cost: $0.0314 per lookup • Same endpoint, different searchType

Example Request
curl -X POST https://api.opensosdata.com/v1/lookup \
 -H "x-api-key: osd_8628777d..." \
 -H "Content-Type: application/json" \
 -d '{"entity_name":"Subway","state":"FL","searchType":"ucc"}'
With optional date filters and secured party search (CO example):

curl -X POST https://api.opensosdata.com/v1/lookup \
 -H "x-api-key: osd_8628777d..."\
 -H "Content-Type: application/json"\
 -d '{"entity_name":"Wells Fargo","state":"CO","searchType":"ucc","searchBy":"secured_party","dateAfter":"2023-01-01","dateBefore":"2024-12-31"}'
Example Response 200
{
"success": true,
"data": {
"filings": [
{
"fileNumber": "202300012345",
"fileDate": "2023-06-15",
"debtorName": "SUBWAY REAL ESTATE LLC",
"securedParty": "BANK OF AMERICA NA",
"collateral": "All assets and proceeds...",
"status": "Active",
"lapseDate": "2028-06-15"
}
],
"totalResults": 3
},
"cost": 0.0314
}
UCC search is available in most states. Check GET /v1/states for the uccAvailable field.

GET/v1/states
List all 50 states with their scraper status, version, and availability. No authentication required.

Example Request
curl https://api.opensosdata.com/v1/states
Example Response 200
[
{
"state": "AL",
"status": "active",
"version": "3.0",
"lastTestedAt": "2026-04-21T02:11:39.000Z",
"available": true,
"uccAvailable": true
},
{
"state": "AK",
"status": "active",
"version": "3.2",
"lastTestedAt": "2026-04-11T07:43:03.133Z",
"available": true,
"uccAvailable": true
},
...
]
Response Fields
Field Type Description
state string Two-letter state code
status string active, degraded, or inactive
version string Current scraper version
lastTestedAt datetime Last successful automated test
available boolean Whether business entity lookups work
uccAvailable boolean Whether UCC searches are supported
GET/v1/health
Service health check. Returns status of internal systems. No authentication required.

Example Request
curl https://api.opensosdata.com/v1/health
Example Response 200
{
"status": "healthy",
"checks": {
"redis": "ok",
"postgres": "ok",
"degraded_scrapers": 0,
"lookups_today": 147,
"cache_hit_rate_pct": 6.8
},
"timestamp": "2026-05-06T08:58:10.368Z"
}
Response Fields
Field Description
status healthy or degraded
checks.redis Cache layer status
checks.postgres Database status
checks.degraded_scrapers Number of scrapers currently failing
checks.lookups_today Total lookups processed today
checks.cache_hit_rate_pct Percentage of lookups served from cache
POST/v1/name-availability
Check whether a business name is available to register in a given US state or territory. Returns an availability verdict plus up to 10 conflicting entity matches. Always hits the live portal — cache is bypassed. Charges one lookup credit per search.

Cost: $0.0314 per search

Request Body
Field Type Required Description
entity_name string Yes Business name to check
state string Yes 2-letter state/territory code (e.g. DE, CA, NY)
Example Request
curl -X POST https://api.opensosdata.com/v1/name-availability \
 -H "x-api-key: osd_8628777d..." \
 -H "Content-Type: application/json" \
 -d '{"entity_name":"Acme Ventures LLC","state":"DE"}'
Example Response 200
{
"success": true,
"available": false,
"searchedName": "Acme Ventures LLC",
"state": "DE",
"conflictingEntities": [
{
"entityName": "ACME VENTURES LLC",
"entityId": "7654321",
"status": "Active",
"statusClass": "active",
"sosUrl": "https://icis.corp.delaware.gov/...",
"entityPageUrl": "/entity/delaware/acme-ventures-llc-de-765/"
}
],
"cost": 0.0314,
"data_source": "live",
"walletBalance": "28.45",
"lookupsRemaining": 906
}
Optional Response Fields
Field Description
variationNote Note about name variation matching used by the state portal
warning Advisory message (e.g. partial results)
statusNote Additional status context from the portal
Supported in all 53 US jurisdictions — same as entity search. See GET /v1/states for availability.

GET/v1/account/balance
Check your current account balance and remaining lookups. Requires authentication.

Example Request
curl https://api.opensosdata.com/v1/account/balance \
 -H "x-api-key: osd_8628777d..."
Example Response 200
{
"success": true,
"type": "user",
"balanceStored": 31400,
"balanceDisplay": "$3.14",
"lookupsRemaining": 100,
"pricePerLookup": 0.0314,
"topUpUrl": "https://app.opensosdata.com#billing"
}
Response Fields
Field Type Description
type string user (wallet account) or internal (no wallet limit)
balanceStored integer Balance in stored units (cents × 100)
balanceDisplay string Human-readable balance (e.g. "$3.14")
lookupsRemaining integer Number of lookups your balance covers
pricePerLookup number Current price per lookup ($0.0314)
topUpUrl string URL to add credits
CACHEDCached Data Lookups
If you have a Cached Data subscription, you can serve entity data instantly from our pre-indexed database of 23M+ entities.

Request
POST /v1/lookup
{
"entity_name": "Walmart Inc",
"state": "FL",
"source": "cache"
}
Source Options
Value Behavior
"auto" (default) Uses your account preference. If you have a cached subscription with cacheFirstDefault enabled, serves from cache when available.
"cache" Always serve from cached data. Falls through to live scrape if no cached record exists.
"live" Always do a live scrape from the state portal. Costs standard lookup credits.
Response Fields (Cached)
{
"success": true,
"source": "cache",
"stale": false,
"cached": true,
"dataAsOf": "2026-05-15T...",
"entity": { ... }
}
Field Type Description
source string "cache" or "live"
stale boolean true if data exceeds your freshness threshold
cached boolean true when served from cache
dataAsOf datetime When the cached data was last scraped
overage boolean true if this lookup exceeded your monthly quota
Freshness Settings
Configure via PATCH /user/billing/settings:

{
"maxCacheAgeMonths": 6,
"cacheFirstDefault": true
}
Field Type Description
maxCacheAgeMonths integer (1–24) Cached data older than this triggers a live scrape if you have credits
cacheFirstDefault boolean When true, source defaults to cache
Quota & Overage
Each plan includes a monthly cached lookup quota
When quota is exhausted, cached lookups continue but are charged from your PAYG credit balance at your subscription rate
When credits are also exhausted, stale data is served with stale: true
POST/v1/bulk-lookup
Submit up to 1,000 entities in one request. Results are delivered via polling, webhook, or email.

Request Body
POST /v1/bulk-lookup
{
"entities": [
{ "entity_name": "Dell Inc", "state": "TX" },
{ "entity_name": "Apple Inc", "state": "CA" }
],
"source": "auto",
"webhook_url": "https://your-server.com/webhook",
"email_results": true
}
Request Fields
Field Type Required Description
entities array Yes Array of {entity_name, state} objects (max 1,000)
source string No "auto" (default), "cache", or "live"
webhook_url string No URL to POST results when the job completes
email_results boolean No Email results CSV to your account email
Response (Immediate)
{
"job_id": "bulk_abc123",
"status": "queued",
"total": 2,
"poll_url": "/v1/bulk-lookup/bulk_abc123"
}
GET/v1/bulk-lookup/:jobId
Poll this endpoint for job progress and results.

curl https://api.opensosdata.com/v1/bulk-lookup/bulk_abc123 \
 -H "x-api-key: YOUR_API_KEY"
Rate Limits & Pricing
Limit Value
Requests per minute 50
Concurrent lookups 10
Cost per lookup $0.0314 (Pi cents)
Minimum balance None
Rate limit headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset

Quick Start Examples
Python
import requests

resp = requests.post(
"https://api.opensosdata.com/v1/lookup",
headers={"x-api-key": "osd_8628777d..."},
json={"entity_name": "Apple Inc", "state": "DE"}
)
print(resp.json())
JavaScript (Node.js)
const resp = await fetch("https://api.opensosdata.com/v1/lookup", {
method: "POST",
headers: {
"x-api-key": "osd_8628777d...",
"Content-Type": "application/json"
},
body: JSON.stringify({ entity_name: "Apple Inc", state: "DE" })
});
const data = await resp.json();
console.log(data);
