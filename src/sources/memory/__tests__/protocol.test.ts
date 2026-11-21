import { describe, expect, it } from 'vitest'
import { JsonlLineBuffer, parseHelperMessage } from '../protocol'

describe('parseHelperMessage', () => {
  it('parses a valid hello', () => {
    const result = parseHelperMessage({
      type: 'hello', protocolVersion: 1, readerVersion: '1.0.0', profileId: 'tbh-1.2.8-a',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.message.type === 'hello') {
      expect(result.message.readerVersion).toBe('1.0.0')
    }
  })

  it('rejects protocol mismatch on every message family', () => {
    for (const type of ['hello', 'health', 'live', 'run_completed', 'run_rejected']) {
      const result = parseHelperMessage({ type, protocolVersion: 2 })
      expect(result).toEqual({ ok: false, error: 'protocol-mismatch' })
    }
  })

  it('rejects unknown message types without failing', () => {
    expect(parseHelperMessage({ type: 'mystery', protocolVersion: 1 })).toEqual({ ok: false, error: 'unknown-type' })
    expect(parseHelperMessage('a string')).toEqual({ ok: false, error: 'not-an-object' })
    expect(parseHelperMessage([1, 2])).toEqual({ ok: false, error: 'not-an-object' })
  })

  it('parses health with honest null handling', () => {
    const result = parseHelperMessage({
      type: 'health', protocolVersion: 1, seq: 3, observedAtMs: 5,
      state: 'healthy', reasonCode: 'OK', detail: null, gameVersion: '1.2.8',
      gameFingerprint: '1.2.8-0x6ab23e8a-0x6b47000', profileId: 'p', healthEpoch: null,
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.message.type === 'health') {
      expect(result.message.healthEpoch).toBeNull()
      expect(result.message.state).toBe('healthy')
    }
  })

  it('parses run_completed with heroes and preserves null metrics', () => {
    const result = parseHelperMessage({
      type: 'run_completed', protocolVersion: 1, seq: 4, observedAtMs: 9,
      run: {
        id: '1790000000000', stageKey: 2205, difficulty: 1, startedAtMs: 1, endedAtMs: 2,
        durationMs: 1000, officialClearTimeMs: null, outcome: 'success', captureQuality: 'complete',
        xpValue: null, xpSource: null, xpConfidence: null, goldValue: 100, goldSource: 'live',
        goldConfidence: 'measured', damage: 5, averageDps: 5, mobsKilled: 10, mobsTotal: 11,
        gameVersion: '1.2.8', gameFingerprint: 'fp', readerVersion: '1.0.0', profileId: 'p',
        sourceHealthEpoch: 'e', reconciliationStatus: null, sessionId: null, buildId: null,
        heroes: [{ heroKey: 201, slot: null, levelStart: 37, levelEnd: 37, xpGained: 40 }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.message.type === 'run_completed') {
      expect(result.message.run.xpValue).toBeNull()
      expect(result.message.run.heroes[0].slot).toBeNull()
    }
  })

  it('rejects malformed run_completed (missing required identity)', () => {
    expect(
      parseHelperMessage({ type: 'run_completed', protocolVersion: 1, seq: 1, run: { stageKey: 1 } }),
    ).toEqual({ ok: false, error: 'malformed-json' })
  })
})

describe('JsonlLineBuffer', () => {
  function collect(): { lines: string[]; overflows: number } {
    return { lines: [], overflows: 0 }
  }

  it('handles fragmented chunks across lines', () => {
    const sink = collect()
    const buffer = new JsonlLineBuffer(
      1024 * 1024,
      (line) => sink.lines.push(line),
      () => sink.overflows++,
    )
    buffer.push('{"type":"hel')
    buffer.push('lo","a":1}\n{"type"')
    buffer.push(':"health"}\n')
    expect(sink.lines).toEqual(['{"type":"hello","a":1}', '{"type":"health"}'])
    expect(sink.overflows).toBe(0)
  })

  it('handles multiple lines per chunk and CRLF', () => {
    const sink = collect()
    const buffer = new JsonlLineBuffer(1024 * 1024, (l) => sink.lines.push(l), () => sink.overflows++)
    buffer.push('{"a":1}\r\n{"b":2}\r\n')
    expect(sink.lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('drops malformed JSON lines without throwing (reported by caller)', () => {
    const sink = collect()
    const buffer = new JsonlLineBuffer(1024 * 1024, (l) => sink.lines.push(l), () => sink.overflows++)
    expect(() => buffer.push('not json\n{"a":1}\n')).not.toThrow()
    expect(sink.lines).toEqual(['not json', '{"a":1}'])
  })

  it('drains oversized lines instead of buffering forever', () => {
    const sink = collect()
    const buffer = new JsonlLineBuffer(64, (l) => sink.lines.push(l), () => sink.overflows++)
    buffer.push('x'.repeat(200)) // no newline yet — over the cap
    expect(sink.overflows).toBe(1)
    buffer.push('more-garbage') // still part of the drained runaway line
    buffer.push('-tail\n') // ...terminates it
    buffer.push('{"ok":1}\n') // the NEXT well-formed line survives intact
    expect(sink.lines).toEqual(['{"ok":1}'])
  })

  it('flush() emits a trailing line without newline once', () => {
    const sink = collect()
    const buffer = new JsonlLineBuffer(1024 * 1024, (l) => sink.lines.push(l), () => sink.overflows++)
    buffer.push('{"tail":true}')
    buffer.flush()
    buffer.flush() // second flush is a no-op
    expect(sink.lines).toEqual(['{"tail":true}'])
  })
})
