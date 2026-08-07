"use client";

import { useMemo, useState } from "react";

/**
 * Interactive New Leads → Signed Case dashboard.
 *
 * Analytical choices, in order of importance:
 * - Cohort conversion (% of a period's leads signed within 30 days, by LEAD
 *   date) is the headline health metric — same-period signed÷leads confounds
 *   volume changes with lag, and raw signing counts can spike for good
 *   reasons (backlog cleanup) or bad (slow process).
 * - Signings split into fresh (≤14d from lead) vs backlog recovery (>14d):
 *   time-to-sign is strongly bimodal (~46% sign within 24h, then a 14–122d
 *   tail), so a single median mixes two different behaviors. The split shows
 *   process speed and cleanup effort as separate signals.
 * - Leads run ~14× the volume of signings, so series render as stacked small
 *   multiples with a shared x-axis and crosshair rather than a dual axis.
 * - The last bucket is always in progress: its line segment is dashed with a
 *   hollow endpoint so a partial period never reads as a collapse.
 */

type Gran = "day" | "week" | "month";
type Mode = "period" | "cumulative";
type RangeKey = "all" | "90" | "30";

type MatchedCase = { leadTs: number; ts: number; days: number };

/** Signings ≤ this many days after their lead count as "fresh". */
const FRESH_DAYS = 14;
/** A cohort is mature once every lead in it has had this long to sign. */
const MATURITY_DAYS = 30;

const GRAN_LABEL: Record<Gran, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};
const MODE_LABEL: Record<Mode, string> = {
  period: "Per period",
  cumulative: "Cumulative",
};
const RANGE_LABEL: Record<RangeKey, string> = {
  all: "All time",
  "90": "Last 90 days",
  "30": "Last 30 days",
};

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function alignDate(d: Date, g: Gran): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (g === "week") {
    const mondayOffset = (out.getDay() + 6) % 7;
    out.setDate(out.getDate() - mondayOffset);
  } else if (g === "month") {
    out.setDate(1);
  }
  return out;
}

function nextBucket(d: Date, g: Gran): Date {
  const out = new Date(d);
  if (g === "day") out.setDate(out.getDate() + 1);
  else if (g === "week") out.setDate(out.getDate() + 7);
  else out.setMonth(out.getMonth() + 1);
  return out;
}

function tickLabel(d: Date, g: Gran, withYear: boolean): string {
  const yy = `’${String(d.getFullYear()).slice(2)}`;
  if (g === "month") return `${MONTHS_SHORT[d.getMonth()]} ${yy}`;
  const base = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return withYear ? `${base} ${yy}` : base;
}

function fullLabel(d: Date, g: Gran): string {
  const long = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (g === "day") return long;
  if (g === "week") return `Week of ${long}`;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Linear-interpolated quantile of a sorted array. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmtDays(d: number): string {
  return `${d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString("en-US")}d`;
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

/** Round a data max up to a clean tick step (1/2/5 × 10^k), ~3 gridlines. */
function niceScale(max: number): { yMax: number; ticks: number[] } {
  const target = Math.max(max, 1) / 3;
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = ([1, 2, 5, 10].find((m) => m * pow >= target) ?? 10) * pow;
  const yMax = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);
  return { yMax, ticks };
}

// ---------------------------------------------------------------------------

const W = 800;
const H = 180;
const ML = 46; // room for y tick labels
const MR = 64; // room for the endpoint direct label
const MT = 12;
const MB = 24;

const plotX = (i: number, n: number) =>
  n <= 1 ? ML + (W - ML - MR) / 2 : ML + (i / (n - 1)) * (W - ML - MR);

function pointerIndex(
  e: React.PointerEvent<SVGSVGElement>,
  n: number,
): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * W;
  const frac = (px - ML) / (W - ML - MR);
  return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
}

