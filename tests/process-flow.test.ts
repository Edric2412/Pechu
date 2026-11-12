import { expect, test } from "bun:test";
// @ts-ignore plain browser module, no types
import { layoutProcess } from "../public/js/process-flow.js";

type Step = { id: string; label: string; kind: string; who?: string; at?: number; next: { to: string; label?: string }[] };
const step = (id: string, kind: string, next: [string, string?][] = [], extra: Partial<Step> = {}): Step =>
  ({ id, label: `Step ${id}`, kind, next: next.map(([to, label]) => ({ to, label })), ...extra });

const linear = (n: number) =>
  ({ steps: Array.from({ length: n }, (_, i) => step(`s${i}`, i === 0 ? "start" : i === n - 1 ? "end" : "step", i < n - 1 ? [[`s${i + 1}`]] : [])) });

// Shared checks: sizes, ids, no two boxes touching, arrows start and end on real boxes, everything inside the canvas.
function check(process: { steps: Step[] }, lay = layoutProcess(process)) {
  expect(lay.width).toBeGreaterThan(0);
  expect(lay.height).toBeGreaterThan(0);
  expect(lay.nodes.length).toBe(process.steps.length);
  const ids = new Set(lay.nodes.map((n: any) => n.id));
  for (const e of lay.edges) {
    expect(ids.has(e.from)).toBe(true);
    expect(ids.has(e.to)).toBe(true);
    expect(e.points.length).toBeGreaterThanOrEqual(2);
    for (const p of e.points) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(lay.width);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(lay.height);
    }
    for (let i = 1; i < e.points.length; i++) { // orthogonal only
      expect(e.points[i].x === e.points[i - 1].x || e.points[i].y === e.points[i - 1].y).toBe(true);
    }
    const to = lay.nodes.find((n: any) => n.id === e.to);
    expect(e.points[e.points.length - 1].y).toBe(to.y); // the arrow lands on the top edge
  }
  for (const n of lay.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0); expect(n.x + n.w).toBeLessThanOrEqual(lay.width);
    expect(n.y).toBeGreaterThanOrEqual(0); expect(n.y + n.h).toBeLessThanOrEqual(lay.height);
  }
  for (let i = 0; i < lay.nodes.length; i++) {
    for (let j = i + 1; j < lay.nodes.length; j++) {
      const a = lay.nodes[i], b = lay.nodes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart).toBe(true);
    }
  }
  return lay;
}

test("a linear process runs top to bottom with no loops", () => {
  const lay = check(linear(5));
  expect(lay.edges.length).toBe(4);
  expect(lay.edges.some((e: any) => e.back)).toBe(false);
  const ys = lay.nodes.map((n: any) => n.y);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(new Set(lay.nodes.map((n: any) => n.x + n.w / 2)).size).toBe(1); // one straight column
});

test("a decision puts its two branches side by side", () => {
  const p = { steps: [
    step("a", "start", [["q"]]),
    step("q", "decision", [["y", "Yes"], ["n", "No"]], { label: "Is it approved?" }),
    step("y", "step", [["z"]]),
    step("n", "step", [["z"]]),
    step("z", "end"),
  ] };
  const lay = check(p);
  const get = (id: string) => lay.nodes.find((n: any) => n.id === id);
  expect(get("y").y).toBe(get("n").y);
  expect(get("y").x).toBeLessThan(get("n").x); // first branch on the left
  expect(get("z").y).toBeGreaterThan(get("y").y);
  expect(lay.edges.filter((e: any) => e.label).map((e: any) => e.label)).toEqual(["Yes", "No"]);
  expect(lay.edges.some((e: any) => e.back)).toBe(false);
});

test("a retry loop is flagged as a back edge, and only that edge", () => {
  const p = { steps: [
    step("a", "start", [["b"]]),
    step("b", "step", [["c"]]),
    step("c", "decision", [["d", "Yes"], ["b", "No"]]),
    step("d", "end"),
  ] };
  const lay = check(p);
  const back = lay.edges.filter((e: any) => e.back);
  expect(back.length).toBe(1);
  expect([back[0].from, back[0].to]).toEqual(["c", "b"]);
  const b = lay.nodes.find((n: any) => n.id === "b");
  const pts = back[0].points;
  expect(Math.min(...pts.map((q: any) => q.y))).toBeLessThan(b.y); // comes back in above the target
  const bottom = (id: string) => { const n = lay.nodes.find((m: any) => m.id === id); return n.y + n.h; };
  expect(lay.nodes.find((n: any) => n.id === "d").y).toBeGreaterThan(bottom("b"));
});

test("a step pointing at itself or a long way back does not break the layout", () => {
  const p = { steps: [
    step("a", "start", [["b"]]),
    step("b", "step", [["b", "again"], ["c"]]),
    step("c", "step", [["d"]]),
    step("d", "decision", [["e", "Yes"], ["a", "No"], ["b", "Maybe"]]),
    step("e", "end"),
  ] };
  const lay = check(p);
  expect(lay.edges.filter((e: any) => e.back).length).toBe(3);
});

test("a long forward arrow runs beside the boxes, not through them", () => {
  const p = { steps: [
    step("a", "start", [["q"]]),
    step("q", "decision", [["s1", "Yes"], ["e", "No"]]),
    step("s1", "step", [["s2"]]),
    step("s2", "step", [["s3"]]),
    step("s3", "step", [["e"]]),
    step("e", "end"),
  ] };
  const lay = check(p);
  const skip = lay.edges.find((e: any) => e.from === "q" && e.to === "e");
  expect(skip.back).toBe(false);
  for (const n of lay.nodes) {
    if (n.id === "q" || n.id === "e") continue;
    for (let i = 1; i < skip.points.length; i++) {
      const [a, b] = [skip.points[i - 1], skip.points[i]];
      if (a.x !== b.x) continue; // only the vertical runs can cut through a box
      const inside = a.x > n.x && a.x < n.x + n.w && Math.max(a.y, b.y) > n.y && Math.min(a.y, b.y) < n.y + n.h;
      expect(inside).toBe(false);
    }
  }
});

