import { describe, expect, it } from 'bun:test';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { BaseAgentTool, ToolUserError, type ToolOutput } from '../BaseAgentTool.js';
import { isAuthorized } from '../policy.js';
import { ToolRegistry } from '../ToolRegistry.js';
import type { RegisteredTool, ToolSource } from '../types.js';
import { healthReport } from '../../resilience/health.js';
import { ctx } from './helpers.js';

const schema = z.object({ n: z.number().int().min(0).max(100), label: z.string().optional() });
class Probe extends BaseAgentTool<typeof schema> {
  readonly name: string;
  readonly description = 'test tool';
  readonly schema = schema;
  override readonly authPolicy: { requiredScopes?: string[] };
  seen: { n: number; tenant: string }[] = [];
  behavior: (input: z.infer<typeof schema>) => Promise<ToolOutput> | ToolOutput = (i) => ({ data: { doubled: i.n * 2 } });
  constructor(name = 'probe', scopes: string[] = []) {
    super();
    this.name = name;
    this.authPolicy = { requiredScopes: scopes };
  }
  protected async run(input: z.infer<typeof schema>, c: { tenantId: string }): Promise<ToolOutput> {
    this.seen.push({ n: input.n, tenant: c.tenantId });
    return this.behavior(input);
  }
}

describe('isAuthorized', () => {
  it('allows when no scopes are required and the context is valid', () => {
    expect(isAuthorized({}, ctx())).toBe(true);
    expect(isAuthorized({ requiredScopes: [] }, ctx({ scopes: [] }))).toBe(true);
  });
  it('requires ALL listed scopes', () => {
    expect(isAuthorized({ requiredScopes: ['kb:read', 'web'] }, ctx())).toBe(true);
    expect(isAuthorized({ requiredScopes: ['kb:read', 'admin'] }, ctx())).toBe(false);
  });
  it('denies a missing or malformed context (deny by default)', () => {
    expect(isAuthorized({}, undefined)).toBe(false);
    expect(isAuthorized({}, { principalId: 'x' } as any)).toBe(false);
    expect(isAuthorized({}, { ...ctx(), tenantId: '' } as any)).toBe(false);
  });
});

describe('BaseAgentTool.execute', () => {
  it('validates input with the zod schema and reports readable errors', async () => {
    const t = new Probe();
    for (const bad of [{}, { n: 'x' }, { n: -1 }, { n: 1.5 }, { n: 1000 }, null, 'str']) {
      const r = await t.execute(bad, ctx());
      expect(r.ok).toBe(false);
      expect(r.error!.reason).toContain('Invalid arguments');
    }
    expect(t.seen).toHaveLength(0);
  });

  it('runs with parsed input and the trusted context', async () => {
    const t = new Probe();
    const r = await t.execute({ n: 4 }, ctx({ tenantId: 'tenant-9' }));
    expect(r).toMatchObject({ ok: true, data: { doubled: 8 }, content: '{"doubled":8}' });
    expect(t.seen).toEqual([{ n: 4, tenant: 'tenant-9' }]);
  });

  it('strips unknown keys so model-supplied identity fields never reach run()', async () => {
    const t = new Probe();
    let received: any;
    t.behavior = (i) => { received = i; return { data: 1 }; };
    await t.execute({ n: 1, userId: 'bob', tenantId: 'bob' }, ctx());
    expect(received).toEqual({ n: 1 });
  });

  it('enforces scopes even when called directly', async () => {
    const t = new Probe('guarded', ['admin']);
    const r = await t.execute({ n: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error!.reason).toContain('not permitted');
    expect(t.seen).toHaveLength(0);
  });

  it('denies an invalid context', async () => {
    const r = await new Probe().execute({ n: 1 }, { nope: true } as any);
    expect(r.ok).toBe(false);
  });

  it('short-circuits when already cancelled', async () => {
    const c = new AbortController();
    c.abort();
    const t = new Probe();
    const r = await t.execute({ n: 1 }, ctx(), c.signal);
    expect(r.error!.reason).toContain('cancelled');
    expect(t.seen).toHaveLength(0);
  });

  it('turns ToolUserError into a structured, model-readable failure', async () => {
    const t = new Probe();
    t.behavior = () => { throw new ToolUserError('Quota exceeded for today', true); };
    const r = await t.execute({ n: 1 }, ctx());
    expect(r).toMatchObject({ ok: false, error: { reason: 'Quota exceeded for today', retryable: true } });
    expect(r.content).toContain('ERROR: Quota exceeded for today');
    expect(r.content).toContain('retried later');
  });

  it('classifies infrastructure errors into friendly messages (no raw provider text)', async () => {
    const t = new Probe();
    t.behavior = () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432 password=hunter2'), { status: 503 }); };
    const r = await t.execute({ n: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error!.retryable).toBe(true);
    expect(r.error!.reason).not.toMatch(/hunter2|10\.0\.0\.9/);
  });

  it('hides unexpected error details behind a generic failure', async () => {
    const t = new Probe();
    t.behavior = () => { throw new Error('secret internal: /etc/shadow'); };
    const r = await t.execute({ n: 1 }, ctx());
    expect(r.error!.reason).toBe("The 'probe' tool failed unexpectedly.");
    expect(r.content).not.toContain('shadow');
  });

  it('reports aborted work as cancelled', async () => {
    const t = new Probe();
    t.behavior = () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); };
    expect((await t.execute({ n: 1 }, ctx())).error!.reason).toContain('cancelled');
  });

  it('carries citations and custom model text', async () => {
    const t = new Probe();
    t.behavior = () => ({ data: 1, text: 'custom text', citations: [{ title: 't', source: 's', content: 'c' }] });
    const r = await t.execute({ n: 1 }, ctx());
    expect(r.content).toBe('custom text');
    expect(r.citations).toHaveLength(1);
  });

  it('survives unserializable data', async () => {
    const t = new Probe();
    const circ: any = {}; circ.self = circ;
    t.behavior = () => ({ data: circ });
    expect((await t.execute({ n: 1 }, ctx())).ok).toBe(true);
  });
});

