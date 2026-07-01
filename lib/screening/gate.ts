// Intake-level SOL gate + plausible-claim check — see docs/screening-spec.md §1–2.
//
// Pure given the supplied `now`. Runs over ALL of an intake's evidence before any
// defendant identification: a time-barred or purely-informational intake is
// declined here so identification effort is never wasted.

import {
  type EvidenceFacts,
  type ExtractedContact,
  type IntakeGate,
  SOL_BUFFER_DAYS,
} from "@/lib/types";

const FOUR_YEARS = 4;

/**
 * A contact that could be a violation (so it counts toward the SOL clock and the
 * plausible-claim check): something sent TO the consumer that is not a pure
 * informational notice and not the one allowed opt-out confirmation. A message
 * we couldn't classify (`unknown`) is included rather than dropped, so we never
 * wrongly decline an ambiguous lead.
 */
function isQualifying(c: ExtractedContact): boolean {
  return (
    c.direction !== "from_consumer" &&
    c.messageType !== "informational" &&
    !c.isOptOutConfirmation
  );
}

/** The filing deadline for a message received on `isoDate` (date + 4 years). */
function filingDeadline(isoDate: string): Date {
  const d = new Date(isoDate);
  d.setFullYear(d.getFullYear() + FOUR_YEARS);
  return d;
}

/**
 * Still viable to file: more than SOL_BUFFER_DAYS of runway remain before the
 * 4-year deadline. (Past the deadline, or within the buffer, is non-viable.)
 */
function isViable(isoDate: string, now: Date): boolean {
  const cutoff = filingDeadline(isoDate);
  cutoff.setDate(cutoff.getDate() - SOL_BUFFER_DAYS);
  return now.getTime() < cutoff.getTime();
}

export function evaluateIntakeGate(
  facts: EvidenceFacts,
  now: Date = new Date(),
): IntakeGate {
  const qualifying = facts.contacts.filter(isQualifying);

  // No qualifying message at all → everything is informational → no claim.
  if (qualifying.length === 0) {
    return {
      solPass: true,
      notifyLeadImmediately: false,
      hasPlausibleClaim: false,
      declined: true,
      declineReason: "no-claim-informational",
    };
  }

  // A message can only be time-barred when it carries an EXPLICIT full date (a
  // visible 4-digit year). A date showing only month/day is recent by the apps'
  // own display convention — they add the year only for older messages — so it is
  // treated as in-window, never time-barred. A missing/yearless date therefore
  // passes (and is flagged to confirm) so it never causes a false rejection.
  // See screening-spec §1.
  const hasExplicitDate = (c: ExtractedContact): boolean =>
    Boolean(c.dateReceived && c.dateReceivedYearShown);
  const undated = qualifying.filter((c) => !hasExplicitDate(c));
  const viable = qualifying.filter(
    (c) => !hasExplicitDate(c) || isViable(c.dateReceived as string, now),
  );

  // Time-bar only when EVERY qualifying message has an explicit-year date and all
  // are outside the window. (If any message lacks a visible year, it's recent →
  // viable → we never reach here.)
  if (viable.length === 0) {
    return {
      solPass: false,
      notifyLeadImmediately: true,
      hasPlausibleClaim: false,
      declined: true,
      declineReason: "time-barred",
    };
  }

  const unknowns =
    undated.length > 0
      ? [
          `${undated.length} contact${undated.length === 1 ? "" : "s"} show no explicit year — treated as within the 4-year window (apps omit the year for recent messages). Confirm the receipt date if any message looks older.`,
        ]
      : undefined;

  return {
    solPass: true,
    notifyLeadImmediately: false,
    hasPlausibleClaim: true,
    declined: false,
    unknowns,
  };
}
