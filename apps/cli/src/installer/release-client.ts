import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { PlatformInfo } from "../platform/platform.js";
import {
  type ChannelMetadata,
  type ManifestAsset,
  REVOKED_RELEASE_KEY_IDS,
  type SignedManifest,
  type TrustedReleaseKey,
  selectPlatformAsset,
  verifyChannelMetadata,
  verifyManifest,
} from "./channel-verifier.js";

export const DEFAULT_PRODUCTION_CHANNEL_URL = "https://dist.resin.sh/releases/v1/channels.json";
export const PINNED_DENO_VERSION = "2.9.5";

export const MAX_CHANNEL_SIZE_BYTES = 1 * 1024 * 1024; // 1 MiB
export const MAX_MANIFEST_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB
export const MAX_RELEASE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const MAX_HEADER_SIZE_BYTES = 64 * 1024; // 64 KiB
export const MAX_PUBLIC_HELPER_SIZE_BYTES = 1 * 1024 * 1024; // 1 MiB
export const DEFAULT_REQUEST_DEADLINE_MS = 60 * 1000; // 60s
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 1000; // 15s
export const DEFAULT_CONNECT_TIMEOUT_MS = 15 * 1000; // 15s

export const PINNED_DENO_RUNTIMES: Record<
  string,
  {
    readonly filename: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly sourceUrl: string;
  }
> = Object.freeze({
  "linux-x64": Object.freeze({
    filename: "deno-x86_64-unknown-linux-gnu.zip",
    sha256: "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
    sizeBytes: 41638854,
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
  }),
  "linux-arm64": Object.freeze({
    filename: "deno-aarch64-unknown-linux-gnu.zip",
    sha256: "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0",
    sizeBytes: 39902077,
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-unknown-linux-gnu.zip",
  }),
  "darwin-x64": Object.freeze({
    filename: "deno-x86_64-apple-darwin.zip",
    sha256: "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
    sizeBytes: 42346648,
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-apple-darwin.zip",
  }),
  "darwin-arm64": Object.freeze({
    filename: "deno-aarch64-apple-darwin.zip",
    sha256: "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
    sizeBytes: 38511993,
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip",
  }),
});

export interface RuntimeAssetDescriptor {
  readonly version?: string;
  readonly filename: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes?: number;
  readonly archive: "zip";
  readonly executable: string;
}

export interface ResolvedRuntimeAssetDescriptor extends RuntimeAssetDescriptor {
  readonly version: string;
  readonly sizeBytes: number;
}

export interface RuntimeDescriptor {
  readonly version: string;
  readonly required: boolean;
  readonly assets: Record<string, RuntimeAssetDescriptor>;
}

export interface ReleaseManifestWithRuntimes extends SignedManifest {
  readonly runtimes?: {
    readonly deno?: RuntimeDescriptor;
  };
}

export interface ReleaseProvenance {
  readonly version: string;
  readonly channelUrl: string;
  readonly manifestUrl: string;
  readonly channelSha256: string;
  readonly manifestSha256: string;
  readonly releaseAssetUrl: string;
  readonly releaseAssetSha256: string;
  readonly releaseAssetSizeBytes?: number;
  readonly repository?: string;
  readonly commitSha?: string;
  readonly signingKeyIds: string[];
  readonly deno: {
    readonly version: string;
    readonly url: string;
    readonly sha256: string;
    readonly sizeBytes?: number;
  };
}

export interface ResolvedProductionRelease {
  readonly channel: ChannelMetadata;
  readonly manifest: ReleaseManifestWithRuntimes;
  readonly version: string;
  readonly releaseAsset: ManifestAsset;
  readonly releaseAssetUrl: string;
  readonly denoAsset: ResolvedRuntimeAssetDescriptor;
  readonly provenance: ReleaseProvenance;
}

