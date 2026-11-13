import { describe, expect, it } from "vitest";
import { ranges, readMusicXml } from "@/lib/suggestions/musicxml";
import { diffSuggestion, initialSuggestion } from "@/lib/suggestions/rules";

/** A tiny score-partwise document: parts maps part name -> measure contents. */
function score(title: string, parts: Record<string, string[]>) {
  const ids = Object.keys(parts).map((_, i) => `P${i + 1}`);
  const list = Object.keys(parts).map((name, i) => `<score-part id="${ids[i]}"><part-name>${name}</part-name></score-part>`).join("");
  const body = Object.values(parts).map((measures, i) =>
    `<part id="${ids[i]}">${measures.map((m, n) => `<measure number="${n + 1}">${m}</measure>`).join("")}</part>`).join("");
  return new TextEncoder().encode(`<?xml version="1.0"?><score-partwise><work><work-title>${title}</work-title></work><part-list>${list}</part-list>${body}</score-partwise>`);
}
const v = (path: string, bytes?: Uint8Array, sha = bytes ? String(bytes.join(",").length) + path : path) => ({ path, sha256: sha, bytes });

describe("readMusicXml", () => {
  it("reads title, parts, and measures, and skips non-MusicXML", () => {
    const outline = readMusicXml(score("Sonata in D &amp; more", { Violin: ["a", "b"], Piano: ["c"] }))!;
    expect(outline.title).toBe("Sonata in D & more");
    expect([...outline.parts.values()]).toEqual(["Violin", "Piano"]);
    expect(outline.measures.get("P1")?.size).toBe(2);
    expect(readMusicXml(new Uint8Array([0x50, 0x4b, 3, 4]))).toBeNull();
  });

  it("collapses measure numbers into ranges", () => {
    expect(ranges(["9", "3", "4", "5", "12a"])).toBe("3–5, 9, 12a");
  });
});

describe("rule-based suggestions", () => {
  it("names a first commit after the title and parts", () => {
    const result = initialSuggestion(v("sonata.musicxml", score("Sonata in D", { Violin: ["a", "b"], Piano: ["c"] })), [v("notes.txt")]);
    expect(result).toEqual({ suggestion: "Add Sonata in D (Violin, Piano)", summary: "2 measures across 2 parts. Also adds notes.txt.", basis: "initial_commit" });
    expect(initialSuggestion(v("song.mscz"), []).suggestion).toBe("Add song.mscz");
  });

  it("lists edited bars per part, measure count changes, and other files", () => {
    const before = score("S", { Violin: ["a", "b", "c", "d"], Cello: ["x", "y", "z", "w"] });
    const oneEdit = score("S", { Violin: ["a", "B", "C", "d"], Cello: ["x", "y", "z", "w"] });
    const s = (bytes: Uint8Array, sha: string, files: ReturnType<typeof v>[] = []) => ({ primary: v("s.musicxml", bytes, sha), files: [v("s.musicxml", bytes, sha), ...files] });

    expect(diffSuggestion(s(before, "1"), s(oneEdit, "2")).suggestion).toBe("Edit bars 2–3 in Violin");

    const both = score("S", { Violin: ["a", "B", "c", "d", "e"], Cello: ["x", "y", "Z", "w", "v"] });
    expect(diffSuggestion(s(before, "1", [v("old.pdf")]), s(both, "3", [v("notes.txt")]))).toEqual({
      suggestion: "Edit Violin and Cello (bars 2–3, 5); add 1 measure; add notes.txt; remo…",
      summary: "Violin: bars 2, 5. Cello: bars 3, 5. Added notes.txt. Removed old.pdf.", basis: "simple_diff",
    });
  });

  it("covers part changes, unreadable files, and unchanged scores", () => {
    const before = score("S", { Violin: ["a"] });
    const after = score("S", { Violin: ["a"], Viola: ["b"] });
    expect(diffSuggestion({ primary: v("s.musicxml", before, "1"), files: [] }, { primary: v("s.musicxml", after, "2"), files: [] }).suggestion).toBe("Add Viola");
    expect(diffSuggestion({ primary: v("s.mxl", undefined, "1"), files: [] }, { primary: v("s.mxl", undefined, "2"), files: [] }).suggestion).toBe("Update s.mxl");
    expect(diffSuggestion({ primary: v("s.musicxml", before, "1"), files: [v("s.musicxml", before, "1"), v("n.txt", undefined, "a")] },
      { primary: v("s.musicxml", before, "1"), files: [v("s.musicxml", before, "1"), v("n.txt", undefined, "b")] }).suggestion).toBe("Update n.txt");
  });
});
