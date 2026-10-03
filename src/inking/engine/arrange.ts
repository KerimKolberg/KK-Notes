/**
 * What can be done with a selection beyond moving, stretching and turning it:
 * grouping it, lining its parts up, spacing them evenly, and taking copies of it.
 *
 * All of it is pure: lists of strokes in, lists of strokes out, in page units. The
 * store puts the results on the undo stack; nothing here knows about a page or a
 * clipboard except as numbers and arrays.
 */
import type { BBox, Point, Stroke } from '../types';
import { bboxUnion } from './geometry';
import { createStrokeId } from './ids';
import { transformStroke } from './lasso';

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function createGroupId(): string {
  return `g_${createStrokeId()}`;
}

/**
 * The ids of `ids` and everything grouped with any of them, in the order the strokes
 * are in. A lasso that takes one stroke of a group takes the group.
 */
export function expandToGroups(strokes: readonly Stroke[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const groups = new Set<string>();
  for (const stroke of strokes) if (wanted.has(stroke.id) && stroke.groupId !== undefined) groups.add(stroke.groupId);
  if (groups.size === 0) return [...ids];
  const out: string[] = [];
  for (const stroke of strokes) {
    if (wanted.has(stroke.id) || (stroke.groupId !== undefined && groups.has(stroke.groupId))) out.push(stroke.id);
  }
  return out;
}

/** Put the selected strokes in one group. */
export function groupStrokes(strokes: readonly Stroke[], ids: ReadonlySet<string>, groupId: string): Stroke[] {
  return strokes.map((s) => (ids.has(s.id) && s.groupId !== groupId ? ({ ...s, groupId } as Stroke) : s));
}

/** Take the selected strokes out of whatever group they are in. */
export function ungroupStrokes(strokes: readonly Stroke[], ids: ReadonlySet<string>): Stroke[] {
  return strokes.map((s) => {
    if (!ids.has(s.id) || s.groupId === undefined) return s;
    const { groupId: _gone, ...rest } = s;
    return rest as Stroke;
  });
}

/** Whether grouping would change anything: two or more strokes that are not already one group. */
export function canGroup(selected: readonly Stroke[]): boolean {
  if (selected.length < 2) return false;
  const first = selected[0]?.groupId;
  return first === undefined || selected.some((s) => s.groupId !== first);
}

/** Whether any of the selection is in a group. */
export function hasGroup(selected: readonly Stroke[]): boolean {
  return selected.some((s) => s.groupId !== undefined);
}

// ---------------------------------------------------------------------------
// Lining up
// ---------------------------------------------------------------------------

/**
 * One thing to line up: a stroke on its own, or a whole group, which moves as one.
 * `bounds` is the padded box the strokes are culled by, so that the outer edges of
 * thick and thin lines are what meet.
 */
export interface ArrangeUnit {
  readonly ids: readonly string[];
  readonly bounds: BBox;
}

export function arrangeUnits(selected: readonly Stroke[]): ArrangeUnit[] {
  const byKey = new Map<string, { ids: string[]; bounds: BBox }>();
  for (const stroke of selected) {
    const key = stroke.groupId ?? stroke.id;
    const unit = byKey.get(key);
    if (unit) {
      unit.ids.push(stroke.id);
      unit.bounds = bboxUnion(unit.bounds, stroke.bbox);
    } else {
      byKey.set(key, { ids: [stroke.id], bounds: stroke.bbox });
    }
  }
  return [...byKey.values()];
}

export type AlignMode = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

export type ArrangeOp =
  | { readonly kind: 'align'; readonly mode: AlignMode }
  | { readonly kind: 'distribute'; readonly axis: DistributeAxis };

/** Aligning needs two things to line up; spreading them evenly needs three. */
export function canAlign(units: readonly ArrangeUnit[]): boolean {
  return units.length >= 2;
}
export function canDistribute(units: readonly ArrangeUnit[]): boolean {
  return units.length >= 3;
}

function unionOf(units: readonly ArrangeUnit[]): BBox {
  let box = units[0]!.bounds;
  for (const unit of units) box = bboxUnion(box, unit.bounds);
  return box;
}

/** How far each unit moves for `op`, in the order of `units`. */
export function arrangeOffsets(units: readonly ArrangeUnit[], op: ArrangeOp): Point[] {
  if (op.kind === 'align') {
    if (!canAlign(units)) return units.map(() => ({ x: 0, y: 0 }));
    const all = unionOf(units);
    return units.map(({ bounds: b }) => {
      switch (op.mode) {
        case 'left':
          return { x: all.minX - b.minX, y: 0 };
        case 'right':
          return { x: all.maxX - b.maxX, y: 0 };
        case 'centre':
          return { x: (all.minX + all.maxX) / 2 - (b.minX + b.maxX) / 2, y: 0 };
        case 'top':
          return { x: 0, y: all.minY - b.minY };
        case 'bottom':
          return { x: 0, y: all.maxY - b.maxY };
        case 'middle':
          return { x: 0, y: (all.minY + all.maxY) / 2 - (b.minY + b.maxY) / 2 };
      }
    });
  }

  // Distribute: the outermost two stay where they are and the gaps between every
  // neighbouring pair come out equal.
  const offsets: Point[] = units.map(() => ({ x: 0, y: 0 }));
  if (!canDistribute(units)) return offsets;
  const horizontal = op.axis === 'horizontal';
  const low = (b: BBox): number => (horizontal ? b.minX : b.minY);
  const high = (b: BBox): number => (horizontal ? b.maxX : b.maxY);
  const order = units.map((unit, index) => ({ unit, index })).sort((a, b) => low(a.unit.bounds) - low(b.unit.bounds));
  const first = order[0]!.unit.bounds;
  const span = Math.max(...order.map((o) => high(o.unit.bounds))) - low(first);
  const used = order.reduce((sum, o) => sum + (high(o.unit.bounds) - low(o.unit.bounds)), 0);
  const gap = (span - used) / (order.length - 1);
  let cursor = low(first);
  for (const { unit, index } of order) {
    const shift = cursor - low(unit.bounds);
    offsets[index] = horizontal ? { x: shift, y: 0 } : { x: 0, y: shift };
    cursor += high(unit.bounds) - low(unit.bounds) + gap;
  }
  return offsets;
}

/**
 * The strokes with the selection lined up or spread as `op` says. Strokes that do
 * not move are returned as they were, so a caller can tell nothing happened.
 */
export function arrangeStrokes(strokes: readonly Stroke[], ids: ReadonlySet<string>, op: ArrangeOp): Stroke[] {
  const selected = strokes.filter((s) => ids.has(s.id));
  const units = arrangeUnits(selected);
  const offsets = arrangeOffsets(units, op);
  const moveOf = new Map<string, Point>();
  units.forEach((unit, i) => {
    const o = offsets[i]!;
    if (Math.abs(o.x) < 1e-6 && Math.abs(o.y) < 1e-6) return;
    for (const id of unit.ids) moveOf.set(id, o);
  });
  if (moveOf.size === 0) return [...strokes];
  return strokes.map((s) => {
    const o = moveOf.get(s.id);
    return o ? transformStroke(s, { kind: 'translate', dx: o.x, dy: o.y }) : s;
  });
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

/** Give each group among `strokes` a group of its own, so a copy is not grouped with its original. */
export function regroup(strokes: readonly Stroke[]): Stroke[] {
  const fresh = new Map<string, string>();
  return strokes.map((s) => {
    if (s.groupId === undefined) return s;
    let id = fresh.get(s.groupId);
    if (id === undefined) {
      id = createGroupId();
      fresh.set(s.groupId, id);
    }
    return { ...s, groupId: id } as Stroke;
  });
}

/**
 * Copies of `items` to put on a page that is `page` big: new ids, new groups, moved by
 * `offset`, and then moved back inside the page if that put them over its edge (a
 * selection bigger than the page stays put against its top-left).
 */
export function pastedCopies(items: readonly Stroke[], offset: Point, page: { readonly width: number; readonly height: number }): Stroke[] {
  if (items.length === 0) return [];
  const moved = items.map((s) => transformStroke(s, { kind: 'translate', dx: offset.x, dy: offset.y }));
  let box = moved[0]!.bbox;
  for (const s of moved) box = bboxUnion(box, s.bbox);
  let dx = 0;
  let dy = 0;
  if (box.maxX > page.width) dx = page.width - box.maxX;
  if (box.minX + dx < 0) dx = -box.minX;
  if (box.maxY > page.height) dy = page.height - box.maxY;
  if (box.minY + dy < 0) dy = -box.minY;
  const placed = dx === 0 && dy === 0 ? moved : moved.map((s) => transformStroke(s, { kind: 'translate', dx, dy }));
  return regroup(placed).map((s) => ({ ...s, id: createStrokeId(), createdAt: performance.now() }) as Stroke);
}