export interface FetchBytesOptions {
  readonly allowInsecureHttpForTests?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  readonly maxSizeBytes?: number;
  readonly exactSizeBytes?: number;
  readonly maxHeaderSizeBytes?: number;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export interface ResolveProductionReleaseOptions {
  readonly platform: PlatformInfo | { os: string; arch: string; isWsl?: boolean };
  readonly channel?: string;
  readonly channelUrl?: string;
  readonly currentInstalledVersion?: string;
  readonly currentActiveVersion?: string;
  readonly minSupportedVersion?: string;
  readonly trustedReleaseKeys?: TrustedReleaseKey[];
  readonly fetchImpl?: typeof fetch;
  readonly dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  readonly env?: Record<string, string | undefined>;
  readonly allowInsecureHttpForTests?: boolean;
  readonly now?: Date | string | number;
}
function normalizeSha256(value: string): string {
  return value
    .replace(/^sha256:/i, "")
    .trim()
    .toLowerCase();
}
function sha256Hex(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: string, label: string): string {
  const normalized = normalizeSha256(value);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must contain an immutable SHA-256 digest.`);
  }
  return normalized;
}

const SENSITIVE_AUTH_PATH_REGEX =
  /\/(?:api\/v\d+\/)?(?:auth|oauth|login|signin|session|token|credentials|private-tools)(?:\/|$|\?)/i;
const SENSITIVE_QUERY_PARAM_REGEX =
  /[?&](?:token|access_token|session_token|auth_token|api_key|auth|bearer|jwt)=/i;

/**
 * Checks whether an IPv4 address is in any prohibited address family:
 * - 0.0.0.0/8 (Unspecified / Current network)
 * - 10.0.0.0/8 (Private RFC 1918)
 * - 100.64.0.0/10 (Shared Address Space / CGNAT RFC 6598, incl. Alibaba metadata 100.100.100.200)
 * - 127.0.0.0/8 (Loopback RFC 1122)
 * - 169.254.0.0/16 (Link-Local RFC 3927, incl. Cloud metadata 169.254.169.254)
 * - 172.16.0.0/12 (Private RFC 1918)
 * - 192.0.0.0/24 (IETF Protocol Assignments RFC 6890)
 * - 192.0.2.0/24 (TEST-NET-1 RFC 5737)
 * - 192.88.99.0/24 (6to4 Relay Anycast RFC 3068/7526)
 * - 192.168.0.0/16 (Private RFC 1918)
 * - 198.18.0.0/15 (Benchmarking RFC 2544)
 * - 198.51.100.0/24 (TEST-NET-2 RFC 5737)
 * - 203.0.113.0/24 (TEST-NET-3 RFC 5737)
 * - 224.0.0.0/4 (Multicast RFC 5771)
 * - 240.0.0.0/4 (Reserved / Future use RFC 1112, incl. 255.255.255.255 Broadcast)
 */
export function isProhibitedIPv4(ip: string, allowLoopback = false): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return true;
    const n = Number(part);
    if (n < 0 || n > 255) return true;
  }
  const [a, b, c] = parts.map((p) => Number(p));

  // Loopback (127.0.0.0/8)
  if (a === 127) {
    return !allowLoopback;
  }

  // Unspecified (0.0.0.0/8)
  if (a === 0) return true;

  // Private 10.0.0.0/8
  if (a === 10) return true;

  // CGNAT 100.64.0.0/10 (100.64.0.0 - 100.127.255.255, incl. Alibaba metadata 100.100.100.200)
  if (a === 100 && (b & 0xc0) === 64) return true;

  // Link-Local 169.254.0.0/16 (incl. Cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // Private 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // IETF Protocol Assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 0) return true;

  // TEST-NET-1 192.0.2.0/24
  if (a === 192 && b === 0 && c === 2) return true;

  // 6to4 Relay Anycast 192.88.99.0/24
  if (a === 192 && b === 88 && c === 99) return true;

  // Private 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  // Benchmarking 198.18.0.0/15 (198.18.0.0 - 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // TEST-NET-2 198.51.100.0/24
  if (a === 198 && b === 51 && c === 100) return true;

  // TEST-NET-3 203.0.113.0/24
  if (a === 203 && b === 0 && c === 113) return true;

  // Multicast 224.0.0.0/4 (224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;

  // Reserved / Future use 240.0.0.0/4 (incl. 255.255.255.255 broadcast)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is in any prohibited address family:
 * - ::/128 (Unspecified)
 * - ::1/128 (Loopback)
 * - ::ffff:0:0/96 (IPv4-mapped IPv6 -> checked against IPv4 prohibited rules)
 * - ::0:0/96 (IPv4-compatible IPv6 -> checked against IPv4 prohibited rules)
 * - fc00::/7 (Unique Local Address RFC 4193, incl. AWS IPv6 metadata fd00:ec2::254)
 * - fe80::/10 (Link-Local RFC 4291)
 * - ff00::/8 (Multicast RFC 4291)
 * - 2001:db8::/32 (Documentation RFC 3849)
 * - 2001:2::/48 (Benchmarking RFC 5180)
 * - 100::/64 (Discard-only RFC 6666)
 * - 64:ff9b:1::/48 (Local-use translation RFC 8215)
 * - 2002::/16 (6to4 -> embedded IPv4 checked against IPv4 prohibited rules)
 */
export function isProhibitedIPv6(ip: string, allowLoopback = false): boolean {
  let cleanIp = ip.trim().toLowerCase();
  if (cleanIp.startsWith("[") && cleanIp.endsWith("]")) {
    cleanIp = cleanIp.slice(1, -1);
  }

  // Handle embedded IPv4 at the end (e.g. ::ffff:192.168.1.1 or ::127.0.0.1)
  let embeddedIpv4: string | undefined;
  const lastColonIndex = cleanIp.lastIndexOf(":");
  if (lastColonIndex !== -1) {
    const potentialIpv4 = cleanIp.slice(lastColonIndex + 1);
    if (potentialIpv4.includes(".")) {
      embeddedIpv4 = potentialIpv4;
      const ipv4Parts = potentialIpv4.split(".");
      if (ipv4Parts.length !== 4) return true;
      for (const p of ipv4Parts) {
        if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return true;
      }
      const [o0, o1, o2, o3] = ipv4Parts.map((p) => Number(p));
      const word1 = (((o0 << 8) | o1) & 0xffff).toString(16);
      const word2 = (((o2 << 8) | o3) & 0xffff).toString(16);
      cleanIp = `${cleanIp.slice(0, lastColonIndex)}:${word1}:${word2}`;
    }
  }

  // Parse 8 16-bit hex words
  const doubleColonIndex = cleanIp.indexOf("::");
  let words: number[] = [];

  if (doubleColonIndex !== -1) {
    if (cleanIp.indexOf("::", doubleColonIndex + 2) !== -1) {
      // Multiple double colons are invalid
      return true;
    }
    const leftPart = cleanIp.slice(0, doubleColonIndex);
    const rightPart = cleanIp.slice(doubleColonIndex + 2);

    const leftWords = leftPart ? leftPart.split(":").map((w) => Number.parseInt(w, 16)) : [];
    const rightWords = rightPart ? rightPart.split(":").map((w) => Number.parseInt(w, 16)) : [];

    if (leftWords.some(Number.isNaN) || rightWords.some(Number.isNaN)) return true;
    if (leftWords.some((w) => w < 0 || w > 0xffff) || rightWords.some((w) => w < 0 || w > 0xffff)) {
      return true;
    }

    const missingCount = 8 - (leftWords.length + rightWords.length);
    if (missingCount < 1) return true;
    words = [...leftWords, ...new Array<number>(missingCount).fill(0), ...rightWords];
  } else {
    const rawWords = cleanIp.split(":");
    if (rawWords.length !== 8) return true;
    words = rawWords.map((w) => Number.parseInt(w, 16));
    if (words.some(Number.isNaN) || words.some((w) => w < 0 || w > 0xffff)) return true;
  }

  if (words.length !== 8) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // Unspecified (::/128)
  if (words.every((w) => w === 0)) return true;

  // Loopback (::1/128)
  if (
    w0 === 0 &&
    w1 === 0 &&
    w2 === 0 &&
    w3 === 0 &&
    w4 === 0 &&
    w5 === 0 &&
    w6 === 0 &&
    w7 === 1
  ) {
    return !allowLoopback;
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    const derivedIpv4 = [w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff].join(".");
    return isProhibitedIPv4(derivedIpv4, allowLoopback);
  }

  // IPv4-compatible IPv6 (::0:0/96, deprecated)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const derivedIpv4 = [w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff].join(".");
    return isProhibitedIPv4(derivedIpv4, allowLoopback);
  }

  // If embedded IPv4 was extracted and not already mapped/compatible, validate it
  if (embeddedIpv4 && isProhibitedIPv4(embeddedIpv4, allowLoopback)) {
    return true;
  }

  // Unique Local Address fc00::/7 (fc00:: - fdff:ffff:..., incl. AWS metadata fd00:ec2::254)
  if ((w0 & 0xfe00) === 0xfc00) return true;

  // Link-Local fe80::/10 (fe80:: - febf:ffff:...)
  if ((w0 & 0xffc0) === 0xfe80) return true;

  // Multicast ff00::/8
  if ((w0 & 0xff00) === 0xff00) return true;

  // Documentation 2001:db8::/32
  if (w0 === 0x2001 && w1 === 0x0db8) return true;

  // Benchmarking 2001:2::/48
  if (w0 === 0x2001 && w1 === 0x0002) return true;

  // Discard prefix 100::/64
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true;

  // Local-use translation 64:ff9b:1::/48
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0x0001) return true;

  // 6to4 prefix 2002::/16 -> check embedded IPv4
  if (w0 === 0x2002) {
    const derivedIpv4 = [w1 >> 8, w1 & 0xff, w2 >> 8, w2 & 0xff].join(".");
    if (isProhibitedIPv4(derivedIpv4, allowLoopback)) return true;
  }

  return false;
}

export function isProhibitedIP(ip: string, allowLoopback = false): boolean {
  const cleanIp = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (net.isIPv4(cleanIp)) {
    return isProhibitedIPv4(cleanIp, allowLoopback);
  }
  if (net.isIPv6(cleanIp)) {
    return isProhibitedIPv6(cleanIp, allowLoopback);
  }
  // If not recognized as valid standard IP, treat as prohibited
  return true;
}

export function isProhibitedHostname(hostname: string, allowLoopback = false): boolean {
  const normalized = hostname.toLowerCase().trim();

  // Localhost
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return !allowLoopback;
  }

  // Cloud metadata and internal service discovery names
  if (
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".metadata.google.internal") ||
    normalized === "metadata" ||
    normalized === "instance-data" ||
    normalized === "169.254.169.254" ||
    normalized === "100.100.100.200"
  ) {
    return true;
  }

  return false;
}

export function validateIpAddress(ip: string, allowLoopback = false): void {
  if (isProhibitedIP(ip, allowLoopback)) {
    throw new Error(`Prohibited release download IP destination: ${ip}`);
  }
}

export async function validateAndResolveDestination(
  url: URL,
  options: {
    allowInsecureHttpForTests?: boolean;
    dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  } = {},
): Promise<{ address: string; family: number }> {
  const allowLoopback = options.allowInsecureHttpForTests === true;

  const rawHost = url.hostname;
  const ipHost = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  // If hostname is literal IP
  if (net.isIP(ipHost)) {
    const family = net.isIP(ipHost);
    if (isProhibitedIP(ipHost, allowLoopback)) {
      throw new Error(`Release download destination '${rawHost}' is a prohibited address family.`);
    }
    return { address: ipHost, family };
  }

  if (isProhibitedHostname(rawHost, allowLoopback)) {
    throw new Error(`Prohibited release download destination hostname: '${rawHost}'`);
  }
  // Perform DNS resolution
  const lookupFn = options.dnsLookup ?? (async (h) => dns.lookup(h, { all: true }));
  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookupFn(url.hostname);
  } catch (error) {
    throw new Error(
      `Failed to resolve release host '${url.hostname}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!results || results.length === 0) {
    throw new Error(`Release host '${url.hostname}' resolved to zero DNS records.`);
  }

