import { describe, expect, it } from 'bun:test';
import { SsrfError, SsrfGuard, isPublicIPv4, isPublicIPv6, isPublicIp, parseIPv6 } from '../ssrf.js';

describe('isPublicIPv4', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.88.99.1', '192.168.0.1', '192.168.255.255',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.167.1.1', '198.17.0.1', '11.0.0.1'];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isPublicIPv4(ip)).toBe(false));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isPublicIPv4(ip)).toBe(true));
  it('rejects malformed addresses', () => {
    for (const bad of ['', '1.2.3', '256.1.1.1', '1.2.3.4.5', 'a.b.c.d', '1.2.3.-4']) expect(isPublicIPv4(bad)).toBe(false);
  });
});

describe('isPublicIPv6', () => {
  const blocked = [
    '::', '::1', 'fe80::1', 'fe80::abcd%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1',
    '2002:7f00:1::', '2002:a9fe:a9fe::', '100::1', '0:0:0:0:0:0:0:1',
  ];
  const allowed = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::'];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isPublicIPv6(ip)).toBe(false));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isPublicIPv6(ip)).toBe(true));
  it('rejects non-global-unicast and malformed input', () => {
    for (const bad of ['', 'zzzz::1', '1:2:3', '1::2::3', '12345::1', '3000::1x']) expect(isPublicIPv6(bad)).toBe(false);
  });
  it('parseIPv6 expands compressed and dotted forms', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('isPublicIp', () => {
  it('dispatches by family and rejects hostnames', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('example.com')).toBe(false);
  });
});

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('SsrfGuard.check', () => {
  const guard = new SsrfGuard({ resolve: publicResolver });
  const reason = async (url: string, g = guard) => ((await g.check(url).catch((e) => e)) as SsrfError).reason;

  it('allows public http/https URLs and returns a pinned address', async () => {
    const t = await guard.check('https://example.com/path?q=1');
    expect(t).toMatchObject({ address: '93.184.216.34', family: 4 });
    expect(t.url.hostname).toBe('example.com');
    expect((await guard.check('http://example.com:80/')).address).toBe('93.184.216.34');
  });

  it('blocks non-http schemes', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'ws://example.com/']) {
      expect(await reason(u)).toBe('scheme');
    }
  });

  it('blocks malformed URLs', async () => {
    for (const u of ['', 'not a url', '//example.com', 'http://']) expect(await reason(u)).toBe('invalid_url');
  });

  it('blocks embedded credentials and non-standard ports', async () => {
    expect(await reason('http://user:pass@example.com/')).toBe('credentials');
    expect(await reason('http://example.com:22/')).toBe('port');
    expect(await reason('https://example.com:6379/')).toBe('port');
    const open = new SsrfGuard({ resolve: publicResolver, allowedPorts: [80, 443, 8080] });
    expect((await open.check('http://example.com:8080/')).address).toBe('93.184.216.34');
  });

  it('blocks private/loopback/metadata IP literals in every notation', async () => {
    const urls = [
      'http://127.0.0.1/', 'http://localhost/', 'http://LOCALHOST./', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://192.168.1.1/',
      'http://[::1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f000001/', // hex
      'http://0177.0.0.1/', // octal
      'http://127.1/', // short form
      'http://0/', 'http://0.0.0.0/',
    ];
    for (const u of urls) expect(await reason(u)).toBe('private_address');
  });

  it('blocks internal hostnames without even resolving', async () => {
    let resolved = false;
    const g = new SsrfGuard({ resolve: async () => { resolved = true; return [{ address: '8.8.8.8', family: 4 }]; } });
    for (const u of ['http://localhost/', 'http://app.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://x.localdomain/', 'http://router.home.arpa/']) {
      expect(await reason(u, g)).toBe('private_address');
    }
    expect(resolved).toBe(false);
  });

  it('blocks hostnames that RESOLVE to private addresses (DNS pointing inward)', async () => {
    const g = new SsrfGuard({ resolve: async () => [{ address: '10.1.2.3', family: 4 }] });
    expect(await reason('http://innocent.example.com/', g)).toBe('private_address');
  });

  it('blocks when ANY resolved address is private (round-robin / rebinding trick)', async () => {
    const g = new SsrfGuard({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
    expect(await reason('http://mixed.example.com/', g)).toBe('private_address');
    const v6 = new SsrfGuard({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }] });
    expect(await reason('http://mixed6.example.com/', v6)).toBe('private_address');
  });

  it('reports DNS failures', async () => {
    const fail = new SsrfGuard({ resolve: async () => { throw new Error('ENOTFOUND'); } });
    expect(await reason('http://nope.example.com/', fail)).toBe('dns_failure');
    const empty = new SsrfGuard({ resolve: async () => [] });
    expect(await reason('http://nope.example.com/', empty)).toBe('dns_failure');
  });
});
