import { describe, expect, test } from "bun:test";
// @ts-ignore plain JS module
import { normalizeNotes, applyEdit, notesToMarkdown } from "../public/js/summary-view.js";
// @ts-ignore plain JS module
import { fitScale } from "../public/js/export.js";

const OLD = {
  title: "Budget call",
  summary: "We talked budget.",
  keyPoints: ["Costs are up", "பட்ஜெட் அதிகம்"],
  decisions: ["Freeze hiring"],
  actions: [{ task: "Send report", owner: "Priya", due: "Friday" }],
  flow: { label: "Budget call", kind: "root", children: [] },
};

const V2 = {
  title: "Launch plan",
  summary: "Launch moves to May.",
  sections: [
    { heading: "Timeline", bullets: [{ text: "Speaker 1 proposed May", at: 75 }, { text: "No stamp here" }] },
    { heading: "Risks", bullets: [{ text: "Vendor delay", at: 3725 }] },
  ],
  keyPoints: [{ text: "May launch", at: 10 }],
  decisions: [{ text: "Ship in May", who: "Speaker 2", at: 80 }, { text: "No owner" }],
  actions: [{ task: "Book venue", owner: "Anu", due: "Mon", at: 90 }, { task: "Call vendor" }],
  flow: { label: "Launch plan", kind: "root" },
  process: { steps: [] },
};

describe("normalizeNotes", () => {
  test("old notes become v2 with empty sections", () => {
    const n = normalizeNotes(OLD);
    expect(n.sections).toEqual([]);
    expect(n.keyPoints).toEqual([{ text: "Costs are up" }, { text: "பட்ஜெட் அதிகம்" }]);
    expect(n.decisions).toEqual([{ text: "Freeze hiring" }]);
    expect(n.actions).toEqual([{ task: "Send report", owner: "Priya", due: "Friday" }]);
    expect(n.flow).toBe(OLD.flow);
    expect(n.process).toBeUndefined();
  });

  test("v2 notes pass through unchanged and are copied", () => {
    const n = normalizeNotes(V2);
    expect(n).toEqual(V2);
    expect(n.sections).not.toBe(V2.sections);
    expect(n.sections[0].bullets[0]).not.toBe(V2.sections[0].bullets[0]);
  });

  test("empty, null and junk never throw", () => {
    const empty = { title: "", summary: "", sections: [], keyPoints: [], decisions: [], actions: [] };
    for (const junk of [undefined, null, {}, "text", 5, [], [1, 2]]) expect(normalizeNotes(junk as any)).toEqual(empty);
    const n = normalizeNotes({
      summary: 7, sections: [null, "x", { heading: 3, bullets: "no" }, { bullets: [{ text: "ok", at: "12" }] }],
      keyPoints: [null, 4, "", "  ", { text: "kept", at: -1 }, { text: "k2", at: 2.9 }, { text: "k3", at: "abc" }],
      decisions: "nope", actions: [null, { owner: "x" }, "do it", { task: "t", owner: 5, due: {} }],
    } as any);
    expect(n.summary).toBe("7");
    expect(n.sections).toEqual([{ heading: "3", bullets: [] }, { heading: "", bullets: [{ text: "ok", at: 12 }] }]);
    expect(n.keyPoints).toEqual([{ text: "kept" }, { text: "k2", at: 2 }, { text: "k3" }]);
    expect(n.decisions).toEqual([]);
    expect(n.actions).toEqual([{ task: "do it" }, { task: "t", owner: "5" }]);
  });
});