function Gridlines({
  ticks,
  y,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  format?: (t: number) => string;
}) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={ML}
            x2={W - MR}
            y1={y(t)}
            y2={y(t)}
            strokeWidth={1}
            className={
              t === 0
                ? "stroke-[#c3c2b7] dark:stroke-[#383835]"
                : "stroke-[#e1e0d9] dark:stroke-[#2c2c2a]"
            }
          />
          <text
            x={ML - 6}
            y={y(t) + 3.5}
            textAnchor="end"
            className="fill-[#898781] text-[10px] tabular-nums"
          >
            {format ? format(t) : t.toLocaleString("en-US")}
          </text>
        </g>
      ))}
    </>
  );
}

function XAxis({
  xTicks,
  n,
}: {
  xTicks: Array<{ i: number; label: string }>;
  n: number;
}) {
  return (
    <>
      {xTicks.map(({ i, label }) => (
        <text
          key={i}
          x={plotX(i, n)}
          y={H - 6}
          textAnchor="middle"
          className="fill-[#898781] text-[10px] tabular-nums"
        >
          {label}
        </text>
      ))}
    </>
  );
}

function Crosshair({
  i,
  n,
  yTop,
  yBottom,
}: {
  i: number;
  n: number;
  yTop: number;
  yBottom: number;
}) {
  return (
    <line
      x1={plotX(i, n)}
      x2={plotX(i, n)}
      y1={yTop}
      y2={yBottom}
      strokeWidth={1}
      className="stroke-[#898781]"
    />
  );
}

type PanelColors = {
  line: string;
  fill: string;
  swatch: string;
};

/**
 * Single-series count panel. The final bucket is always in progress, so its
 * segment draws dashed with a hollow endpoint — a partial week must not read
 * as a collapse.
 */
function Panel({
  title,
  total,
  values,
  colors,
  xTicks,
  hoverIndex,
  onHover,
}: {
  title: string;
  total: number;
  values: number[];
  colors: PanelColors;
  xTicks: Array<{ i: number; label: string }>;
  hoverIndex: number | null;
  onHover: (i: number | null) => void;
}) {
  const n = values.length;
  const { yMax, ticks } = niceScale(Math.max(...values, 0));
  const x = (i: number) => plotX(i, n);
  const y = (v: number) => MT + (1 - v / yMax) * (H - MT - MB);
  const baseline = y(0);

  const solidEnd = Math.max(0, n - 2);
  const linePath = values
    .slice(0, solidEnd + 1)
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  const areaPath =
    values
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join("") +
    `L${x(n - 1).toFixed(1)},${baseline}L${x(0).toFixed(1)},${baseline}Z`;

  const last = values[n - 1] ?? 0;

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2 text-sm">
        <span className={`h-[3px] w-4 shrink-0 rounded-full ${colors.swatch}`} />
        <span className="font-semibold">{title}</span>
        <span className="tabular-nums text-gray-500 dark:text-zinc-500">
          {total.toLocaleString("en-US")} in range
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label={`${title} over time`}
        onPointerMove={(e) => onHover(pointerIndex(e, n))}
        onPointerLeave={() => onHover(null)}
      >
        <Gridlines ticks={ticks} y={y} />
        <XAxis xTicks={xTicks} n={n} />

        {n > 1 && <path d={areaPath} fillOpacity={0.1} className={colors.fill} />}
        {n > 1 && (
          <path
            d={linePath}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            className={colors.line}
          />
        )}
        {n > 1 && (
          <line
            x1={x(n - 2)}
            y1={y(values[n - 2])}
            x2={x(n - 1)}
            y2={y(last)}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="5 4"
            className={colors.line}
          />
        )}

        {hoverIndex !== null && hoverIndex < n && (
          <g>
            <Crosshair i={hoverIndex} n={n} yTop={MT} yBottom={baseline} />
            <circle
              cx={x(hoverIndex)}
              cy={y(values[hoverIndex])}
              r={4}
              strokeWidth={2}
              className={`${colors.fill} stroke-white dark:stroke-zinc-950`}
            />
          </g>
        )}

        {/* Hollow endpoint: the current period is still accruing. */}
        <circle
          cx={x(n - 1)}
          cy={y(last)}
          r={4}
          strokeWidth={2}
          className={`fill-white dark:fill-zinc-950 ${colors.line}`}
        />
        <text
          x={x(n - 1) + 10}
          y={y(last) + 4}
          className="fill-zinc-600 text-[11px] font-semibold tabular-nums dark:fill-zinc-400"
        >
          {last.toLocaleString("en-US")}
        </text>
      </svg>
    </div>
  );
}

