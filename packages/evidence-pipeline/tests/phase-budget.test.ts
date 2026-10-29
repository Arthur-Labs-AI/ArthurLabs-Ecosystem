import { describe, it, expect, vi } from 'vitest';
import {
  limitPhase,
  PhaseDeadlineReached,
  investigationDeadline,
  reportAttemptDeadline,
  ObservedToolNotes,
} from '../src/phase-budget.js';
describe('host reporting reserve', () => {
  it('never starts provider work after the absolute deadline', async () => {
    const called = vi.fn();
    async function* work() {
      called();
      yield* [];
    }
    const stop = vi.fn(async () => undefined);
    await expect(
      limitPhase(work(), Date.now() - 1, stop, 'Reporting').next(),
    ).rejects.toBeInstanceOf(PhaseDeadlineReached);
    expect(called).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('reserves only a fixed reporting window, never extends the run', () => {
    // Investigation keeps everything except a fixed 5-minute reporting
    // reserve; the reserve must not grow with the safety fuse.
    expect(investigationDeadline(7_200_000, 0)).toBe(6_900_000);
    expect(investigationDeadline(1800000, 0)).toBe(1500000);
    expect(investigationDeadline(1800000, 300000)).toBe(1500000);
    // Tiny synthetic budgets keep a proportional reserve so fixtures retain
    // a usable reporting window.
    expect(investigationDeadline(90000, 0)).toBe(60000);
    expect(reportAttemptDeadline(600000, 1, 0)).toBe(285000);
    expect(reportAttemptDeadline(600000, 2, 285000)).toBe(570000);
  });
  it('keeps only bounded public tool output, never reasoning', () => {
    const notes = new ObservedToolNotes();
    notes.add({ type: 'agent.message', message: 'private model reasoning' } as never);
    notes.add({ type: 'agent.message', message: 'tool Read: ' + 'x'.repeat(90000) } as never);
    const result = JSON.parse(notes.render());
    expect(result.truncated).toBe(true);
    expect(result.outputs.join('').length).toBeLessThanOrEqual(80000);
    expect(notes.render()).not.toContain('private model reasoning');
  });
  it('does not close a normally completed source or alter its return value', async () => {
    const stop = vi.fn(async () => undefined);
    async function* work() {
      yield* [];
      return 42;
    }
    expect(await limitPhase(work(), Date.now() + 10000, stop).next()).toEqual({
      done: true,
      value: 42,
    });
    expect(stop).not.toHaveBeenCalled();
  });
  it('stops owned work and closes interrupted tools without invented exits', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.fn(async () => {
      release();
    });
    async function* work() {
      yield { type: 'tool.started', operationId: 'op_1', tool: { name: 'bash' } } as never;
      await blocked;
      throw new Error('stopped');
    }
    const stream = limitPhase(work(), Date.now() + 100, stop);
    try {
      expect((await stream.next()).value).toMatchObject({ type: 'tool.started' });
      const next = stream.next();
      await vi.advanceTimersByTimeAsync(100);
      expect((await next).value).toMatchObject({ type: 'tool.completed', tool: { name: 'bash' } });
      await expect(stream.next()).rejects.toBeInstanceOf(PhaseDeadlineReached);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
