import type { BoardFrameLayout, BoardManifest, BoardSection } from '../shared/board'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** `after` where it changed from `before` and is still as `before` had it; otherwise `now`. */
function pick<T>(now: T, before: T, after: T): T {
  return !same(before, after) && same(now, before) ? after : now
}

function mergeFrame(
  now: BoardFrameLayout,
  before: BoardFrameLayout,
  after: BoardFrameLayout,
): BoardFrameLayout {
  const place = pick(
    { x: now.x, y: now.y },
    { x: before.x, y: before.y },
    { x: after.x, y: after.y },
  )
  const size = pick(
    { width: now.width, height: now.height },
    { width: before.width, height: before.height },
    { width: after.width, height: after.height },
  )
  return { ...now, ...place, ...size, name: pick(now.name, before.name, after.name) }
}

function mergeSection(now: BoardSection, before: BoardSection, after: BoardSection): BoardSection {
  return {
    ...now,
    name: pick(now.name, before.name, after.name),
    frames: pick(now.frames, before.frames, after.frames),
  }
}

/**
 * Items as they are now, with what changed from `before` to `after` applied: one both have is
 * merged, one only `before` has goes, one only `after` has comes back as `after` had it (in
 * place of however it's on the board now), and one neither has (made since) stays. Then those
 * `after` has that aren't here at all.
 */
function mergeItems<T extends { id: string }>(
  now: readonly T[],
  before: readonly T[],
  after: readonly T[],
  merge: (now: T, before: T, after: T) => T,
): T[] {
  const was = new Map(before.map((item) => [item.id, item]))
  const will = new Map(after.map((item) => [item.id, item]))
  const here = new Set(now.map((item) => item.id))
  const merged: T[] = []
  for (const item of now) {
    const from = was.get(item.id)
    const to = will.get(item.id)
    if (from && to) merged.push(merge(item, from, to))
    else if (to) merged.push(to)
    else if (!from) merged.push(item)
  }
  for (const item of after) if (!here.has(item.id) && !was.has(item.id)) merged.push(item)
  return merged
}

/**
 * A canvas's layout as undoing, redoing or restoring a version leaves it: what changed in the
 * layout from checkpoint `before` to `after`, applied onto the board as it is now (`now`).
 *
 * The rule: each frame's place, size and name, each section's name and frames, and the
 * canvas's name go to how `after` has them where they changed between the two and are still
 * as `before` left them. One changed since (the user's own later move of that frame, say)
 * stays as it is now; so do frames and sections made since, and the camera. Frames that only
 * `after` has come back where `after` had them (their pages are back by now, and the board
 * placed them anew); frames only `before` has go, with their pages.
 *
 * Undoing a turn is `before`: the turn's last checkpoint, `after`: the one before it began.
 */
export function mergeLayout(
  now: BoardManifest,
  before: BoardManifest,
  after: BoardManifest,
): BoardManifest {
  return {
    ...now,
    name: pick(now.name, before.name, after.name),
    frames: mergeItems(now.frames, before.frames, after.frames, mergeFrame),
    sections: mergeItems(now.sections, before.sections, after.sections, mergeSection),
  }
}

/** The same frames and sections, named alike: the camera aside, nothing a user would see moved. */
export function sameLayout(a: BoardManifest | null, b: BoardManifest | null) {
  const layout = (m: BoardManifest | null) =>
    m && { name: m.name, frames: m.frames, sections: m.sections }
  return same(layout(a), layout(b))
}

/**
 * A new frame's name: `base` ("Desktop"), or numbered past every "Desktop N" on the board, so
 * it's never one in use, even after one in the middle was deleted.
 */
export function nextFrameName(base: string, frames: readonly { name: string }[]) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}(?: (\\d+))?$`)
  let highest = 0
  for (const frame of frames) {
    const match = pattern.exec(frame.name)
    if (match) highest = Math.max(highest, match[1] ? Number(match[1]) : 1)
  }
  return highest ? `${base} ${highest + 1}` : base
}