test("a step nothing leads to is placed after the reachable ones", () => {
  const p = { steps: [step("a", "start", [["b"]]), step("b", "end"), step("lost", "step", [["b"]])] };
  const lay = check(p);
  const get = (id: string) => lay.nodes.find((n: any) => n.id === id);
  expect(get("lost").y).toBeGreaterThan(get("b").y);
  expect(lay.edges.find((e: any) => e.from === "lost").back).toBe(true); // it points back up, so it is drawn as a return arrow
});

test("one step, and no steps", () => {
  const one = check({ steps: [step("a", "step")] });
  expect(one.edges).toEqual([]);
  const none = layoutProcess({ steps: [] });
  expect(none.nodes).toEqual([]);
  expect(none.width).toBeGreaterThan(0);
  expect(layoutProcess(undefined as any).nodes).toEqual([]);
});

test("30 steps with branches and loops stay overlap-free", () => {
  const steps: Step[] = [];
  for (let i = 0; i < 30; i++) {
    const next: [string, string?][] = [];
    if (i < 29) next.push([`s${i + 1}`, i % 4 === 3 ? "Yes" : undefined]);
    if (i % 4 === 3 && i + 3 < 30) next.push([`s${i + 3}`, "No"]); // skip ahead
    if (i % 7 === 6) next.push([`s${i - 4}`, "Retry"]); // loop back
    steps.push(step(`s${i}`, i === 0 ? "start" : i === 29 ? "end" : i % 4 === 3 ? "decision" : "step", next));
  }
  const lay = check({ steps });
  expect(lay.edges.some((e: any) => e.back)).toBe(true);
});

test("bad input is ignored: unknown targets, repeated ids, repeated arrows", () => {
  const p = { steps: [
    step("a", "start", [["b"], ["b"], ["ghost"]]),
    step("b", "weird" as any),
    { ...step("b", "end"), label: "dup" },
  ] };
  const lay = check({ steps: p.steps.slice(0, 2) }, layoutProcess(p));
  expect(lay.edges.length).toBe(1);
  expect(lay.nodes.find((n: any) => n.id === "b").kind).toBe("step");
});

test("long labels wrap inside the box and the box grows", () => {
  const long = "Review the vendor contract together with legal and finance before anything is signed or paid ".repeat(3).trim();
  const p = { steps: [
    step("a", "start", [["b"]], { label: "Kick-off " + "x".repeat(200) }),
    step("b", "decision", [["c", "Yes"], ["d", "No"]], { label: long, who: "A very long role name ".repeat(10) }),
    step("c", "step", [], { label: long, who: "Finance" }),
    step("d", "end", [], { label: "Done" }),
  ] };
  const lay = check(p);
  const get = (id: string) => lay.nodes.find((n: any) => n.id === id);
  expect(get("b").lines.length).toBeGreaterThan(2);
  expect(get("b").lines.length).toBeLessThanOrEqual(7);
  expect(get("b").h).toBeGreaterThan(76);
  expect(get("a").lines.length).toBeGreaterThan(1); // the 200-letter word was broken
  expect(get("a").w).toBeLessThanOrEqual(240);
  expect(get("b").who.length).toBeLessThan(200); // shortened to one line
});

test("measure can be injected and drives the wrapping", () => {
  const calls: string[] = [];
  const measure = (t: string, font: string) => { calls.push(font); return t.length * 10; };
  const p = { steps: [step("a", "step", [], { label: "one two three four five six seven eight" })] };
  const lay = layoutProcess(p, measure);
  expect(calls.length).toBeGreaterThan(0);
  for (const line of lay.nodes[0].lines) expect(line.length * 10).toBeLessThanOrEqual(240 - 32);
  expect(lay.nodes[0].lines.join(" ")).toBe("one two three four five six seven eight");
  const wide = layoutProcess(p, () => 1);
  expect(wide.nodes[0].lines.length).toBe(1);
});

test("`at` is kept only when it is a real time", () => {
  const p = { steps: [
    step("a", "start", [["b"]], { at: 75.9 }),
    step("b", "step", [["c"]], { at: -3 }),
    step("c", "end", [], { at: NaN }),
  ] };
  const lay = layoutProcess(p);
  expect(lay.nodes.map((n: any) => n.at)).toEqual([75, undefined, undefined]);
});

test("the same input always gives the same drawing", () => {
  const p = { steps: [
    step("a", "start", [["b"]]),
    step("b", "step", [["c"]], { who: "Priya", at: 12 }),
    step("c", "decision", [["d", "Yes"], ["b", "No"], ["e", "Later"]]),
    step("d", "step", [["e"]]),
    step("e", "end"),
  ] };
  expect(JSON.stringify(layoutProcess(p))).toBe(JSON.stringify(layoutProcess(JSON.parse(JSON.stringify(p)))));
});

test("a node a loop comes back to moves its time chip out of the way", () => {
  const p = { steps: [
    step("a", "start", [["b"]]),
    step("b", "step", [["c"]], { at: 5 }),
    step("c", "decision", [["d", "Yes"], ["b", "No"]]),
    step("d", "end"),
  ] };
  const lay = layoutProcess(p);
  const get = (id: string) => lay.nodes.find((n: any) => n.id === id);
  const back = lay.edges.find((e: any) => e.back);
  const arrivesRight = back.points[back.points.length - 1].x > get("b").x + get("b").w / 2;
  expect(get("b").chipLeft).toBe(arrivesRight);
});
