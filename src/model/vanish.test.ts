import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { METRICS, type Sample } from './catalogue.ts'
import { createVanishTracker, type VanishTracker } from './vanish.ts'

const instances = (type: string, value: number, timestamp: number): Sample => ({
  name: METRICS.instances.name,
  labels: { environment: 'ci', instance_type: type },
  value,
  timestamp,
})
const capacity: Sample = {
  name: METRICS.capacity.name,
  labels: { environment: 'ci' },
  value: 10,
  timestamp: 1,
}

/** Applies and commits, as a successful push does. */
const pushed = (tracker: VanishTracker, ...args: Parameters<VanishTracker['apply']>) => {
  const { samples, commit } = tracker.apply(...args)
  commit()
  return samples
}

describe('createVanishTracker', () => {
  it('sends a vanished series as 0 for a few samples, then forgets it', () => {
    const tracker = createVanishTracker(2)
    pushed(tracker, [instances('m7g.large', 3, 1)], { ec2: true }, 1)
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 2), [instances('m7g.large', 0, 2)])
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 3), [instances('m7g.large', 0, 3)])
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 4), [])
  })

  it('keeps remembering while the source is down, and zeros once it is back', () => {
    const tracker = createVanishTracker(1)
    pushed(tracker, [instances('m7g.large', 3, 1)], { ec2: true }, 1)
    assert.deepEqual(pushed(tracker, [], { ec2: false }, 2), [])
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 3), [instances('m7g.large', 0, 3)])
  })

  it('leaves fixed series alone: they are zero-filled by the model', () => {
    const tracker = createVanishTracker()
    pushed(tracker, [capacity], { ec2: true }, 1)
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 2), [])
  })

  it('resets the countdown when a series comes back', () => {
    const tracker = createVanishTracker(1)
    pushed(tracker, [instances('a', 1, 1)], { ec2: true }, 1)
    pushed(tracker, [], { ec2: true }, 2)
    pushed(tracker, [instances('a', 2, 3)], { ec2: true }, 3)
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 4), [instances('a', 0, 4)])
  })

  it('changes nothing until the push is committed', () => {
    const tracker = createVanishTracker(1)
    pushed(tracker, [instances('a', 1, 1)], { ec2: true }, 1)
    // The push of the zero failed: the zero is offered again next time.
    tracker.apply([], { ec2: true }, 2)
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 3), [instances('a', 0, 3)])
    // A series first seen in a failed push is not remembered either.
    tracker.apply([instances('b', 1, 4)], { ec2: true }, 4)
    assert.deepEqual(pushed(tracker, [], { ec2: true }, 5), [])
  })
})