describe("applyEdit", () => {
  test("returns a new object and leaves the input alone", () => {
    const before = JSON.stringify(V2);
    const out = applyEdit(V2, ["sections", 0, "bullets", 1, "text"], "Changed");
    expect(JSON.stringify(V2)).toBe(before);
    expect(out.sections[0].bullets[1].text).toBe("Changed");
    expect(out.sections[0].bullets[0]).toEqual(V2.sections[0].bullets[0]);
    expect(out.sections[1]).toEqual(V2.sections[1]);
    expect(out).not.toBe(V2);
  });

  test("edits summary, heading and action fields", () => {
    expect(applyEdit(V2, ["summary"], "New").summary).toBe("New");
    expect(applyEdit(V2, ["sections", 1, "heading"], "Dangers").sections[1].heading).toBe("Dangers");
    expect(applyEdit(V2, ["actions", 1, "owner"], "Ravi").actions[1]).toEqual({ task: "Call vendor", owner: "Ravi" });
    expect(applyEdit(V2, ["decisions", 1, "who"], "Anu").decisions[1].who).toBe("Anu");
  });

  test("replaces whole arrays (add and remove)", () => {
    const added = applyEdit(V2, ["keyPoints"], [...V2.keyPoints, { text: "Another" }]);
    expect(added.keyPoints.map((k: any) => k.text)).toEqual(["May launch", "Another"]);
    const removed = applyEdit(V2, ["sections", 0, "bullets"], V2.sections[0].bullets.slice(1));
    expect(removed.sections[0].bullets).toEqual([{ text: "No stamp here" }]);
  });

  test("clearing an optional field removes it", () => {
    const out = applyEdit(V2, ["actions", 0, "due"], "");
    expect(out.actions[0]).toEqual({ task: "Book venue", owner: "Anu", at: 90 });
  });

  test("old notes are normalised first so item paths work", () => {
    const out = applyEdit(OLD, ["keyPoints", 0, "text"], "Costs are way up");
    expect(out.keyPoints[0]).toEqual({ text: "Costs are way up" });
    expect(out.flow).toBe(OLD.flow);
    expect(out.sections).toEqual([]);
  });

  test("bad paths leave the notes unchanged", () => {
    const base = normalizeNotes(V2);
    expect(applyEdit(V2, ["sections", 9, "heading"], "x")).toEqual(base);
    expect(applyEdit(V2, ["nope", 0, "x"], "x")).toEqual(base);
    expect(applyEdit(V2, ["__proto__", "x"], "x")).toEqual(base);
    expect(applyEdit(V2, [], "x" as any)).toBe("x");
    expect(({} as any).x).toBeUndefined();
  });
});

describe("notesToMarkdown", () => {
  test("v2 notes", () => {
    expect(notesToMarkdown(V2, "Launch plan")).toBe(
      [
        "# Launch plan",
        "Launch moves to May.",
        "## Timeline\n\n- Speaker 1 proposed May\n- No stamp here",
        "## Risks\n\n- Vendor delay",
        "## Key points\n\n- May launch",
        "## Decisions\n\n- Ship in May (Speaker 2)\n- No owner",
        "## Actions\n\n- Book venue (Anu, Mon)\n- Call vendor",
      ].join("\n\n") + "\n",
    );
  });

  test("no timestamps appear", () => {
    expect(notesToMarkdown(V2, "x")).not.toMatch(/\d:\d\d|\[\d/);
  });

  test("old notes: summary, key points, decisions, actions only", () => {
    const md = notesToMarkdown(OLD);
    expect(md.startsWith("# Budget call\n\nWe talked budget.")).toBe(true);
    expect(md).toContain("## Key points\n\n- Costs are up\n- பட்ஜெட் அதிகம்");
    expect(md).toContain("## Decisions\n\n- Freeze hiring");
    expect(md).toContain("## Actions\n\n- Send report (Priya, Friday)");
  });

  test("empty parts are left out and junk does not throw", () => {
    expect(notesToMarkdown({ summary: "Only this" }, "")).toBe("Only this\n");
    expect(notesToMarkdown(null as any, "T")).toBe("# T\n");
  });

  test("multi-line text stays on one bullet", () => {
    expect(notesToMarkdown({ keyPoints: ["a\nb"] })).toContain("- a b");
  });
});

describe("fitScale", () => {
  test("keeps the scale for normal charts and shrinks for huge ones", () => {
    expect(fitScale(800, 600, 2)).toBe(2);
    expect(fitScale(10000, 500, 2)).toBeCloseTo(1.2);
    expect(fitScale(0, 0, 2)).toBe(2);
  });
});
