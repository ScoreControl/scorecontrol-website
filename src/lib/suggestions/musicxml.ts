/**
 * Minimal MusicXML reading for commit suggestions: title, part names, and each part's measures as raw
 * text. Regex-based on purpose (a "simple_diff"); the real diff engine replaces it later. Only
 * uncompressed MusicXML is readable; .mxl/.mscz are zip files and return null.
 */

export type ScoreOutline = {
  title: string | null;
  /** Part id -> display name, in score order. */
  parts: Map<string, string>;
  /** Part id -> measure number -> the measure's XML. */
  measures: Map<string, Map<string, string>>;
};

const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
const firstTag = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? decode(match[1]) || null : null;
};

export function readMusicXml(bytes: Uint8Array): ScoreOutline | null {
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!/<score-partwise[\s>]/.test(xml)) return null;

  const parts = new Map<string, string>();
  for (const match of xml.matchAll(/<score-part\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/score-part>/g)) {
    parts.set(match[1], firstTag(match[2], "part-name") ?? match[1]);
  }
  const measures = new Map<string, Map<string, string>>();
  for (const match of xml.matchAll(/<part\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const byNumber = new Map<string, string>();
    for (const m of match[2].matchAll(/<measure\s[^>]*number="([^"]+)"[^>]*>[\s\S]*?<\/measure>/g)) byNumber.set(m[1], m[0]);
    measures.set(match[1], byNumber);
    if (!parts.has(match[1])) parts.set(match[1], match[1]);
  }
  return { title: firstTag(xml, "work-title") ?? firstTag(xml, "movement-title"), parts, measures };
}

/** [3, 4, 5, 9] -> "3–5, 9". Non-numeric measure numbers are listed as they are. */
export function ranges(numbers: string[]): string {
  const numeric = numbers.map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const other = numbers.filter((n) => !Number.isInteger(Number(n)));
  const out: string[] = [];
  for (let i = 0; i < numeric.length; i++) {
    let j = i;
    while (j + 1 < numeric.length && numeric[j + 1] === numeric[j] + 1) j++;
    out.push(i === j ? `${numeric[i]}` : `${numeric[i]}–${numeric[j]}`);
    i = j;
  }
  return [...out, ...other].join(", ");
}

export type ScoreChange = {
  /** Parts whose measures changed, with the changed measure numbers. */
  edited: { name: string; measures: string[] }[];
  addedParts: string[];
  removedParts: string[];
  /** Measure count change across the score (longest part). */
  measureDelta: number;
  titleChanged: { from: string | null; to: string | null } | null;
};

export function diffScores(before: ScoreOutline, after: ScoreOutline): ScoreChange {
  const edited: ScoreChange["edited"] = [];
  for (const [id, name] of after.parts) {
    const old = before.measures.get(id);
    const now = after.measures.get(id) ?? new Map();
    if (!old) continue;
    const changed = [...new Set([...old.keys(), ...now.keys()])].filter((n) => old.get(n) !== now.get(n));
    if (changed.length) edited.push({ name, measures: changed });
  }
  const longest = (s: ScoreOutline) => Math.max(0, ...[...s.measures.values()].map((m) => m.size));
  return {
    edited,
    addedParts: [...after.parts].filter(([id]) => !before.parts.has(id)).map(([, name]) => name),
    removedParts: [...before.parts].filter(([id]) => !after.parts.has(id)).map(([, name]) => name),
    measureDelta: longest(after) - longest(before),
    titleChanged: before.title !== after.title ? { from: before.title, to: after.title } : null,
  };
}
