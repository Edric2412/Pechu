import { expect, test } from "bun:test";
import { parseNotes, validateNotes } from "../server/gemini";

const good = () => ({
  title: "Budget review",
  summary: "The team reviewed the budget.",
  keyPoints: ["Costs are up", "Hiring paused"],
  decisions: ["Pause hiring"],
  actions: [{ task: "Send the report", owner: "Ravi" }, { task: "Book room", owner: "", due: "" }],
  flow: {
    label: "Budget review",
    kind: "root",
    children: [
      { label: "Costs", kind: "topic", children: [{ label: "Costs are up", kind: "point" }, { label: "Pause hiring", kind: "decision" }] },
    ],
  },
});

test("accepts a good notes object and drops empty owner/due", () => {
  const n = validateNotes(good());
  expect(n.title).toBe("Budget review");
  expect(n.actions).toEqual([{ task: "Send the report", owner: "Ravi" }, { task: "Book room" }]);
  expect(n.flow.children?.[0]?.children?.[1]?.kind).toBe("decision");
});

test("rejects malformed shapes", () => {
  expect(() => validateNotes(null)).toThrow();
  expect(() => validateNotes("text")).toThrow();
  expect(() => validateNotes({ ...good(), title: "" })).toThrow();
  expect(() => validateNotes({ ...good(), summary: 5 })).toThrow();
  expect(() => validateNotes({ ...good(), keyPoints: "one" })).toThrow();
  expect(() => validateNotes({ ...good(), flow: undefined })).toThrow();
  expect(() => validateNotes({ ...good(), flow: { kind: "root" } })).toThrow();
  expect(() => validateNotes({ ...good(), flow: { label: "x", kind: "root", children: [{ kind: "topic" }] } })).toThrow();
});

test("flow is cut at depth 4 and unknown kinds are repaired", () => {
  const deep = { label: "a", kind: "root", children: [{ label: "b", kind: "weird", children: [{ label: "c", kind: "point", children: [{ label: "d", kind: "point", children: [{ label: "e", kind: "point" }] }] }] }] };
  const n = validateNotes({ ...good(), flow: deep });
  expect(n.flow.children?.[0]?.kind).toBe("point");
  expect(n.flow.children?.[0]?.children?.[0]?.children?.[0]?.children).toBeUndefined();
});

test("parseNotes reads fenced JSON and rejects text that is not notes", () => {
  const text = "```json\n" + JSON.stringify(good()) + "\n```";
  expect(parseNotes(text).title).toBe("Budget review");
  expect(() => parseNotes("not json")).toThrow();
  expect(() => parseNotes(JSON.stringify({ ...good(), title: "" }))).toThrow();
});
