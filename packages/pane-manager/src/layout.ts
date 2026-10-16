import { JsonValueSchema } from "@bflow/contracts";
import type { CommandOutcome } from "./types.js";
import { parseHerdrResponse } from "./runner.js";

type Rect = { x: number; y: number; width: number; height: number };
type Layout = { workspace_id: string; tab_id: string; panes: { pane_id: string; rect: Rect }[];
  splits: { id: string; direction: "right" | "down"; ratio: number; rect: Rect }[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Herdr layout object");
  return value as Record<string, unknown>;
}
function rect(raw: unknown): Rect {
  const value = object(raw);
  for (const name of ["x", "y", "width", "height"]) if (typeof value[name] !== "number" || !Number.isFinite(value[name])) throw new Error("Malformed Herdr layout rectangle");
  if (Number(value.width) <= 0 || Number(value.height) <= 0) throw new Error("Empty Herdr pane geometry");
  return value as Rect;
}
function parse(outcome: CommandOutcome, workspaceId: string, tabId: string): Layout {
  const result = parseHerdrResponse(outcome); JsonValueSchema.parse(result);
  const layout = object(result.layout ?? object(result.resize).layout);
  if (layout.workspace_id !== workspaceId || layout.tab_id !== tabId || !Array.isArray(layout.panes) || !Array.isArray(layout.splits)) throw new Error("Herdr layout belongs to another tab/workspace");
  const panes = layout.panes.map(raw => { const p = object(raw); if (typeof p.pane_id !== "string") throw new Error("Invalid layout pane"); return { pane_id: p.pane_id, rect: rect(p.rect) }; });
  const splits = layout.splits.map(raw => { const s = object(raw);
    if (typeof s.id !== "string" || !["right", "down"].includes(String(s.direction)) || typeof s.ratio !== "number" || s.ratio <= 0 || s.ratio >= 1) throw new Error("Unsupported Herdr split geometry");
    return { id: s.id, direction: s.direction as "right" | "down", ratio: s.ratio, rect: rect(s.rect) }; });
  if (new Set(panes.map(p => p.pane_id)).size !== panes.length || splits.length > panes.length - 1) throw new Error("Invalid layout cardinality");
  return { workspace_id: workspaceId, tab_id: tabId, panes, splits };
}
/** Resize existing boundaries only. layout.apply creates new terminals in Herdr
 * 0.9.5 even with pane_id fields, so it must never be used to repair live roles. */
export async function balanceOwnedTab(run: (args: string[]) => Promise<CommandOutcome>, workspaceId: string, tabId: string, paneIds: string[]): Promise<void> {
  if (paneIds.length < 2) return;
  let current = parse(await run(["pane", "layout", "--pane", paneIds[0]!]), workspaceId, tabId);
  const ownsAll = () => current.panes.length === paneIds.length && current.panes.every(p => paneIds.includes(p.pane_id));
  if (!ownsAll()) return; // An operator-added pane is not ours to rearrange.
  const splits = [...current.splits].sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height).map(s => s.id);
  for (const id of splits) {
    const split = current.splits.find(s => s.id === id); if (!split || !ownsAll()) throw new Error("Pane layout changed during rebalancing; retry bflow up");
    const horizontal = split.direction === "right", r = split.rect;
    const boundary = (horizontal ? r.x : r.y) + (horizontal ? r.width : r.height) * split.ratio;
    const inside = current.panes.filter(p => p.rect.x >= r.x && p.rect.y >= r.y && p.rect.x + p.rect.width <= r.x + r.width && p.rect.y + p.rect.height <= r.y + r.height);
    const first = inside.filter(p => (horizontal ? p.rect.x + p.rect.width : p.rect.y + p.rect.height) <= boundary + 1);
    const second = inside.filter(p => !first.includes(p));
    if (!first.length || !second.length) throw new Error("Cannot identify Herdr split children safely");
    const target = first.length / inside.length, delta = target - split.ratio;
    if (Math.abs(delta) < 0.01) continue;
    const candidates = delta > 0 ? first : second;
    const edge = (p: typeof candidates[number]) => horizontal ? delta > 0 ? p.rect.x + p.rect.width : p.rect.x : delta > 0 ? p.rect.y + p.rect.height : p.rect.y;
    const pane = candidates.sort((a, b) => Math.abs(edge(a) - boundary) - Math.abs(edge(b) - boundary))[0]!;
    const direction = horizontal ? delta > 0 ? "right" : "left" : delta > 0 ? "down" : "up";
    const outcome = await run(["pane", "resize", "--pane", pane.pane_id, "--direction", direction, "--amount", String(Math.abs(delta))]);
    current = parse(outcome, workspaceId, tabId);
    if (!ownsAll()) throw new Error("Layout repair changed role pane identities; stop and inspect bflow doctor");
  }
}
