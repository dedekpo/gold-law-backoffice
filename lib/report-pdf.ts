import { jsPDF } from "jspdf";

/**
 * Render the plain-text case report as a monospaced PDF — the only rich-file
 * format GHL's custom-field upload accepts (zip/txt/json are rejected with a
 * 415). Standard PDF fonts are WinAnsi-only, so characters outside Latin-1 are
 * mapped to ASCII stand-ins rather than showing up as garbage.
 */

const PAGE_WIDTH = 612; // US Letter, points
const MARGIN = 56;
const FONT_SIZE = 9;
const LINE_HEIGHT = 11.5;
const MAX_Y = 792 - MARGIN;

function sanitize(text: string): string {
  return text
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[·•]/g, "-")
    .replace(/⚠/g, "(!)")
    .replace(/[→⇒]/g, "->")
    .replace(/[^\x00-\xFF]/g, "?");
}

export function buildReportPdf(report: string): Blob {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  doc.setFont("courier", "normal");
  doc.setFontSize(FONT_SIZE);

  const lines = doc.splitTextToSize(
    sanitize(report),
    PAGE_WIDTH - MARGIN * 2,
  ) as string[];

  let y = MARGIN;
  for (const line of lines) {
    if (y > MAX_Y) {
      doc.addPage();
      y = MARGIN;
    }
    doc.text(line, MARGIN, y);
    y += LINE_HEIGHT;
  }
  return doc.output("blob");
}
