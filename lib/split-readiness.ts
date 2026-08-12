import type {
  InvestigationCompany,
  InvestigationDoc,
  InvestigationEvidence,
  ViolationFinding,
} from "@/lib/investigation-store";

/**
 * The split's readiness gate, shared by the split panel (to disable the
 * button and show what's missing) and executeSplit (to enforce it server-side
 * regardless of client): a company may only spawn its case once the
 * investigator has confirmed the company itself, pinned at least one
 * confirmed violation to it, and attributed at least one confirmed-proof
 * evidence file to it. Everything the gate requires is exactly what the
 * split migrates onto the child case file.
 */

export type SplitReadiness = {
  companyConfirmed: boolean;
  /** Confirmed violations pinned to this company. */
  violations: ViolationFinding[];
  /** Confirmed-proof evidence attributed to this company. */
  evidence: InvestigationEvidence[];
  ready: boolean;
  /** Human-readable unmet requirements; empty when ready. */
  missing: string[];
};

export function splitReadiness(
  doc: InvestigationDoc,
  company: InvestigationCompany,
): SplitReadiness {
  const companyConfirmed = company.status === "confirmed";
  const violations = doc.violations.filter(
    (v) => v.companyId === company.id && v.status === "confirmed",
  );
  const evidence = doc.evidence.filter(
    (e) => e.role === "confirmed" && e.companyIds.includes(company.id),
  );
  const missing: string[] = [];
  if (!companyConfirmed) missing.push("the company is not confirmed");
  if (violations.length === 0) {
    missing.push("no confirmed violation is pinned to it");
  }
  if (evidence.length === 0) {
    missing.push("no confirmed evidence is attributed to it");
  }
  return {
    companyConfirmed,
    violations,
    evidence,
    ready: missing.length === 0,
    missing,
  };
}