  // Validate EVERY address in the DNS answer. Reject mixed public/private answers.
  for (const record of results) {
    if (!record.address || (record.family !== 4 && record.family !== 6)) {
      throw new Error(`Release host '${url.hostname}' returned invalid DNS answer.`);
    }
    if (isProhibitedIP(record.address, allowLoopback)) {
      throw new Error(
        `Release download destination '${url.hostname}' resolved to prohibited address '${record.address}'. Mixed or private DNS answers are strictly rejected.`,
      );
    }
  }

  return { address: results[0].address, family: results[0].family };
}

function assertTransport(urlString: string, allowInsecureHttpForTests: boolean): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid release artifact URL: ${urlString}`);
  }
  if (url.username || url.password) {
    throw new Error(`Release URL contains embedded credentials: ${urlString}`);
  }

  if (
    SENSITIVE_AUTH_PATH_REGEX.test(url.pathname) ||
    SENSITIVE_QUERY_PARAM_REGEX.test(url.search)
  ) {
    throw new Error(
      `Public release download rejected sensitive or session-bound endpoint: ${urlString}`,
    );
  }

  if (url.protocol === "https:") return url;

  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";

  if (allowInsecureHttpForTests && url.protocol === "http:" && isLoopback) {
    return url;
  }

  throw new Error(`Release metadata and assets must use HTTPS: ${urlString}`);
}

/**
 * Node core HTTPS/HTTP transport that pins the socket connection directly to the
 * pre-validated IP address while maintaining TLS SNI and server certificate validation
 * against the target hostname, eliminating DNS rebinding TOCTOU vulnerabilities.
 */
interface NodePinnedFetchOptions {
  maxSizeBytes?: number;
  exactSizeBytes?: number;
  maxHeaderSizeBytes?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

async function nodePinnedFetch(
  currentUrl: URL,
  pinnedAddress: string,
  family: number,
  options: NodePinnedFetchOptions = {},
): Promise<{
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  buffer: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const isHttps = currentUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = currentUrl.port ? Number(currentUrl.port) : isHttps ? 443 : 80;

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_DEADLINE_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const maxHeaderSize = options.maxHeaderSizeBytes ?? MAX_HEADER_SIZE_BYTES;

    let settled = false;
    let absoluteTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let connectTimer: NodeJS.Timeout | null = null;

    const cleanupTimers = () => {
      if (absoluteTimer) {
        clearTimeout(absoluteTimer);
        absoluteTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      try {
        req.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    const resetIdleTimer = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(
          new Error(
            `Download socket idle timeout exceeded after ${idleTimeoutMs}ms with no activity for ${currentUrl.toString()}`,
          ),
        );
      }, idleTimeoutMs);
    };

    absoluteTimer = setTimeout(() => {
      fail(
        new Error(
          `Download exceeded absolute request deadline of ${timeoutMs}ms for ${currentUrl.toString()}`,
        ),
      );
    }, timeoutMs);

    connectTimer = setTimeout(() => {
      fail(
        new Error(
          `Download connection timeout exceeded after ${connectTimeoutMs}ms for ${currentUrl.toString()}`,
        ),
      );
    }, connectTimeoutMs);

    const req = transport.request(
      {
        protocol: currentUrl.protocol,
        hostname: currentUrl.hostname,
        port,
        path: currentUrl.pathname + currentUrl.search,
        method: "GET",
        maxHeaderSize,
        lookup: (_hostname, lookupOptions, callback) => {
          const isAll =
            typeof lookupOptions === "object" &&
            lookupOptions !== null &&
            Boolean((lookupOptions as { all?: boolean }).all);
          if (isAll) {
            (
              callback as (
                err: Error | null,
                addresses: Array<{ address: string; family: number }>,
              ) => void
            )(null, [{ address: pinnedAddress, family }]);
          } else {
            (callback as (err: Error | null, address: string, family: number) => void)(
              null,
              pinnedAddress,
              family,
            );
          }
        },
        servername: isHttps ? currentUrl.hostname : undefined,
        headers: {
          Accept: "application/json, application/octet-stream;q=0.9, */*;q=0.8",
          "User-Agent": "resin-installer",
        },
      },
      (res) => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        resetIdleTimer();

        const clRaw = res.headers["content-length"];
        let expectedCl: number | undefined;
        if (clRaw !== undefined) {
          const parsed = Number.parseInt(Array.isArray(clRaw) ? clRaw[0] : clRaw, 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            expectedCl = parsed;
            if (options.maxSizeBytes !== undefined && parsed > options.maxSizeBytes) {
              return fail(
                new Error(
                  `Response Content-Length ${parsed} exceeds maximum allowed size of ${options.maxSizeBytes} bytes.`,
                ),
              );
            }
            if (options.exactSizeBytes !== undefined && parsed !== options.exactSizeBytes) {
              return fail(
                new Error(
                  `Response Content-Length ${parsed} does not match expected exact size of ${options.exactSizeBytes} bytes.`,
                ),
              );
            }
          }
        }

        const chunks: Buffer[] = [];
        let totalReceived = 0;

        res.on("data", (chunk: Buffer) => {
          resetIdleTimer();
          totalReceived += chunk.length;
          if (options.maxSizeBytes !== undefined && totalReceived > options.maxSizeBytes) {
            return fail(
              new Error(
                `Response body exceeded maximum allowed size of ${options.maxSizeBytes} bytes (chunk overflow).`,
              ),
            );
          }
          if (options.exactSizeBytes !== undefined && totalReceived > options.exactSizeBytes) {
            return fail(
              new Error(
                `Response body exceeded expected exact size of ${options.exactSizeBytes} bytes.`,
              ),
            );
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (settled) return;
          settled = true;
          cleanupTimers();

          if (options.exactSizeBytes !== undefined && totalReceived !== options.exactSizeBytes) {
            return reject(
              new Error(
                `Response body size mismatch: expected ${options.exactSizeBytes} bytes, received ${totalReceived} bytes.`,
              ),
            );
          }
          if (expectedCl !== undefined && totalReceived !== expectedCl) {
            return reject(
              new Error(
                `Response body size ${totalReceived} does not match Content-Length header ${expectedCl}.`,
              ),
            );
          }

          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const val of v) headers.append(k, val);
            } else {
              headers.set(k, v);
            }
          }

          resolve({
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? "OK",
            ok: (res.statusCode ?? 200) >= 200 && (res.statusCode ?? 200) < 300,
            headers,
            buffer: body,
            arrayBuffer: async () =>
              body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          });
        });

        res.on("error", (err) => {
          fail(err);
        });

        res.on("aborted", () => {
          fail(new Error("Response was aborted by server or network transport."));
        });
      },
    );

    req.on("socket", (socket) => {
      socket.on("connect", () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        resetIdleTimer();
      });
      if (isHttps) {
        socket.on("secureConnect", () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          resetIdleTimer();
        });
      }
    });

    req.on("error", (err) => {
      fail(err);
    });

    req.on("abort", () => {
      fail(new Error("Request was aborted."));
    });

    req.end();
  });
}

export async function fetchBytes(
  urlString: string,
  fetchImplOrOptions?: typeof fetch | FetchBytesOptions,
  allowInsecureHttpForTestsArg?: boolean,
  extraOptions?: FetchBytesOptions,
): Promise<Buffer> {
  let fetchImpl: typeof fetch | undefined;
  let allowInsecure = false;
  let dnsLookup:
    | ((hostname: string) => Promise<Array<{ address: string; family: number }>>)
    | undefined;
  let maxSizeBytes: number | undefined;
  let exactSizeBytes: number | undefined;
  let maxHeaderSizeBytes: number | undefined;
  let timeoutMs: number | undefined;
  let idleTimeoutMs: number | undefined;
  let connectTimeoutMs: number | undefined;

  if (typeof fetchImplOrOptions === "function") {
    fetchImpl = fetchImplOrOptions;
    allowInsecure = allowInsecureHttpForTestsArg ?? false;
    dnsLookup = extraOptions?.dnsLookup;
    maxSizeBytes = extraOptions?.maxSizeBytes;
    exactSizeBytes = extraOptions?.exactSizeBytes;
    maxHeaderSizeBytes = extraOptions?.maxHeaderSizeBytes;
    timeoutMs = extraOptions?.timeoutMs;
    idleTimeoutMs = extraOptions?.idleTimeoutMs;
    connectTimeoutMs = extraOptions?.connectTimeoutMs;
  } else if (fetchImplOrOptions && typeof fetchImplOrOptions === "object") {
    fetchImpl = fetchImplOrOptions.fetchImpl;
    allowInsecure = fetchImplOrOptions.allowInsecureHttpForTests ?? false;
    dnsLookup = fetchImplOrOptions.dnsLookup;
    maxSizeBytes = fetchImplOrOptions.maxSizeBytes;
    exactSizeBytes = fetchImplOrOptions.exactSizeBytes;
    maxHeaderSizeBytes = fetchImplOrOptions.maxHeaderSizeBytes;
    timeoutMs = fetchImplOrOptions.timeoutMs;
    idleTimeoutMs = fetchImplOrOptions.idleTimeoutMs;
    connectTimeoutMs = fetchImplOrOptions.connectTimeoutMs;
  }

  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  const effectiveIdleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const effectiveConnectTimeoutMs = connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const effectiveMaxHeaderSizeBytes = maxHeaderSizeBytes ?? MAX_HEADER_SIZE_BYTES;
  const startTimestamp = Date.now();
  const deadline = startTimestamp + effectiveTimeoutMs;

  let currentUrl = assertTransport(urlString, allowInsecure);
  let redirectsRemaining = 5;

  while (true) {
    const now = Date.now();
    const remainingDeadline = deadline - now;
    if (remainingDeadline <= 0) {
      throw new Error(
        `Download exceeded absolute request deadline of ${effectiveTimeoutMs}ms for ${currentUrl.toString()}`,
      );
    }

    const resolved = await validateAndResolveDestination(currentUrl, {
      allowInsecureHttpForTests: allowInsecure,
      dnsLookup,
    });

    let response: {
      status: number;
      statusText: string;
      ok: boolean;
      headers: Headers;
      arrayBuffer(): Promise<ArrayBuffer>;
      buffer?: Buffer;
    };

    if (fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(
          new Error(`Download exceeded absolute request deadline of ${effectiveTimeoutMs}ms`),
        );
      }, remainingDeadline);

      try {
        const resp = await fetchImpl(currentUrl.toString(), {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            Accept: "application/json, application/octet-stream;q=0.9, */*;q=0.8",
            "User-Agent": "resin-installer",
          },
          signal: controller.signal,
        });

        let headerBytesEstimate = 0;
        resp.headers.forEach((v, k) => {
          headerBytesEstimate += k.length + v.length + 4;
        });
        if (headerBytesEstimate > effectiveMaxHeaderSizeBytes) {
          throw new Error(
            `Response headers (${headerBytesEstimate} bytes) exceeded maximum allowed size of ${effectiveMaxHeaderSizeBytes} bytes.`,
          );
        }

        const clHeader = resp.headers.get("content-length");
        let expectedCl: number | undefined;
        if (clHeader !== null) {
          const parsed = Number.parseInt(clHeader, 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            expectedCl = parsed;
            if (maxSizeBytes !== undefined && parsed > maxSizeBytes) {
              throw new Error(
                `Response Content-Length ${parsed} exceeds maximum allowed size of ${maxSizeBytes} bytes.`,
              );
            }
            if (exactSizeBytes !== undefined && parsed !== exactSizeBytes) {
              throw new Error(
                `Response Content-Length ${parsed} does not match expected exact size of ${exactSizeBytes} bytes.`,
              );
            }
          }
        }

        let bodyBuf: Buffer;
        if (
          resp.body &&
          typeof (resp.body as unknown as { getReader?: unknown }).getReader === "function"
        ) {
          const reader = (resp.body as unknown as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                total += value.length;
                if (maxSizeBytes !== undefined && total > maxSizeBytes) {
                  reader.cancel();
                  throw new Error(
                    `Response body exceeded maximum allowed size of ${maxSizeBytes} bytes (chunk overflow).`,
                  );
                }
                chunks.push(value);
              }
            }
          } finally {
            reader.releaseLock();
          }
          bodyBuf = Buffer.concat(chunks);
        } else {
          const ab = await resp.arrayBuffer();
          if (maxSizeBytes !== undefined && ab.byteLength > maxSizeBytes) {
            throw new Error(
              `Response body exceeded maximum allowed size of ${maxSizeBytes} bytes (chunk overflow).`,
            );
          }
          if (exactSizeBytes !== undefined && ab.byteLength !== exactSizeBytes) {
            throw new Error(
              `Response body exceeded expected exact size of ${exactSizeBytes} bytes.`,
            );
          }
          bodyBuf = Buffer.from(ab);
        }

        if (exactSizeBytes !== undefined && bodyBuf.length !== exactSizeBytes) {
          throw new Error(
            `Response body size mismatch: expected ${exactSizeBytes} bytes, received ${bodyBuf.length} bytes.`,
          );
        }
        if (expectedCl !== undefined && bodyBuf.length !== expectedCl) {
          throw new Error(
            `Response body size ${bodyBuf.length} does not match Content-Length header ${expectedCl}.`,
          );
        }
        response = {
          status: resp.status,
          statusText: resp.statusText,
          ok: resp.ok,
          headers: resp.headers,
          buffer: bodyBuf,
          arrayBuffer: async () => {
            const ab = new ArrayBuffer(bodyBuf.length);
            new Uint8Array(ab).set(bodyBuf);
            return ab;
          },
        };
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await nodePinnedFetch(currentUrl, resolved.address, resolved.family, {
        maxSizeBytes,
        exactSizeBytes,
        maxHeaderSizeBytes: effectiveMaxHeaderSizeBytes,
        timeoutMs: remainingDeadline,
        idleTimeoutMs: effectiveIdleTimeoutMs,
        connectTimeoutMs: effectiveConnectTimeoutMs,
      });
    }

    if (
      response.status === 401 ||
      response.status === 407 ||
      response.headers.has("www-authenticate") ||
      response.headers.has("proxy-authenticate")
    ) {
      throw new Error(
        `Public release download rejected authentication challenge (${response.status}) from ${currentUrl.toString()}. Anonymous public downloads cannot authenticate or send credentials to session-bound endpoints.`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `Release download redirect for ${currentUrl.toString()} omitted a Location header.`,
        );
      }

      if (redirectsRemaining <= 0) {
        throw new Error(
          `Public release download exceeded the maximum redirect count of 5. Last target: ${location}`,
        );
      }
      redirectsRemaining -= 1;

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(
          `Public release download encountered malformed redirect URL '${location}' from ${currentUrl.toString()}`,
        );
      }
      nextUrl = assertTransport(nextUrl.toString(), allowInsecure);
      if (
        nextUrl.username ||
        nextUrl.password ||
        SENSITIVE_QUERY_PARAM_REGEX.test(nextUrl.search)
      ) {
        throw new Error(
          `Public release download rejected redirect to private or session-bound endpoint: ${nextUrl.toString()}`,
        );
      }

      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch release artifact from ${currentUrl.toString()}: ${response.status} ${response.statusText}`,
      );
    }

    if (response.buffer) {
      return response.buffer;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const BUNDLED_TRUSTED_KEY_ALLOWED_FIELDS: Record<string, true> = {
  keyId: true,
  algorithm: true,
  trustDomain: true,
  publicKeyPem: true,
  publicKeyHex: true,
  publicKeyFingerprintSha256: true,
};

const OVERRIDE_TRUSTED_KEY_ALLOWED_FIELDS: Record<string, true> = {
  keyId: true,
  publicKeyHex: true,
};

export function parseBundledReleaseTrust(parsed: unknown): TrustedReleaseKey[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Bundled release trust root must be a JSON object.");
  }
  const root = parsed as Record<string, unknown>;

  if (root.schemaVersion !== "2.0.0") {
    throw new Error(
      `Unsupported bundled release trust schemaVersion '${String(root.schemaVersion)}' (expected '2.0.0').`,
    );
  }

  if (root.trustDomain !== "production") {
    throw new Error(
      `Unsupported bundled release trust trustDomain '${String(root.trustDomain)}' (expected 'production').`,
    );
  }

  if (!Array.isArray(root.trustedKeys) || root.trustedKeys.length === 0) {
    throw new Error("Bundled release trust requires a non-empty 'trustedKeys' array.");
  }

  const seenKeyIds = new Set<string>();
  const seenKeyHexes = new Set<string>();
  const validatedKeys: TrustedReleaseKey[] = [];

  for (let i = 0; i < root.trustedKeys.length; i++) {
    const entry = root.trustedKeys[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Bundled trustedKeys[${i}] must be a JSON object.`);
    }

    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!BUNDLED_TRUSTED_KEY_ALLOWED_FIELDS[key]) {
        throw new Error(`Bundled trustedKeys[${i}] contains forbidden property '${key}'.`);
      }
    }

    const keyId = record.keyId;
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new Error(`Bundled trustedKeys[${i}] is missing a valid 'keyId'.`);
    }
    if (seenKeyIds.has(keyId)) {
      throw new Error(`Duplicate trusted keyId '${keyId}' in bundled release trust.`);
    }
    seenKeyIds.add(keyId);

    if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
      throw new Error(`Trusted release key '${keyId}' is revoked.`);
    }
    if (record.algorithm !== "Ed25519") {
      throw new Error(
        `Trusted release key '${keyId}' has unsupported algorithm '${String(record.algorithm)}' (expected 'Ed25519').`,
      );
    }
    if (record.trustDomain !== "production") {
      throw new Error(
        `Release key '${keyId}' belongs to '${String(record.trustDomain)}' trust domain, not 'production'.`,
      );
    }

    if (typeof record.publicKeyPem !== "string" || !record.publicKeyPem.trim()) {
      throw new Error(`Trusted release key '${keyId}' is missing 'publicKeyPem'.`);
    }

    let keyObject: crypto.KeyObject;
    try {
      keyObject = crypto.createPublicKey(record.publicKeyPem.trim());
    } catch (error) {
      throw new Error(
        `Trusted release key '${keyId}' has invalid publicKeyPem: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (keyObject.asymmetricKeyType !== "ed25519") {
      throw new Error(
        `Trusted release key '${keyId}' has unexpected asymmetricKeyType '${keyObject.asymmetricKeyType}'.`,
      );
    }

    const der = keyObject.export({ type: "spki", format: "der" });
    const rawPublicKey = der.subarray(-32);
    const derivedHex = rawPublicKey.toString("hex").toLowerCase();
    const derivedFingerprint = crypto.createHash("sha256").update(der).digest("hex").toLowerCase();

    if (typeof record.publicKeyHex !== "string") {
      throw new Error(`Trusted release key '${keyId}' is missing 'publicKeyHex'.`);
    }
    const normalizedDeclaredHex = record.publicKeyHex.trim().toLowerCase();
    if (normalizedDeclaredHex !== derivedHex) {
      throw new Error(
        `Trusted release key '${keyId}' publicKeyHex does not match publicKeyPem (expected ${derivedHex}, got ${normalizedDeclaredHex}).`,
      );
    }

    if (typeof record.publicKeyFingerprintSha256 !== "string") {
      throw new Error(`Trusted release key '${keyId}' is missing 'publicKeyFingerprintSha256'.`);
    }
    const normalizedDeclaredFingerprint = record.publicKeyFingerprintSha256.trim().toLowerCase();
    if (normalizedDeclaredFingerprint !== derivedFingerprint) {
      throw new Error(
        `Trusted release key '${keyId}' publicKeyFingerprintSha256 mismatch (expected ${derivedFingerprint}, got ${normalizedDeclaredFingerprint}).`,
      );
    }

    if (seenKeyHexes.has(derivedHex)) {
      throw new Error(`Duplicate public root key hex in bundled release trust: ${derivedHex}`);
    }
    seenKeyHexes.add(derivedHex);

    validatedKeys.push({
      keyId,
      publicKeyHex: derivedHex,
    });
  }

  return validatedKeys;
}

export function parseTrustedKeysJsonOverride(overrideJson: string): TrustedReleaseKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(overrideJson);
  } catch (error) {
    throw new Error(
      `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("RESIN_TRUSTED_RELEASE_PUBLIC_KEYS must be a non-empty array of key records.");
  }

  const seenKeyIds = new Set<string>();
  const seenKeyHexes = new Set<string>();
  const validatedKeys: TrustedReleaseKey[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] must be a JSON object with keyId and publicKeyHex.`,
      );
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!OVERRIDE_TRUSTED_KEY_ALLOWED_FIELDS[key]) {
        throw new Error(
          `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] contains forbidden property '${key}'.`,
        );
      }
    }

    const keyId = record.keyId;
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new Error(`RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] is missing a valid 'keyId'.`);
    }
    if (seenKeyIds.has(keyId)) {
      throw new Error(`Duplicate trusted keyId '${keyId}' in release trust override.`);
    }
    seenKeyIds.add(keyId);

    if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
      throw new Error(`Trusted release key '${keyId}' is revoked.`);
    }

    const publicKeyHex = record.publicKeyHex;
    if (typeof publicKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex.trim())) {
      throw new Error(
        `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] requires a 64-character hex publicKeyHex.`,
      );
    }

    const normalizedHex = publicKeyHex.trim().toLowerCase();
    if (seenKeyHexes.has(normalizedHex)) {
      throw new Error(`Duplicate public root key hex in release trust override: ${normalizedHex}`);
    }
    seenKeyHexes.add(normalizedHex);

    validatedKeys.push({
      keyId,
      publicKeyHex: normalizedHex,
    });
  }

  return validatedKeys;
}

