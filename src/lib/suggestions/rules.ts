import { diffScores, ranges, readMusicXml, type ScoreChange } from "./musicxml";

/**
 * The free, rule-based commit message writer: builds a message from what changed, with no AI call.
 * An LLM provider can later sit behind the same inputs (contract section 9: suggestCommitMessage).
 */

export const RULES_MODEL = "scorecontrol/rules-v1";
const MAX_SUGGESTION = 72;

export type FileVersion = { path: string; sha256: string; bytes?: Uint8Array };
export type Suggestion = { suggestion: string; summary: string | null; basis: "simple_diff" | "initial_commit" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (items: string[]) => items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
const fit = (text: string) => (text.length <= MAX_SUGGESTION ? text : `${text.slice(0, MAX_SUGGESTION - 1).trimEnd()}…`);

/** A first commit: "Add Sonata in D (Violin, Piano)". */
export function initialSuggestion(primary: FileVersion, others: FileVersion[]): Suggestion {
  const outline = primary.bytes ? readMusicXml(primary.bytes) : null;
  const name = outline?.title ?? primary.path;
  const parts = outline ? [...outline.parts.values()] : [];
  const suggestion = fit(parts.length ? `Add ${name} (${parts.join(", ")})` : `Add ${name}`);
  const extra = others.length ? `Also adds ${list(others.map((f) => f.path))}.` : null;
  const length = outline ? Math.max(0, ...[...outline.measures.values()].map((m) => m.size)) : 0;
  const summary = [outline && length ? `${plural(length, "measure")} across ${plural(parts.length, "part")}.` : null, extra].filter(Boolean).join(" ") || null;
  return { suggestion, summary, basis: "initial_commit" };
}

function scorePhrases(change: ScoreChange): string[] {
  const phrases: string[] = [];
  if (change.titleChanged?.to) phrases.push(`Rename to ${change.titleChanged.to}`);
  if (change.addedParts.length) phrases.push(`Add ${list(change.addedParts)}`);
  if (change.removedParts.length) phrases.push(`Remove ${list(change.removedParts)}`);
  if (change.edited.length === 1) {
    const [{ name, measures }] = change.edited;
    phrases.push(`Edit ${measures.length === 1 ? "bar" : "bars"} ${ranges(measures)} in ${name}`);
  } else if (change.edited.length > 1) {
    const all = [...new Set(change.edited.flatMap((e) => e.measures))];
    phrases.push(`Edit ${list(change.edited.map((e) => e.name))} (bars ${ranges(all)})`);
  }
  if (change.measureDelta > 0) phrases.push(`add ${plural(change.measureDelta, "measure")}`);
  if (change.measureDelta < 0) phrases.push(`remove ${plural(-change.measureDelta, "measure")}`);
  return phrases;
}

/** Compares a snapshot with its parent's. Files are matched by path; bytes are needed only for primaries. */
export function diffSuggestion(before: { primary: FileVersion; files: FileVersion[] }, after: { primary: FileVersion; files: FileVersion[] }): Suggestion {
  const phrases: string[] = [];
  const details: string[] = [];

  if (before.primary.sha256 !== after.primary.sha256) {
    const old = before.primary.bytes && readMusicXml(before.primary.bytes);
    const now = after.primary.bytes && readMusicXml(after.primary.bytes);
    if (old && now) {
      const change = diffScores(old, now);
      const score = scorePhrases(change);
      phrases.push(...(score.length ? score : [`Update ${after.primary.path} formatting`]));
      for (const e of change.edited) details.push(`${e.name}: bars ${ranges(e.measures)}.`);
    } else {
      phrases.push(`Update ${after.primary.path}`);
    }
  }

  const beforeByPath = new Map(before.files.map((f) => [f.path, f.sha256]));
  const afterByPath = new Map(after.files.map((f) => [f.path, f.sha256]));
  const skip = new Set([before.primary.path, after.primary.path]);
  const added = after.files.filter((f) => !beforeByPath.has(f.path) && !skip.has(f.path)).map((f) => f.path);
  const removed = before.files.filter((f) => !afterByPath.has(f.path) && !skip.has(f.path)).map((f) => f.path);
  const changed = after.files.filter((f) => !skip.has(f.path) && beforeByPath.has(f.path) && beforeByPath.get(f.path) !== f.sha256).map((f) => f.path);
  if (added.length) phrases.push(`add ${list(added)}`);
  if (removed.length) phrases.push(`remove ${list(removed)}`);
  if (changed.length) phrases.push(`update ${list(changed)}`);
  // The one-liner may be cut to fit; the summary always lists file changes in full.
  if (added.length) details.push(`Added ${list(added)}.`);
  if (removed.length) details.push(`Removed ${list(removed)}.`);
  if (changed.length) details.push(`Updated ${list(changed)}.`);
  if (before.primary.path !== after.primary.path) details.push(`Primary score is now ${after.primary.path}.`);

  const text = phrases.length ? phrases.join("; ") : "Update score";
  return { suggestion: fit(text[0].toUpperCase() + text.slice(1)), summary: details.join(" ") || null, basis: "simple_diff" };
}