describe('BaseAgentTool.build (LangChain tool)', () => {
  it('invokes through LangChain returning content and the artifact (citations)', async () => {
    const t = new Probe();
    t.behavior = () => ({ data: { v: 1 }, text: 'result text', citations: [{ title: 'T', source: 'S', content: 'C' }] });
    const lc = t.build(ctx());
    const msg = (await lc.invoke({ name: 'probe', args: { n: 2 }, id: 'call_1', type: 'tool_call' })) as ToolMessage;
    expect(msg).toBeInstanceOf(ToolMessage);
    expect(msg.content).toBe('result text');
    expect((msg.artifact as any).citations).toHaveLength(1);
    expect((msg.artifact as any).ok).toBe(true);
  });

  it('never throws to the agent: failures come back as ok:false artifacts', async () => {
    const t = new Probe();
    t.behavior = () => { throw new ToolUserError('nope'); };
    const msg = (await t.build(ctx()).invoke({ name: 'probe', args: { n: 2 }, id: 'c2', type: 'tool_call' })) as ToolMessage;
    expect(msg.content).toContain('ERROR: nope');
    expect((msg.artifact as any).ok).toBe(false);
  });

  it('binds the context at build time: the tool runs as that tenant regardless of arguments', async () => {
    const t = new Probe();
    await t.build(ctx({ tenantId: 'carol' })).invoke({ name: 'probe', args: { n: 1, tenantId: 'mallory' }, id: 'c3', type: 'tool_call' });
    expect(t.seen[0]!.tenant).toBe('carol');
  });

  it('exposes name, description and schema to the model', () => {
    const lc = new Probe('named').build(ctx());
    expect(lc.name).toBe('named');
    expect(lc.description).toBe('test tool');
  });
});

describe('ToolRegistry', () => {
  it('registers, lists and unregisters tools; duplicate names are refused', () => {
    const reg = new ToolRegistry().register(new Probe('a')).register(new Probe('b'));
    expect(reg.all().map((t) => t.name)).toEqual(['a', 'b']);
    expect(() => reg.register(new Probe('a'))).toThrow(/already registered/);
    expect(reg.unregister('a')).toBe(true);
    expect(reg.unregister('a')).toBe(false);
    expect(reg.all().map((t) => t.name)).toEqual(['b']);
  });

  it('filters by scope per caller', () => {
    const reg = new ToolRegistry().register(new Probe('open')).register(new Probe('kb', ['kb:read'])).register(new Probe('admin', ['admin']));
    expect(reg.authorizedFor(ctx()).map((t) => t.name)).toEqual(['open', 'kb']);
    expect(reg.authorizedFor(ctx({ scopes: [] })).map((t) => t.name)).toEqual(['open']);
    expect(reg.getAuthorized('admin', ctx())).toBeUndefined();
    expect(reg.getAuthorized('kb', ctx())?.name).toBe('kb');
  });

  it('gives NO tools to a missing/invalid context', () => {
    const reg = new ToolRegistry().register(new Probe('open'));
    expect(reg.authorizedFor(undefined)).toEqual([]);
    expect(reg.authorizedFor({ principalId: 'x' } as any)).toEqual([]);
  });

  it('builds LangChain tools only for authorized entries', () => {
    const reg = new ToolRegistry().register(new Probe('open')).register(new Probe('admin', ['admin']));
    expect(reg.toolsFor(ctx()).map((t) => t.name)).toEqual(['open']);
  });

  it('merges dynamic sources; static tools win name clashes; source changes are picked up live', () => {
    const dynamic: RegisteredTool[] = [new Probe('ext1'), new Probe('open')];
    const source: ToolSource = { componentName: 'src', listTools: () => dynamic, checkHealth: async () => healthReport('up') };
    const reg = new ToolRegistry().register(new Probe('open')).addSource(source);
    expect(reg.all().map((t) => t.name).sort()).toEqual(['ext1', 'open']);
    expect(reg.all().find((t) => t.name === 'open')).toBe(reg.all().find((t) => t.name === 'open')!);
    dynamic.pop();
    dynamic.push(new Probe('ext2'));
    expect(reg.all().map((t) => t.name).sort()).toEqual(['ext1', 'ext2', 'open']);
    expect(() => reg.register(new Probe('ext1'))).toThrow(/already registered/);
  });

  it('aggregates source health; a down source degrades (not kills) the registry', async () => {
    const sources: ToolSource[] = [
      { componentName: 'ok', listTools: () => [], checkHealth: async () => healthReport('up') },
      { componentName: 'bad', listTools: () => [], checkHealth: async () => healthReport('down', 'unreachable') },
    ];
    const reg = new ToolRegistry();
    expect((await reg.checkHealth()).status).toBe('up');
    sources.forEach((s) => reg.addSource(s));
    const h = await reg.checkHealth();
    expect(h.status).toBe('degraded');
    expect(h.detail).toContain('bad');
  });
});