export async function loadBundledTrustedReleaseKeys(
  customTrustData?: unknown,
): Promise<TrustedReleaseKey[]> {
  if (customTrustData !== undefined) {
    if (typeof customTrustData === "string") {
      return parseTrustedKeysJsonOverride(customTrustData);
    }
    if (
      typeof customTrustData === "object" &&
      customTrustData !== null &&
      "RESIN_TRUSTED_RELEASE_PUBLIC_KEYS" in customTrustData
    ) {
      const rawOverride = (customTrustData as Record<string, unknown>)
        .RESIN_TRUSTED_RELEASE_PUBLIC_KEYS;
      if (typeof rawOverride === "string") {
        return parseTrustedKeysJsonOverride(rawOverride);
      }
    }
    return parseBundledReleaseTrust(customTrustData);
  }

  const bundledTrustPath = new URL("../release-trust.json", import.meta.url);
  let rawBytes: Buffer;
  try {
    rawBytes = await fs.readFile(bundledTrustPath);
  } catch (error) {
    throw new Error(
      `Failed to load bundled release trust file at ${bundledTrustPath.pathname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseJson<unknown>(rawBytes, "Bundled release trust");
  return parseBundledReleaseTrust(parsed);
}

function platformKey(platform: { os: string; arch: string; isWsl?: boolean }): string {
  const arch =
    platform.arch === "x86_64" ? "x64" : platform.arch === "aarch64" ? "arm64" : platform.arch;
  if (platform.isWsl || platform.os === "wsl") return `wsl-${arch}`;
  return `${platform.os}-${arch}`;
}

/**
 * Resolves a signed release reference URL against a base URL.
 * When the reference is root-relative (starts with '/releases/v1/') and the base URL
 * contains a non-empty staging prefix before '/releases/v1/', that prefix is preserved.
 * Absolute external URLs (e.g. GitHub releases) and standard production URLs remain unchanged.
 */
export function resolveReleaseRefUrl(rawRef: string, baseUrlString: string): string {
  try {
    const parsedRef = new URL(rawRef);
    return parsedRef.toString();
  } catch {
    // rawRef is relative or root-relative
  }

  let base: URL;
  try {
    base = new URL(baseUrlString);
  } catch {
    return rawRef;
  }

  const v1Marker = "/releases/v1/";
  const markerIndex = base.pathname.indexOf(v1Marker);
  if (markerIndex > 0 && rawRef.startsWith(v1Marker)) {
    const prefix = base.pathname.slice(0, markerIndex);
    const combinedPath = `${prefix}${rawRef}`;
    return new URL(combinedPath, base.origin).toString();
  }

  return new URL(rawRef, base).toString();
}

function resolveDenoAsset(
  descriptor: RuntimeDescriptor | undefined,
  platform: { os: string; arch: string; isWsl?: boolean },
  manifestUrl?: string,
  allowInsecureHttpForTests = false,
): ResolvedRuntimeAssetDescriptor {
  if (!descriptor || !descriptor.required) {
    throw new Error("Signed release manifest is missing the required Deno runtime descriptor.");
  }
  if (descriptor.version !== PINNED_DENO_VERSION) {
    throw new Error(
      `Signed release manifest requires Deno '${descriptor.version}' but this client is pinned to '${PINNED_DENO_VERSION}'.`,
    );
  }
  const key = platformKey(platform);
  const linuxFallback = key.startsWith("wsl-") ? `linux-${key.slice(4)}` : undefined;
  const asset =
    descriptor.assets[key] ?? (linuxFallback ? descriptor.assets[linuxFallback] : undefined);
  if (!asset) throw new Error(`No pinned Deno runtime asset exists for '${key}'.`);
  const pinnedRuntime =
    PINNED_DENO_RUNTIMES[key] ?? (linuxFallback ? PINNED_DENO_RUNTIMES[linuxFallback] : undefined);
  if (pinnedRuntime && !allowInsecureHttpForTests) {
    if (typeof asset.sizeBytes === "number" && asset.sizeBytes !== pinnedRuntime.sizeBytes) {
      throw new Error(
        `Deno runtime asset size mismatch for '${key}': expected ${pinnedRuntime.sizeBytes} bytes, got ${asset.sizeBytes} bytes.`,
      );
    }
    const assetSha = normalizeSha256(asset.sha256);
    if (assetSha !== pinnedRuntime.sha256) {
      throw new Error(
        `Deno runtime asset sha256 mismatch for '${key}': expected ${pinnedRuntime.sha256}, got ${assetSha}.`,
      );
    }
  }

  const exactSize = asset.sizeBytes ?? pinnedRuntime?.sizeBytes;
  if (typeof exactSize !== "number" || !Number.isSafeInteger(exactSize) || exactSize <= 0) {
    throw new Error(`Deno runtime asset '${key}' is missing a valid positive sizeBytes.`);
  }

  let assetUrl = asset.url;
  if (manifestUrl) {
    try {
      assetUrl = resolveReleaseRefUrl(asset.url, manifestUrl);
    } catch {
      // retain raw asset.url
    }
  }
  assertTransport(assetUrl, allowInsecureHttpForTests);
  assertSha256(asset.sha256, `Deno ${descriptor.version} asset`);
  return {
    ...asset,
    url: assetUrl,
    version: descriptor.version,
    sizeBytes: exactSize,
  };
}

export async function resolveProductionRelease(
  options: ResolveProductionReleaseOptions,
): Promise<ResolvedProductionRelease> {
  const fetchImpl = options.fetchImpl;
  const allowInsecure = options.allowInsecureHttpForTests === true;
  const channelUrl = options.channelUrl ?? DEFAULT_PRODUCTION_CHANNEL_URL;
  const trustedReleaseKeys = options.trustedReleaseKeys?.length
    ? [...options.trustedReleaseKeys]
    : await loadBundledTrustedReleaseKeys();
  if (trustedReleaseKeys.length === 0) {
    throw new Error(
      "Production release resolution requires at least one independently pinned public key.",
    );
  }

  const fetchOptions: FetchBytesOptions = {
    allowInsecureHttpForTests: allowInsecure,
    fetchImpl,
    dnsLookup: options.dnsLookup,
  };

  const channelBytes = await fetchBytes(channelUrl, {
    ...fetchOptions,
    maxSizeBytes: MAX_CHANNEL_SIZE_BYTES,
  });
  const channelSha256 = sha256Hex(channelBytes);
  const channel = parseJson<ChannelMetadata>(channelBytes, "Release channel metadata");
  const channelResult = verifyChannelMetadata(channel, {
    channel: options.channel ?? "stable",
    currentInstalledVersion: options.currentInstalledVersion || options.currentActiveVersion,
    minSupportedVersion: options.minSupportedVersion,
    trustedReleaseKeys,
    now: options.now,
  });
  if (!channelResult.valid) {
    throw new Error(`Signed release channel rejected: ${channelResult.errors.join("; ")}`);
  }
  if (!channelResult.targetVersion || !channelResult.manifestUrl || !channelResult.manifestDigest) {
    throw new Error(
      "Signed release channel is incomplete: version, manifest URL, and digest are required.",
    );
  }

  const targetVersion = channelResult.targetVersion;
  const rawManifestUrl = channelResult.manifestUrl;
  let resolvedManifestUrl: string;
  try {
    resolvedManifestUrl = resolveReleaseRefUrl(rawManifestUrl, channelUrl);
  } catch {
    throw new Error(
      `Release channel specified invalid manifest URL '${rawManifestUrl}' relative to '${channelUrl}'.`,
    );
  }
  assertTransport(resolvedManifestUrl, allowInsecure);
  const expectedManifestDigest = assertSha256(channelResult.manifestDigest, "Release manifest");
  const manifestBytes = await fetchBytes(resolvedManifestUrl, {
    ...fetchOptions,
    maxSizeBytes: MAX_MANIFEST_SIZE_BYTES,
  });
  const actualManifestDigest = sha256Hex(manifestBytes);
  if (actualManifestDigest !== expectedManifestDigest) {
    throw new Error(
      `Release manifest digest mismatch: expected sha256:${expectedManifestDigest}, got sha256:${actualManifestDigest}`,
    );
  }

  const manifest = parseJson<ReleaseManifestWithRuntimes>(manifestBytes, "Release manifest");
  const manifestResult = verifyManifest(manifest, {
    expectedDigest: expectedManifestDigest,
    rawManifestBytes: manifestBytes,
    currentInstalledVersion: options.currentInstalledVersion || options.currentActiveVersion,
    minSupportedVersion: options.minSupportedVersion,
    trustedReleaseKeys,
    revokedKeyIds: channel.revokedKeyIds ?? channelResult.revokedKeyIds,
    now: options.now,
  });
  if (!manifestResult.valid) {
    throw new Error(`Signed release manifest rejected: ${manifestResult.errors.join("; ")}`);
  }
  if (manifest.version !== targetVersion) {
    throw new Error(
      `Release manifest version '${manifest.version}' does not match channel target version '${targetVersion}'.`,
    );
  }

  const releaseAsset = selectPlatformAsset(manifest, options.platform);
  if (
    typeof releaseAsset.sizeBytes !== "number" ||
    !Number.isSafeInteger(releaseAsset.sizeBytes) ||
    releaseAsset.sizeBytes <= 0
  ) {
    throw new Error(
      `Release manifest specified invalid sizeBytes for asset '${releaseAsset.filename}'.`,
    );
  }
  if (releaseAsset.sizeBytes > MAX_RELEASE_SIZE_BYTES) {
    throw new Error(
      `Release asset '${releaseAsset.filename}' size (${releaseAsset.sizeBytes} bytes) exceeds hard cap of ${MAX_RELEASE_SIZE_BYTES} bytes.`,
    );
  }

  let releaseAssetUrl: string;
  try {
    releaseAssetUrl = resolveReleaseRefUrl(
      releaseAsset.url || releaseAsset.path,
      resolvedManifestUrl,
    );
  } catch {
    throw new Error(
      `Release manifest specified invalid asset URL '${releaseAsset.url || releaseAsset.path}' relative to '${resolvedManifestUrl}'.`,
    );
  }
  assertTransport(releaseAssetUrl, allowInsecure);
  assertSha256(releaseAsset.sha256, "Release asset");

  const denoAsset = resolveDenoAsset(
    manifest.runtimes?.deno,
    options.platform,
    resolvedManifestUrl,
    allowInsecure,
  );

  const signingKeyIds = (manifest.signatures ?? [])
    .map((s) => s.keyId)
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  const identity =
    typeof manifest.releaseIdentity === "object" && manifest.releaseIdentity !== null
      ? (manifest.releaseIdentity as Record<string, unknown>)
      : undefined;

  return {
    channel,
    manifest,
    version: targetVersion,
    releaseAsset,
    releaseAssetUrl,
    denoAsset,
    provenance: {
      version: targetVersion,
      channelUrl,
      manifestUrl: resolvedManifestUrl,
      channelSha256,
      manifestSha256: actualManifestDigest,
      releaseAssetUrl,
      releaseAssetSha256: normalizeSha256(releaseAsset.sha256),
      releaseAssetSizeBytes: releaseAsset.sizeBytes,
      repository: typeof identity?.repository === "string" ? identity.repository : undefined,
      commitSha: typeof identity?.commitSha === "string" ? identity.commitSha : undefined,
      signingKeyIds,
      deno: {
        version: denoAsset.version,
        url: denoAsset.url,
        sha256: normalizeSha256(denoAsset.sha256),
        sizeBytes: denoAsset.sizeBytes,
      },
    },
  };
}
