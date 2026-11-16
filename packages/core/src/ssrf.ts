import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF protection. Tenants choose the URLs Relay calls, so without this check
 * anyone could point an endpoint at internal services (databases, cloud
 * metadata at 169.254.169.254, localhost admin ports) and use Relay to reach them.
 */

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8      "this" network
  [0x0a000000, 8], // 10.0.0.0/8     private
  [0x64400000, 10], // 100.64.0.0/10 carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8    loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local, cloud metadata
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xe0000000, 3], // 224.0.0.0/3    multicast + reserved
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n & (~0 << (32 - bits))) >>> 0 === base);
  }
  if (version === 6) {
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      v6 === "::" ||
      v6 === "::1" ||
      v6.startsWith("fc") || // fc00::/7 unique local
      v6.startsWith("fd") ||
      /^fe[89ab]/.test(v6) // fe80::/10 link-local
    );
  }
  return true; // not an IP at all: refuse
}

export class UnsafeUrlError extends Error {}

/** Throws UnsafeUrlError unless the URL is http(s) and every address it resolves to is public. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("only http(s) is allowed");
  if (url.username || url.password) throw new UnsafeUrlError("credentials in URL are not allowed");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new UnsafeUrlError("host does not resolve");
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError("private, loopback and link-local addresses are not allowed");
}