/**
 * Cohort conversion panel: % of each period's leads (bucketed by LEAD date)
 * that signed within MATURITY_DAYS. Buckets whose leads haven't all had the
 * full window yet draw dashed with hollow markers — they can only go up.
 */
function ConversionPanel({
  title,
  subtitle,
  values,
  mature,
  colors,
  xTicks,
  hoverIndex,
  onHover,
}: {
  title: string;
  subtitle: string;
  values: Array<number | null>;
  mature: boolean[];
  colors: PanelColors;
  xTicks: Array<{ i: number; label: string }>;
  hoverIndex: number | null;
  onHover: (i: number | null) => void;
}) {
  const n = values.length;
  const dataMax = Math.max(...values.map((v) => v ?? 0), 0);
  const { yMax, ticks } = niceScale(dataMax);
  const x = (i: number) => plotX(i, n);
  const y = (v: number) => MT + (1 - v / yMax) * (H - MT - MB);
  const baseline = y(0);

  // Adjacent non-null pairs; dashed when either side is still maturing.
  const pairs: Array<{ a: number; b: number; dashed: boolean }> = [];
  for (let i = 1; i < n; i++) {
    if (values[i - 1] !== null && values[i] !== null) {
      pairs.push({ a: i - 1, b: i, dashed: !mature[i - 1] || !mature[i] });
    }
  }
  const lastIdx = values.reduce<number>((acc, v, i) => (v !== null ? i : acc), -1);

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2 text-sm">
        <span className={`h-[3px] w-4 shrink-0 rounded-full ${colors.swatch}`} />
        <span className="font-semibold">{title}</span>
        <span className="text-gray-500 dark:text-zinc-500">{subtitle}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label={`${title} over time`}
        onPointerMove={(e) => onHover(pointerIndex(e, n))}
        onPointerLeave={() => onHover(null)}
      >
        <Gridlines ticks={ticks} y={y} format={(t) => `${t}%`} />
        <XAxis xTicks={xTicks} n={n} />

        {pairs.map(({ a, b, dashed }) => (
          <line
            key={a}
            x1={x(a)}
            y1={y(values[a]!)}
            x2={x(b)}
            y2={y(values[b]!)}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={dashed ? "5 4" : undefined}
            className={colors.line}
          />
        ))}
        {values.map((v, i) =>
          v !== null && !mature[i] ? (
            <circle
              key={i}
              cx={x(i)}
              cy={y(v)}
              r={3.5}
              strokeWidth={2}
              className={`fill-white dark:fill-zinc-950 ${colors.line}`}
            />
          ) : null,
        )}

        {hoverIndex !== null && hoverIndex < n && (
          <g>
            <Crosshair i={hoverIndex} n={n} yTop={MT} yBottom={baseline} />
            {values[hoverIndex] !== null && (
              <circle
                cx={x(hoverIndex)}
                cy={y(values[hoverIndex])}
                r={4}
                strokeWidth={2}
                className={`${colors.fill} stroke-white dark:stroke-zinc-950`}
              />
            )}
          </g>
        )}

        {lastIdx >= 0 && (
          <text
            x={x(lastIdx) + 10}
            y={y(values[lastIdx]!) + 4}
            className="fill-zinc-600 text-[11px] font-semibold tabular-nums dark:fill-zinc-400"
          >
            {fmtPct(values[lastIdx]!)}
          </text>
        )}
      </svg>
    </div>
  );
}

