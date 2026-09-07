/** A bounded, retargetable spring. Values are CSS pixels and pixels/second. */
export function advanceSheetSpring(position: number, velocity: number, target: number, elapsed: number) {
  let remaining = Math.max(0, Math.min(elapsed, 0.032))
  while (remaining > 0) {
    const dt = Math.min(remaining, 1 / 120)
    velocity += ((target - position) * 600 - velocity * 46) * dt
    position += velocity * dt
    remaining -= dt
  }
  const settled = Math.abs(position - target) < 0.25 && Math.abs(velocity) < 2
  return { position: settled ? target : position, velocity: settled ? 0 : velocity, settled }
}

export function sheetReleaseAction(distance: number, velocity: number): 'close' | 'expand' | 'restore' {
  if (distance > 110 || (distance > 12 && velocity > 650)) return 'close'
  if (distance < -60 || (distance < -12 && velocity < -650)) return 'expand'
  return 'restore'
}
