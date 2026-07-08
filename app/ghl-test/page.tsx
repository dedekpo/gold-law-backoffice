"use client";

import { useState } from "react";

type Method = "GET" | "POST" | "PUT" | "DELETE";

// Preset GHL v2 endpoints to exercise. "{locationId}" (in the path or the JSON
// body) is replaced server-side with GO_HIGH_LEVEL_LOCATION_ID, so the
// sub-account never has to be pasted here. Note the opportunities search
// endpoint takes snake_case `location_id`, unlike the rest of the API.
const PRESETS: {
  label: string;
  method: Method;
  path: string;
  body?: unknown;
}[] = [
  {
    // Lists every custom object schema with its `key` — the source of truth
    // for the object key used in the records-search path above.
    label: "List Object Schemas",
    method: "GET",
    path: "/objects/?locationId={locationId}",
  },
  {
    // All open cards in "👀 Ready for AI Investigation" (00 Intake Pipeline) —
    // the column the webhook flow will drain. Ids from the List Pipelines call.
    label: "List Ready-for-AI Cards",
    method: "GET",
    path:
      "/opportunities/search?location_id={locationId}" +
      "&pipeline_id=P58ozOdmIUWyBN7wcdet" +
      "&pipeline_stage_id=c382820f-9777-46d8-907a-6326b6128d2a" +
      "&status=open&limit=100",
  },
  {
    label: "Search Opportunities",
    method: "GET",
    path: "/opportunities/search?location_id={locationId}&limit=20",
  },
  {
    label: "List Pipelines",
    method: "GET",
    path: "/opportunities/pipelines?locationId={locationId}",
  },
  { label: "Get Location", method: "GET", path: "/locations/{locationId}" },
  {
    label: "List Contacts",
    method: "GET",
    path: "/contacts/?locationId={locationId}&limit=5",
  },
  {
    label: "Search Conversations",
    method: "GET",
    path: "/conversations/search?locationId={locationId}&limit=5",
  },
  {
    label: "List Calendars",
    method: "GET",
    path: "/calendars/?locationId={locationId}",
  },
  { label: "List Users", method: "GET", path: "/users/?locationId={locationId}" },
  { label: "List Tags", method: "GET", path: "/locations/{locationId}/tags" },
  {
    label: "List Custom Fields",
    method: "GET",
    path: "/locations/{locationId}/customFields",
  },
];

type ProxyResult = {
  status?: number;
  ok?: boolean;
  url?: string;
  body?: unknown;
  error?: string;
};

export default function GhlTestPage() {
  const [defendantName, setDefendantName] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [customMethod, setCustomMethod] = useState<Method>("GET");
  const [customBody, setCustomBody] = useState("");
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [requested, setRequested] = useState<{
    method: Method;
    path: string;
  } | null>(null);
  const [result, setResult] = useState<ProxyResult | null>(null);

  async function callEndpoint(
    label: string,
    method: Method,
    path: string,
    body?: unknown,
  ) {
    setPendingLabel(label);
    setRequested({ method, path });
    setResult(null);
    try {
      const res = await fetch("/api/ghl-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, method, body }),
      });
      setResult(await res.json());
    } catch (err) {
      setResult({
        error: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setPendingLabel(null);
    }
  }

  function submitCustom() {
    const path = customPath.trim();
    if (!path.startsWith("/")) return;
    let body: unknown;
    if (customBody.trim()) {
      try {
        body = JSON.parse(customBody);
      } catch {
        setRequested({ method: customMethod, path });
        setResult({ error: "Request body is not valid JSON." });
        return;
      }
    }
    callEndpoint("Custom", customMethod, path, body);
  }

  const showBodyInput = customMethod === "POST" || customMethod === "PUT";

  return (
    // The root layout locks <body> to the viewport (h-screen overflow-hidden),
    // so this page must scroll itself.
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 font-mono text-sm">
      <h1 className="text-xl font-bold">GoHighLevel API test</h1>
      <p className="mt-1 text-gray-500">
        Calls go through <code>/api/ghl-test</code>, which attaches{" "}
        <code>GO_HIGH_LEVEL_TOKEN</code> and substitutes{" "}
        <code>{"{locationId}"}</code> with <code>GO_HIGH_LEVEL_LOCATION_ID</code>{" "}
        server-side (Version 2021-07-28).
      </p>

      {/* The "Defendants" custom object (companies the firm has already sued).
          Record search is a POST; `query` free-text-matches the object's
          searchable properties (e.g. the defendant name). */}
      <form
        className="mt-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          callEndpoint(
            "Search Defendants",
            "POST",
            "/objects/custom_objects.defendants/records/search",
            {
              locationId: "{locationId}",
              page: 1,
              pageLimit: 20,
              query: defendantName.trim(),
            },
          );
        }}
      >
        <input
          value={defendantName}
          onChange={(e) => setDefendantName(e.target.value)}
          placeholder="Filter defendants by name (empty = list all)"
          className="w-full rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={pendingLabel !== null}
          className="shrink-0 rounded bg-gray-900 px-3 py-2 text-white disabled:opacity-40"
        >
          {pendingLabel === "Search Defendants"
            ? "Loading…"
            : "Search Defendants"}
        </button>
      </form>

      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() =>
              callEndpoint(preset.label, preset.method, preset.path, preset.body)
            }
            disabled={pendingLabel !== null}
            className="rounded bg-gray-900 px-3 py-2 text-white disabled:opacity-40"
          >
            {pendingLabel === preset.label ? "Loading…" : preset.label}
          </button>
        ))}
      </div>

      <form
        className="mt-6 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitCustom();
        }}
      >
        <div className="flex gap-2">
          <select
            value={customMethod}
            onChange={(e) => setCustomMethod(e.target.value as Method)}
            className="rounded border border-gray-300 px-2 py-2"
          >
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
            <option>DELETE</option>
          </select>
          <input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="Custom path, e.g. /contacts/?locationId={locationId}&limit=5"
            className="w-full rounded border border-gray-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={
              !customPath.trim().startsWith("/") || pendingLabel !== null
            }
            className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-40"
          >
            {pendingLabel === "Custom" ? "…" : "Send"}
          </button>
        </div>
        {showBodyInput && (
          <textarea
            value={customBody}
            onChange={(e) => setCustomBody(e.target.value)}
            placeholder={'JSON body, e.g. { "locationId": "{locationId}", "page": 1 }'}
            rows={4}
            className="w-full rounded border border-gray-300 px-3 py-2 text-xs"
          />
        )}
      </form>

      {requested && (
        <div className="mt-8">
          <div className="flex items-center gap-3">
            <span className="text-gray-500">
              {requested.method} {requested.path}
            </span>
            {result?.status !== undefined && (
              <span
                className={`rounded px-2 py-0.5 text-xs font-bold text-white ${
                  result.ok ? "bg-green-600" : "bg-red-600"
                }`}
              >
                {result.status}
              </span>
            )}
          </div>
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded bg-gray-100 p-4 text-xs whitespace-pre-wrap break-all text-gray-900">
            {result === null
              ? "Loading…"
              : JSON.stringify(result.error ?? result.body, null, 2)}
          </pre>
        </div>
      )}
      </div>
    </main>
  );
}
