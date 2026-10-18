import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string, public readonly reason: 'invalid_url' | 'scheme' | 'port' | 'credentials' | 'private_address' | 'dns_failure') {
    super(message);
    this.name = 'SsrfError';
  }
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => Number.isNaN(n) || n > 255) ? null : nums;
}

/** Expands any textual IPv6 (incl. "::" and embedded dotted IPv4) to eight 16-bit groups. */
export function parseIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]!);
    if (!v4) return null;
    addr = addr.slice(0, -dotted[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

export function isPublicIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return false;
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

export function isPublicIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIPv4(embeddedV4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::, ::1 and deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIPv4(embeddedV4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isPublicIPv4(embeddedV4(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false; // Teredo, documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard prefix
  return (g[0]! & 0xe000) === 0x2000; // only global unicast 2000::/3
}

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIPv4(ip);
  if (family === 6) return isPublicIPv6(ip);
  return false;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** What the scraper needs from a guard; SsrfGuard is the production implementation. */
export interface UrlGuard {
  check(rawUrl: string): Promise<ResolvedTarget>;
}

export interface SsrfGuardOptions {
  allowedPorts?: number[];
  /** Test seam; defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

/**
 * Validates outbound URLs for server-side fetching: http(s) only, no embedded credentials, standard ports,
 * and EVERY resolved address must be public. The caller then connects to the returned (validated) address
 * so DNS cannot be rebound between check and use.
 */
export class SsrfGuard implements UrlGuard {
  private readonly allowedPorts: Set<number>;
  private readonly resolve: NonNullable<SsrfGuardOptions['resolve']>;

  constructor(options: SsrfGuardOptions = {}) {
    this.allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
    this.resolve = options.resolve ?? ((h) => dns.lookup(h, { all: true, verbatim: true }));
  }

  async check(rawUrl: string): Promise<ResolvedTarget> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SsrfError('Not a valid URL.', 'invalid_url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError(`Only http and https URLs are allowed (got '${url.protocol.replace(':', '')}').`, 'scheme');
    }
    if (url.username || url.password) throw new SsrfError('URLs with embedded credentials are not allowed.', 'credentials');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!this.allowedPorts.has(port)) throw new SsrfError(`Port ${port} is not allowed.`, 'port');

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!host) throw new SsrfError('URL has no host.', 'invalid_url');
    if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new SsrfError('Internal hostnames are not allowed.', 'private_address');
    }

    const literal = isIP(host);
    if (literal) {
      if (!isPublicIp(host)) throw new SsrfError('Private or reserved IP addresses are not allowed.', 'private_address');
      return { url, address: host, family: literal as 4 | 6 };
    }

    let addresses: { address: string; family: number }[];
    try {
      addresses = await this.resolve(host);
    } catch {
      throw new SsrfError(`Could not resolve host '${host}'.`, 'dns_failure');
    }
    if (addresses.length === 0) throw new SsrfError(`Could not resolve host '${host}'.`, 'dns_failure');
    if (addresses.some((a) => !isPublicIp(a.address))) {
      throw new SsrfError('Host resolves to a private or reserved address.', 'private_address');
    }
    const first = addresses[0]!;
    return { url, address: first.address, family: (first.family === 6 ? 6 : 4) as 4 | 6 };
  }
}
