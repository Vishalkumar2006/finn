export interface FiledProfile {
  text: string;
  page: number;
}

const HEADING = /(brief\s+(profile|resume|bio(graphy)?|background)|profile\s+of|background\s+of|brief\s+details?\s+of|experience\s*:?\s*$|expertise in|biographical)/i;
const CAREER = /\b(years? of experience|has been|served as|prior to|previously|joined|holds? a|graduate|chartered accountant|mba|bachelor|master'?s|worked with|career|alumnus|degree)\b/i;

/**
 * SEBI Regulation 30 requires a brief profile in appointment filings, so the filing itself is the best source.
 * Returns the first passage that reads as career history, verbatim. Null if there is none: this never summarises.
 */
export function extractProfile(pages: string[]): FiledProfile | null {
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p].split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!HEADING.test(lines[i]) && !CAREER.test(lines[i])) continue;
      const block = lines.slice(i, i + 12).join(" ").replace(/\s+/g, " ");
      if (!CAREER.test(block) || block.length < 80) continue;
      if (/^(this is|please|we request|kindly|pursuant|the board)/i.test(block)) continue;
      const text = block.length > 600 ? `${block.slice(0, 600).replace(/\s+\S*$/, "")}…` : block;
      return { text, page: p + 1 };
    }
  }
  return null;
}
