import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Sample } from './catalogue.ts'
import { createVanishTracker } from './vanish.ts'

const instances = (type: string, value: number, timestamp: number): Sample => ({
  name: 'github_aws_runners_instances',
  labels: { environment: 'ci', instance_type: type },
  value,
  timestamp,
})
const capacity: Sample = {
  name: 'github_aws_runners_capacity',
  labels: { environment: 'ci' },
  value: 10,
  timestamp: 1,
}

describe('createVanishTracker', () => {
  it('sends a vanished series as 0 for a few samples, then forgets it', () => {
    const tracker = createVanishTracker(2)
    tracker.apply([instances('m7g.large', 3, 1)], { ec2: true }, 1)
    const second = tracker.apply([], { ec2: true }, 2)
    assert.deepEqual(second, [instances('m7g.large', 0, 2)])
    assert.deepEqual(tracker.apply([], { ec2: true }, 3), [instances('m7g.large', 0, 3)])
    assert.deepEqual(tracker.apply([], { ec2: true }, 4), [])
  })

  it('keeps remembering while the source is down, and zeros once it is back', () => {
    const tracker = createVanishTracker(1)
    tracker.apply([instances('m7g.large', 3, 1)], { ec2: true }, 1)
    assert.deepEqual(tracker.apply([], { ec2: false }, 2), [])
    assert.deepEqual(tracker.apply([], { ec2: true }, 3), [instances('m7g.large', 0, 3)])
  })

  it('leaves fixed series alone: they are zero-filled by the model', () => {
    const tracker = createVanishTracker()
    tracker.apply([capacity], { ec2: true }, 1)
    assert.deepEqual(tracker.apply([], { ec2: true }, 2), [])
  })

  it('resets the countdown when a series comes back', () => {
    const tracker = createVanishTracker(1)
    tracker.apply([instances('a', 1, 1)], { ec2: true }, 1)
    tracker.apply([], { ec2: true }, 2)
    tracker.apply([instances('a', 2, 3)], { ec2: true }, 3)
    assert.deepEqual(tracker.apply([], { ec2: true }, 4), [instances('a', 0, 4)])
  })
})
