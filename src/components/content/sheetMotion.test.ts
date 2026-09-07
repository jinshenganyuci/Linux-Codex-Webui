import { describe, expect, it } from 'vitest'
import { advanceSheetSpring, sheetReleaseAction } from './sheetMotion'

describe('sheet spring and gesture intent', () => {
  it('settles at different refresh rates without a visible jump or overshoot', () => {
    for (const hz of [30, 60, 120]) {
      let position = 600, velocity = 0
      for (let frame = 0; frame < hz * 2; frame++) {
        const next = advanceSheetSpring(position, velocity, 0, 1 / hz)
        expect(next.position).toBeGreaterThanOrEqual(0)
        expect(next.position).toBeLessThanOrEqual(position)
        position = next.position; velocity = next.velocity
      }
      expect(position).toBe(0)
    }
  })
  it('retains position and velocity when reversing, and bounds a background-tab time gap', () => {
    const opening = advanceSheetSpring(400, -1500, 0, 0.016)
    const closing = advanceSheetSpring(opening.position, opening.velocity, 600, 0.016)
    expect(Math.abs(closing.position - opening.position)).toBeLessThan(50)
    expect(closing.velocity).toBeGreaterThan(opening.velocity)
    expect(advanceSheetSpring(300, 0, 0, 60)).toEqual(advanceSheetSpring(300, 0, 0, 0.032))
  })
  it('distinguishes a deliberate flick from a tap, upward drag and cancelled short drag', () => {
    expect(sheetReleaseAction(2, 1000)).toBe('restore')
    expect(sheetReleaseAction(25, 800)).toBe('close')
    expect(sheetReleaseAction(120, 0)).toBe('close')
    expect(sheetReleaseAction(60, -900)).toBe('restore')
    expect(sheetReleaseAction(-90, 0)).toBe('expand')
    expect(sheetReleaseAction(-20, -800)).toBe('expand')
  })
})
