import { describe, expect, it } from 'bun:test';
import { aggregateHealth, collectHealth, errorMessage, healthReport } from '../health.js';

describe('health helpers', () => {
  it('aggregates worst status', () => {
    const r = (s: any) => healthReport(s);
    expect(aggregateHealth({})).toBe('up');
    expect(aggregateHealth({ a: r('up'), b: r('up') })).toBe('up');
    expect(aggregateHealth({ a: r('up'), b: r('degraded') })).toBe('degraded');
    expect(aggregateHealth({ a: r('degraded'), b: r('down') })).toBe('down');
  });

  it('collectHealth reports a throwing check as down instead of throwing', async () => {
    const reports = await collectHealth([
      { componentName: 'good', checkHealth: async () => healthReport('up') },
      { componentName: 'bad', checkHealth: async () => { throw new Error('exploded'); } },
    ]);
    expect(reports.good!.status).toBe('up');
    expect(reports.bad).toMatchObject({ status: 'down', detail: 'exploded' });
  });

  it('errorMessage handles strings, errors and objects', () => {
    expect(errorMessage(new Error('a'))).toBe('a');
    expect(errorMessage('b')).toBe('b');
    expect(errorMessage({ c: 1 })).toBe('{"c":1}');
    const circular: any = {}; circular.self = circular;
    expect(typeof errorMessage(circular)).toBe('string');
  });
});