/** Rounded-top column path: 4px data-end radius, square at the baseline. */
function columnPath(
  x0: number,
  yTop: number,
  w: number,
  h: number,
  rounded: boolean,
): string {
  if (h <= 0) return "";
  const r = rounded ? Math.min(4, h / 2, w / 2) : 0;
  const x1 = x0 + w;
  const yBot = yTop + h;
  if (r === 0) return `M${x0},${yBot}L${x0},${yTop}L${x1},${yTop}L${x1},${yBot}Z`;
  return (
    `M${x0},${yBot}L${x0},${yTop + r}` +
    `Q${x0},${yTop} ${x0 + r},${yTop}` +
    `L${x1 - r},${yTop}` +
    `Q${x1},${yTop} ${x1},${yTop + r}` +
    `L${x1},${yBot}Z`
  );
}

type StackSeries = {
  label: string;
  values: number[];
  fill: string;
  swatch: string;
};

/**
 * Stacked columns decomposing signings into fresh / backlog / unmatched.
 * Totals reconcile with the "Signed cases" panel; the gray unmatched segment
 * doubles as a per-period view of name-match coverage.
 */
function StackPanel({
  title,
  subtitle,
  series,
  xTicks,
  hoverIndex,
  onHover,
}: {
  title: string;
  subtitle: string;
  series: StackSeries[];
  xTicks: Array<{ i: number; label: string }>;
  hoverIndex: number | null;
  onHover: (i: number | null) => void;
}) {
  const n = series[0].values.length;
  const totals = series[0].values.map((_, i) =>
    series.reduce((sum, s) => sum + s.values[i], 0),
  );
  const { yMax, ticks } = niceScale(Math.max(...totals, 0));
  const x = (i: number) => plotX(i, n);
  const y = (v: number) => MT + (1 - v / yMax) * (H - MT - MB);
  const baseline = y(0);
  const colW = Math.min(24, ((W - ML - MR) / Math.max(n, 1)) * 0.72);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold">{title}</span>
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-zinc-500">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${s.swatch}`} />
            {s.label}
          </span>
        ))}
        <span className="text-xs text-gray-500 dark:text-zinc-500">{subtitle}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label={`${title} over time`}
        onPointerMove={(e) => onHover(pointerIndex(e, n))}
        onPointerLeave={() => onHover(null)}
      >
        <Gridlines ticks={ticks} y={y} />
        <XAxis xTicks={xTicks} n={n} />

        {hoverIndex !== null && hoverIndex < n && (
          <Crosshair i={hoverIndex} n={n} yTop={MT} yBottom={baseline} />
        )}

        {totals.map((total, i) => {
          if (total === 0) return null;
          const x0 = x(i) - colW / 2;
          let cum = 0;
          const topValue = [...series].reverse().find((s) => s.values[i] > 0);
          return (
            <g key={i} opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.75}>
              {series.map((s) => {
                const v = s.values[i];
                if (v === 0) return null;
                const yTop = y(cum + v);
                // 2px surface gap between stacked segments, eaten from the
                // segment's own bottom so the stack total stays truthful.
                const isBottom = cum === 0;
                const h = y(cum) - yTop - (isBottom ? 0 : 2);
                cum += v;
                return (
                  <path
                    key={s.label}
                    d={columnPath(x0, yTop, colW, Math.max(h, 0.5), s === topValue)}
                    className={s.fill}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  labels,
  onChange,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-gray-300 text-xs dark:border-zinc-700">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 font-medium ${
            value === opt
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "hover:bg-gray-50 dark:hover:bg-zinc-900"
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}

function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded border border-gray-200 px-3 py-2 dark:border-zinc-800">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] text-gray-500 dark:text-zinc-500">{label}</div>
      {note && (
        <div className="text-[10px] text-gray-400 dark:text-zinc-600">{note}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const LEAD_COLORS: PanelColors = {
  line: "stroke-[#2a78d6] dark:stroke-[#3987e5]",
  fill: "fill-[#2a78d6] dark:fill-[#3987e5]",
  swatch: "bg-[#2a78d6] dark:bg-[#3987e5]",
};
const SIGNED_COLORS: PanelColors = {
  line: "stroke-[#eb6834] dark:stroke-[#d95926]",
  fill: "fill-[#eb6834] dark:fill-[#d95926]",
  swatch: "bg-[#eb6834] dark:bg-[#d95926]",
};
const BACKLOG_FILL = "fill-[#1baf7a] dark:fill-[#199e70]";
const BACKLOG_SWATCH = "bg-[#1baf7a] dark:bg-[#199e70]";
const UNMATCHED_FILL = "fill-[#c3c2b7] dark:fill-[#52514e]";
const UNMATCHED_SWATCH = "bg-[#c3c2b7] dark:bg-[#52514e]";

export function PipelineDashboard({
  leads,
  signed,
  cases,
  dedupedLeads,
}: {
  leads: number[];
  signed: number[];
  cases: MatchedCase[];
  dedupedLeads: number;
}) {
  const [range, setRange] = useState<RangeKey>("all");
  const [gran, setGran] = useState<Gran>("week");
  const [mode, setMode] = useState<Mode>("period");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Tooltip's vertical anchor: pointer Y relative to the charts wrapper, so
  // the readout stays beside the cursor across all stacked panels.
  const [hoverY, setHoverY] = useState(0);

  const data = useMemo(() => {
    const now = new Date();
    const firstTs = Math.min(
      leads[0] ?? Number.POSITIVE_INFINITY,
      signed[0] ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(firstTs)) return null;
    const rangeStartMs =
      range === "all"
        ? firstTs * 1000
        : now.getTime() - Number(range) * 86_400_000;
    const start = alignDate(new Date(rangeStartMs), gran);

    const starts: Date[] = [];
    for (let d = start; d <= now; d = nextBucket(d, gran)) starts.push(d);
    const indexByKey = new Map<number, number>(
      starts.map((d, i) => [d.getTime(), i]),
    );
    const bucketOf = (ms: number): number | undefined =>
      ms < start.getTime() || ms > now.getTime()
        ? undefined
        : indexByKey.get(alignDate(new Date(ms), gran).getTime());

    const countInto = (timestamps: number[]): number[] => {
      const out = new Array<number>(starts.length).fill(0);
      for (const ts of timestamps) {
        const i = bucketOf(ts * 1000);
        if (i !== undefined) out[i] += 1;
      }
      return out;
    };
    const cumulative = (counts: number[]): number[] => {
      let sum = 0;
      return counts.map((c) => (sum += c));
    };

    const leadCounts = countInto(leads);
    const signedCounts = countInto(signed);

    // Signings decomposition (by signing date) and cohort conversion
    // numerators (by lead date), both from name-matched cases.
    const freshCounts = new Array<number>(starts.length).fill(0);
    const backlogCounts = new Array<number>(starts.length).fill(0);
    const convNum = new Array<number>(starts.length).fill(0);
    const rangeDays: number[] = [];
    for (const c of cases) {
      const signIdx = bucketOf(c.ts * 1000);
      if (signIdx !== undefined) {
        if (c.days < FRESH_DAYS) freshCounts[signIdx] += 1;
        else backlogCounts[signIdx] += 1;
        rangeDays.push(c.days);
      }
      if (c.days <= MATURITY_DAYS) {
        const leadIdx = bucketOf(c.leadTs * 1000);
        if (leadIdx !== undefined) convNum[leadIdx] += 1;
      }
    }
    const unmatchedCounts = signedCounts.map((s, i) =>
      Math.max(0, s - freshCounts[i] - backlogCounts[i]),
    );
    const convPct = leadCounts.map((count, i) =>
      count > 0 ? (convNum[i] / count) * 100 : null,
    );
    const maturityMs = MATURITY_DAYS * 86_400_000;
    const convMature = starts.map(
      (d) => nextBucket(d, gran).getTime() + maturityMs <= now.getTime(),
    );

    // Range-level tiles: conversion over mature leads only, and the
    // time-to-sign distribution of signings in range.
    let matureLeadCount = 0;
    for (const t of leads) {
      const ms = t * 1000;
      if (ms >= start.getTime() && ms + maturityMs <= now.getTime()) {
        matureLeadCount += 1;
      }
    }
    let matureConvCount = 0;
    for (const c of cases) {
      const ms = c.leadTs * 1000;
      if (
        ms >= start.getTime() &&
        ms + maturityMs <= now.getTime() &&
        c.days <= MATURITY_DAYS
      ) {
        matureConvCount += 1;
      }
    }
    rangeDays.sort((a, b) => a - b);

    return {
      starts,
      leadCounts,
      signedCounts,
      leadCum: cumulative(leadCounts),
      signedCum: cumulative(signedCounts),
      freshCounts,
      backlogCounts,
      unmatchedCounts,
      freshCum: cumulative(freshCounts),
      backlogCum: cumulative(backlogCounts),
      unmatchedCum: cumulative(unmatchedCounts),
      convPct,
      convNum,
      convMature,
      matureLeadCount,
      matureConvCount,
      rangeMedian: rangeDays.length ? quantile(rangeDays, 0.5) : null,
      rangeCases: rangeDays.length,
      within1dPct: rangeDays.length
        ? (rangeDays.filter((d) => d < 1).length / rangeDays.length) * 100
        : null,
    };
  }, [leads, signed, cases, gran, range]);

  const xTicks = useMemo(() => {
    if (!data) return [];
    const n = data.starts.length;
    const step = Math.max(1, Math.ceil(n / 6));
    const ticks: Array<{ i: number; label: string }> = [];
    let prevYear: number | null = null;
    for (let i = 0; i < n; i += step) {
      const d = data.starts[i];
      const withYear = gran !== "month" && d.getFullYear() !== prevYear;
      ticks.push({ i, label: tickLabel(d, gran, withYear) });
      prevYear = d.getFullYear();
    }
    return ticks;
  }, [data, gran]);

  if (!data) {
    return (
      <main className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-gray-500">
          No events found in data/slack-pipeline-events.json.
        </div>
      </main>
    );
  }

  const n = data.starts.length;
  const leadValues = mode === "period" ? data.leadCounts : data.leadCum;
  const signedValues = mode === "period" ? data.signedCounts : data.signedCum;
  const totalLeads = data.leadCum[n - 1] ?? 0;
  const totalSigned = data.signedCum[n - 1] ?? 0;
  const matureConvPct =
    data.matureLeadCount > 0
      ? (data.matureConvCount / data.matureLeadCount) * 100
      : null;

  const hover = hoverIndex !== null && hoverIndex < n ? hoverIndex : null;
  const hoverIsPartial = hover === n - 1;
  const tooltipFrac =
    hover !== null && n > 1 ? (ML + (hover / (n - 1)) * (W - ML - MR)) / W : 0;

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <header>
          <h1 className="text-xl font-bold">Pipeline Tracking</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-zinc-500">
            New leads entering the intake pipeline vs. signed cases (completed
            PandaDoc client agreements), from the{" "}
            <span className="font-medium">#notifications-intake-tcpa</span>{" "}
            Slack channel history. Snapshot data — refresh the export to bring
            it current.
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={range}
            options={["all", "90", "30"] as const}
            labels={RANGE_LABEL}
            onChange={(v) => {
              setRange(v);
              setHoverIndex(null);
            }}
          />
          <Segmented
            value={gran}
            options={["day", "week", "month"] as const}
            labels={GRAN_LABEL}
            onChange={(v) => {
              setGran(v);
              setHoverIndex(null);
            }}
          />
          <Segmented
            value={mode}
            options={["period", "cumulative"] as const}
            labels={MODE_LABEL}
            onChange={setMode}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="New leads"
            value={totalLeads.toLocaleString("en-US")}
            note={
              dedupedLeads > 0
                ? `${dedupedLeads.toLocaleString("en-US")} duplicate notifications (same name within 24h) excluded.`
                : undefined
            }
          />
          <StatTile label="Signed cases" value={totalSigned.toLocaleString("en-US")} />
          <StatTile
            label={`Lead → signed ≤${MATURITY_DAYS}d`}
            value={matureConvPct !== null ? fmtPct(matureConvPct) : "—"}
            note={`Of the ${data.matureLeadCount.toLocaleString("en-US")} mature leads in range (${MATURITY_DAYS}+ days old). Name-matched signings only — the real rate runs higher; watch the trend.`}
          />
          <StatTile
            label="Median days to sign"
            value={data.rangeMedian !== null ? fmtDays(data.rangeMedian) : "—"}
            note={
              data.within1dPct !== null
                ? `${Math.round(data.within1dPct)}% of matched signings happen within 24h.`
                : undefined
            }
          />
        </div>

        <div
          className="relative space-y-4 outline-none"
          tabIndex={0}
          role="application"
          aria-label="Pipeline charts. Use left and right arrow keys to inspect values."
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const delta = e.key === "ArrowLeft" ? -1 : 1;
            setHoverIndex((prev) =>
              Math.max(0, Math.min(n - 1, (prev ?? n - 1) + delta)),
            );
          }}
          onPointerMove={(e) =>
            setHoverY(e.clientY - e.currentTarget.getBoundingClientRect().top)
          }
        >
          <Panel
            title="New leads"
            total={totalLeads}
            values={leadValues}
            colors={LEAD_COLORS}
            xTicks={xTicks}
            hoverIndex={hover}
            onHover={setHoverIndex}
          />
          <Panel
            title="Signed cases"
            total={totalSigned}
            values={signedValues}
            colors={SIGNED_COLORS}
            xTicks={xTicks}
            hoverIndex={hover}
            onHover={setHoverIndex}
          />
          <ConversionPanel
            title={`Lead → signed within ${MATURITY_DAYS} days`}
            subtitle="% of each period’s leads, by lead date · hollow = cohort still maturing"
            values={data.convPct}
            mature={data.convMature}
            colors={LEAD_COLORS}
            xTicks={xTicks}
            hoverIndex={hover}
            onHover={setHoverIndex}
          />
          <StackPanel
            title="Signings decomposed"
            subtitle={`· by signing date${mode === "cumulative" ? " · cumulative" : ""}`}
            series={[
              {
                label: `Fresh (≤${FRESH_DAYS}d from lead)`,
                values: mode === "period" ? data.freshCounts : data.freshCum,
                fill: SIGNED_COLORS.fill,
                swatch: SIGNED_COLORS.swatch,
              },
              {
                label: `Backlog recovery (>${FRESH_DAYS}d)`,
                values: mode === "period" ? data.backlogCounts : data.backlogCum,
                fill: BACKLOG_FILL,
                swatch: BACKLOG_SWATCH,
              },
              {
                label: "Unmatched name",
                values:
                  mode === "period" ? data.unmatchedCounts : data.unmatchedCum,
                fill: UNMATCHED_FILL,
                swatch: UNMATCHED_SWATCH,
              },
            ]}
            xTicks={xTicks}
            hoverIndex={hover}
            onHover={setHoverIndex}
          />

          {hover !== null && (
            <div
              className="pointer-events-none absolute z-10 rounded border border-gray-200 bg-white px-3 py-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
              style={{
                left: `${tooltipFrac * 100}%`,
                top: Math.max(0, hoverY - 16),
                transform: `${
                  tooltipFrac > 0.72 ? "translateX(calc(-100% - 12px))" : "translateX(12px)"
                } translateY(-50%)`,
              }}
            >
              <div className="mb-1 font-semibold">
                {fullLabel(data.starts[hover], gran)}
                {hoverIsPartial && (
                  <span className="ml-1 font-normal text-gray-400 dark:text-zinc-500">
                    (partial)
                  </span>
                )}
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className={`h-[3px] w-3 rounded-full ${LEAD_COLORS.swatch}`} />
                  <span className="font-bold tabular-nums">
                    {leadValues[hover].toLocaleString("en-US")}
                  </span>
                  <span className="text-gray-500 dark:text-zinc-500">
                    new leads{mode === "cumulative" ? " (cum.)" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`h-[3px] w-3 rounded-full ${SIGNED_COLORS.swatch}`} />
                  <span className="font-bold tabular-nums">
                    {signedValues[hover].toLocaleString("en-US")}
                  </span>
                  <span className="text-gray-500 dark:text-zinc-500">
                    signed{mode === "cumulative" ? " (cum.)" : ""}
                    {(data.freshCounts[hover] > 0 || data.backlogCounts[hover] > 0) &&
                      mode === "period" &&
                      ` — ${data.freshCounts[hover]} fresh · ${data.backlogCounts[hover]} backlog`}
                  </span>
                </div>
                {data.convPct[hover] !== null && (
                  <div className="flex items-center gap-2">
                    <span className={`h-[3px] w-3 rounded-full ${LEAD_COLORS.swatch}`} />
                    <span className="font-bold tabular-nums">
                      {fmtPct(data.convPct[hover])}
                    </span>
                    <span className="text-gray-500 dark:text-zinc-500">
                      of cohort signed ≤{MATURITY_DAYS}d
                      {!data.convMature[hover] && " · maturing"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <details className="rounded border border-gray-200 dark:border-zinc-800">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-zinc-900">
            Data table
          </summary>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                <tr className="border-b border-gray-200 text-left dark:border-zinc-800">
                  <th className="px-3 py-1.5 font-semibold">Period</th>
                  <th className="px-3 py-1.5 text-right font-semibold">New leads</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Signed</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Fresh</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Backlog</th>
                  <th className="px-3 py-1.5 text-right font-semibold">
                    ≤{MATURITY_DAYS}d conv
                  </th>
                  <th className="px-3 py-1.5 text-right font-semibold">Cum. leads</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Cum. signed</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {data.starts.map((d, i) => (
                  <tr
                    key={d.getTime()}
                    className="border-b border-gray-100 dark:border-zinc-900"
                  >
                    <td className="px-3 py-1">
                      {fullLabel(d, gran)}
                      {i === n - 1 && (
                        <span className="ml-1 text-gray-400 dark:text-zinc-600">
                          (partial)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-right">{data.leadCounts[i]}</td>
                    <td className="px-3 py-1 text-right">{data.signedCounts[i]}</td>
                    <td className="px-3 py-1 text-right">{data.freshCounts[i]}</td>
                    <td className="px-3 py-1 text-right">{data.backlogCounts[i]}</td>
                    <td className="px-3 py-1 text-right">
                      {data.convPct[i] !== null
                        ? `${fmtPct(data.convPct[i])}${data.convMature[i] ? "" : "*"}`
                        : "—"}
                    </td>
                    <td className="px-3 py-1 text-right">{data.leadCum[i]}</td>
                    <td className="px-3 py-1 text-right">{data.signedCum[i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-400 dark:border-zinc-900 dark:text-zinc-600">
            * cohort still maturing — its leads haven&rsquo;t all had{" "}
            {MATURITY_DAYS} days to sign, so the rate can only rise.
          </div>
        </details>

        <footer className="pb-8 text-xs text-gray-400 dark:text-zinc-600">
          Source: Slack #notifications-intake-tcpa export ·{" "}
          {new Date((leads[0] ?? 0) * 1000).toLocaleDateString("en-US")} –{" "}
          {new Date(
            Math.max(leads[leads.length - 1] ?? 0, signed[signed.length - 1] ?? 0) *
              1000,
          ).toLocaleDateString("en-US")}{" "}
          · Signings are matched to that client&rsquo;s most recent prior lead
          notification by name; ~half stay unmatched (blank or ambiguous
          PandaDoc names, or leads predating the channel) and are shown gray in
          the decomposition. Conversion counts matched signings only, so its
          level understates reality — the trend is the signal. Fresh vs backlog
          splits at {FRESH_DAYS} days because time-to-sign is bimodal: most
          cases sign within a week or resurface much later.
        </footer>
      </div>
    </main>
  );
}
