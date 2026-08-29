import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  type ChannelMetadata,
  type ManifestAsset,
  type SignedManifest,
  type TrustedReleaseKey,
  canonicalJson,
} from "../../src/installer/channel-verifier.js";
import {
  DEFAULT_PRODUCTION_CHANNEL_URL,
  PINNED_DENO_VERSION,
  fetchBytes,
  isProhibitedHostname,
  isProhibitedIP,
  isProhibitedIPv4,
  isProhibitedIPv6,
  loadBundledTrustedReleaseKeys,
  parseBundledReleaseTrust,
  resolveProductionRelease,
  resolveReleaseRefUrl,
  validateAndResolveDestination,
  validateIpAddress,
} from "../../src/installer/release-client.js";

// Test-only key material generated at runtime for isolated test qualification.
const generatedTestKeyPair = crypto.generateKeyPairSync("ed25519");
const testSpkiDer = generatedTestKeyPair.publicKey.export({ type: "spki", format: "der" });
const testPublicKeyHex = testSpkiDer.subarray(-32).toString("hex");

const TEST_KEYPAIR = {
  keyId: "resin-release-root-2026a",
  publicKeyHex: testPublicKeyHex,
  privateKey: generatedTestKeyPair.privateKey,
};

function signPayload(payload: unknown): string {
  const canonical = canonicalJson(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), TEST_KEYPAIR.privateKey);
  return sig.toString("hex");
}

interface RequestRecord {
  url: string;
  init?: RequestInit;
}

describe("Anonymous Public Release Distribution", () => {
  it("points to the official Resin public endpoint as default channel URL", () => {
    expect(DEFAULT_PRODUCTION_CHANNEL_URL).toBe("https://dist.resin.sh/releases/v1/channels.json");
  });

  describe("Anonymous request enforcement", () => {
    it("fetches release artifacts with credentials omitted and no authentication headers", async () => {
      const requests: RequestRecord[] = [];
      const testContent = Buffer.from("test release payload", "utf8");

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        return new Response(testContent, {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/octet-stream" },
        });
      };

      const result = await fetchBytes("http://127.0.0.1:8080/test-file.bin", mockFetch, true);
      expect(result).toEqual(testContent);
      expect(requests.length).toBe(1);

      const requestInit = requests[0].init;
      expect(requestInit?.credentials).toBe("omit");
      expect(requestInit?.headers).not.toHaveProperty("Authorization");
      expect(requestInit?.headers).not.toHaveProperty("authorization");
      expect(requestInit?.headers).not.toHaveProperty("Proxy-Authorization");
      expect(requestInit?.headers).not.toHaveProperty("proxy-authorization");
    });

    it("rejects URLs with embedded credentials (username/password)", async () => {
      const dummyFetch: typeof fetch = async () => new Response("OK", { status: 200 });

      await expect(
        fetchBytes(
          "https://user:password@dist.resin.sh/releases/v1/channels.json",
          dummyFetch,
          false,
        ),
      ).rejects.toThrow(/embedded credentials/i);

      await expect(
        fetchBytes("http://user:password@127.0.0.1:8080/channels.json", dummyFetch, true),
      ).rejects.toThrow(/embedded credentials/i);
    });

    it("rejects HTTP 401 and 407 authentication challenges", async () => {
      const mockFetch401: typeof fetch = async () => {
        return new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        });
      };

      await expect(
        fetchBytes("http://127.0.0.1:8080/channels.json", mockFetch401, true),
      ).rejects.toThrow(/authentication challenge \(401\)/);

      const mockFetch407: typeof fetch = async () => {
        return new Response("Proxy Authentication Required", {
          status: 407,
          statusText: "Proxy Authentication Required",
        });
      };

      await expect(
        fetchBytes("http://127.0.0.1:8080/channels.json", mockFetch407, true),
      ).rejects.toThrow(/authentication challenge \(407\)/);
    });

    it("rejects responses presenting WWW-Authenticate or Proxy-Authenticate headers", async () => {
      const mockFetchWwwAuth: typeof fetch = async () => {
        return new Response("Payload", {
          status: 200,
          headers: {
            "WWW-Authenticate": 'Bearer realm="resin-auth"',
          },
        });
      };

      await expect(
        fetchBytes("http://127.0.0.1:8080/channels.json", mockFetchWwwAuth, true),
      ).rejects.toThrow(/authentication challenge/);

      const mockFetchProxyAuth: typeof fetch = async () => {
        return new Response("Payload", {
          status: 200,
          headers: {
            "Proxy-Authenticate": 'Basic realm="corporate-proxy"',
          },
        });
      };

      await expect(
        fetchBytes("http://127.0.0.1:8080/channels.json", mockFetchProxyAuth, true),
      ).rejects.toThrow(/authentication challenge/);
    });

    it("rejects requests to sensitive authentication and token URL paths/query params", async () => {
      const dummyFetch: typeof fetch = async () => new Response("OK", { status: 200 });

      // Path checks
      await expect(
        fetchBytes("https://dist.resin.sh/api/v1/auth/token", dummyFetch, false),
      ).rejects.toThrow(/sensitive or session-bound/);

      await expect(
        fetchBytes("https://dist.resin.sh/oauth/authorize", dummyFetch, false),
      ).rejects.toThrow(/sensitive or session-bound/);

      await expect(fetchBytes("https://dist.resin.sh/login", dummyFetch, false)).rejects.toThrow(
        /sensitive or session-bound/,
      );

      // Query param checks
      await expect(
        fetchBytes(
          "https://dist.resin.sh/releases/channels.json?token=secret123",
          dummyFetch,
          false,
        ),
      ).rejects.toThrow(/sensitive or session-bound/);

      await expect(
        fetchBytes(
          "https://dist.resin.sh/releases/channels.json?api_key=secret123",
          dummyFetch,
          false,
        ),
      ).rejects.toThrow(/sensitive or session-bound/);

      await expect(
        fetchBytes(
          "https://dist.resin.sh/releases/channels.json?bearer=secret123",
          dummyFetch,
          false,
        ),
      ).rejects.toThrow(/sensitive or session-bound/);
    });
  });

  describe("Prohibited address family enforcement (literal and DNS-resolved)", () => {
    describe("IPv4 address classification", () => {
      it("prohibits IPv4 loopback (127.0.0.0/8) in production mode", () => {
        expect(isProhibitedIPv4("127.0.0.1", false)).toBe(true);
        expect(isProhibitedIPv4("127.255.255.254", false)).toBe(true);
        expect(isProhibitedIPv4("127.0.0.0", false)).toBe(true);
        // Permitted in test mode
        expect(isProhibitedIPv4("127.0.0.1", true)).toBe(false);
      });

      it("prohibits IPv4 private 10.0.0.0/8 in all modes", () => {
        expect(isProhibitedIPv4("10.0.0.1", false)).toBe(true);
        expect(isProhibitedIPv4("10.0.0.1", true)).toBe(true);
        expect(isProhibitedIPv4("10.255.255.254", false)).toBe(true);
      });

      it("prohibits IPv4 private 172.16.0.0/12 in all modes", () => {
        expect(isProhibitedIPv4("172.16.0.1", false)).toBe(true);
        expect(isProhibitedIPv4("172.20.1.1", true)).toBe(true);
        expect(isProhibitedIPv4("172.31.255.254", false)).toBe(true);
        // 172.32.0.1 is outside the /12
        expect(isProhibitedIPv4("172.32.0.1", false)).toBe(false);
      });

      it("prohibits IPv4 private 192.168.0.0/16 in all modes", () => {
        expect(isProhibitedIPv4("192.168.1.1", false)).toBe(true);
        expect(isProhibitedIPv4("192.168.100.50", true)).toBe(true);
        expect(isProhibitedIPv4("192.168.255.254", false)).toBe(true);
      });

      it("prohibits IPv4 Carrier-Grade NAT 100.64.0.0/10 (incl. Alibaba metadata)", () => {
        expect(isProhibitedIPv4("100.64.0.1", false)).toBe(true);
        expect(isProhibitedIPv4("100.100.100.200", false)).toBe(true); // Alibaba IMDS
        expect(isProhibitedIPv4("100.127.255.254", true)).toBe(true);
        // 100.128.0.1 is outside the /10
        expect(isProhibitedIPv4("100.128.0.1", false)).toBe(false);
      });

      it("prohibits IPv4 link-local 169.254.0.0/16 (incl. Cloud Metadata 169.254.169.254)", () => {
        expect(isProhibitedIPv4("169.254.169.254", false)).toBe(true); // AWS / GCP / Azure IMDS
        expect(isProhibitedIPv4("169.254.1.1", true)).toBe(true);
      });

      it("prohibits IPv4 multicast 224.0.0.0/4", () => {
        expect(isProhibitedIPv4("224.0.0.1", false)).toBe(true);
        expect(isProhibitedIPv4("239.255.255.255", false)).toBe(true);
      });

      it("prohibits IPv4 unspecified 0.0.0.0/8 and broadcast/reserved 240.0.0.0/4", () => {
        expect(isProhibitedIPv4("0.0.0.0", false)).toBe(true);
        expect(isProhibitedIPv4("240.0.0.1", false)).toBe(true);
        expect(isProhibitedIPv4("255.255.255.255", false)).toBe(true);
      });

      it("prohibits IPv4 documentation and benchmarking ranges", () => {
        expect(isProhibitedIPv4("192.0.2.1", false)).toBe(true); // TEST-NET-1
        expect(isProhibitedIPv4("198.51.100.1", false)).toBe(true); // TEST-NET-2
        expect(isProhibitedIPv4("203.0.113.1", false)).toBe(true); // TEST-NET-3
        expect(isProhibitedIPv4("198.18.0.1", false)).toBe(true); // Benchmarking
        expect(isProhibitedIPv4("198.19.255.254", false)).toBe(true);
      });

      it("allows valid public routable IPv4 addresses", () => {
        expect(isProhibitedIPv4("93.184.216.34", false)).toBe(false); // example.com
        expect(isProhibitedIPv4("1.1.1.1", false)).toBe(false); // Cloudflare DNS
        expect(isProhibitedIPv4("8.8.8.8", false)).toBe(false); // Google DNS
        expect(isProhibitedIPv4("151.101.1.140", false)).toBe(false); // Fastly CDN
      });
    });

    describe("IPv6 address classification", () => {
      it("prohibits IPv6 loopback (::1/128) in production mode", () => {
        expect(isProhibitedIPv6("::1", false)).toBe(true);
        expect(isProhibitedIPv6("0:0:0:0:0:0:0:1", false)).toBe(true);
        // Permitted in test mode
        expect(isProhibitedIPv6("::1", true)).toBe(false);
      });

      it("prohibits IPv6 unspecified (::/128)", () => {
        expect(isProhibitedIPv6("::", false)).toBe(true);
        expect(isProhibitedIPv6("0:0:0:0:0:0:0:0", false)).toBe(true);
      });

      it("prohibits IPv6 Unique Local Address fc00::/7 (incl. AWS IPv6 metadata fd00:ec2::254)", () => {
        expect(isProhibitedIPv6("fc00::1", false)).toBe(true);
        expect(isProhibitedIPv6("fd00::1", false)).toBe(true);
        expect(isProhibitedIPv6("fd00:ec2::254", false)).toBe(true); // AWS IMDSv2 IPv6
        expect(isProhibitedIPv6("fd12:3456:789a:1::1", true)).toBe(true);
      });

      it("prohibits IPv6 link-local fe80::/10", () => {
        expect(isProhibitedIPv6("fe80::1", false)).toBe(true);
        expect(isProhibitedIPv6("febf::1", false)).toBe(true);
      });

      it("prohibits IPv6 multicast ff00::/8", () => {
        expect(isProhibitedIPv6("ff02::1", false)).toBe(true);
        expect(isProhibitedIPv6("ff05::2", false)).toBe(true);
      });

      it("prohibits IPv6 documentation, benchmarking, discard prefix, and translation", () => {
        expect(isProhibitedIPv6("2001:db8::1", false)).toBe(true); // Documentation
        expect(isProhibitedIPv6("2001:2::1", false)).toBe(true); // Benchmarking
        expect(isProhibitedIPv6("100::1", false)).toBe(true); // Discard prefix
        expect(isProhibitedIPv6("64:ff9b:1::1", false)).toBe(true); // Local translation
      });

      it("prohibits IPv4-mapped IPv6 pointing to private or metadata addresses", () => {
        expect(isProhibitedIPv6("::ffff:127.0.0.1", false)).toBe(true); // Loopback in prod
        expect(isProhibitedIPv6("::ffff:127.0.0.1", true)).toBe(false); // Loopback in test
        expect(isProhibitedIPv6("::ffff:10.0.0.1", false)).toBe(true);
        expect(isProhibitedIPv6("::ffff:192.168.1.1", false)).toBe(true);
        expect(isProhibitedIPv6("::ffff:169.254.169.254", false)).toBe(true); // Metadata
        expect(isProhibitedIPv6("::ffff:172.16.0.1", false)).toBe(true);
        expect(isProhibitedIPv6("::ffff:100.64.0.1", false)).toBe(true);
        // Valid public IPv4-mapped IPv6
        expect(isProhibitedIPv6("::ffff:93.184.216.34", false)).toBe(false);
      });

      it("prohibits IPv4-compatible IPv6 pointing to private addresses", () => {
        expect(isProhibitedIPv6("::10.0.0.1", false)).toBe(true);
        expect(isProhibitedIPv6("::192.168.1.1", false)).toBe(true);
        expect(isProhibitedIPv6("::169.254.169.254", false)).toBe(true);
      });

      it("allows valid public routable IPv6 addresses", () => {
        expect(isProhibitedIPv6("2606:2800:220:1:248:1893:25c8:1946", false)).toBe(false); // example.com
        expect(isProhibitedIPv6("2606:4700:4700::1111", false)).toBe(false); // Cloudflare DNS
        expect(isProhibitedIPv6("2001:4860:4860::8888", false)).toBe(false); // Google DNS
      });
    });

    describe("Hostname classification", () => {
      it("prohibits localhost in production mode", () => {
        expect(isProhibitedHostname("localhost", false)).toBe(true);
        expect(isProhibitedHostname("service.localhost", false)).toBe(true);
        expect(isProhibitedHostname("localhost", true)).toBe(false);
      });

      it("prohibits cloud metadata and internal discovery hostnames", () => {
        expect(isProhibitedHostname("metadata.google.internal", false)).toBe(true);
        expect(isProhibitedHostname("compute.metadata.google.internal", false)).toBe(true);
        expect(isProhibitedHostname("metadata", false)).toBe(true);
        expect(isProhibitedHostname("instance-data", false)).toBe(true);
        expect(isProhibitedHostname("169.254.169.254", false)).toBe(true);
        expect(isProhibitedHostname("100.100.100.200", false)).toBe(true);
      });

      it("allows standard public hostnames", () => {
        expect(isProhibitedHostname("dist.resin.sh", false)).toBe(false);
        expect(isProhibitedHostname("cdn.resin.sh", false)).toBe(false);
        expect(isProhibitedHostname("github.com", false)).toBe(false);
      });
    });

    describe("Destination validation with DNS resolution", () => {
      it("validates literal public IP addresses directly", async () => {
        const result = await validateAndResolveDestination(
          new URL("https://93.184.216.34/file.json"),
        );
        expect(result.address).toBe("93.184.216.34");
        expect(result.family).toBe(4);
      });

      it("rejects literal private and metadata destinations", async () => {
        await expect(
          validateAndResolveDestination(new URL("https://10.0.0.1/file.json")),
        ).rejects.toThrow(/prohibited address/i);

        await expect(
          validateAndResolveDestination(new URL("https://169.254.169.254/latest/meta-data/")),
        ).rejects.toThrow(/prohibited address/i);

        await expect(
          validateAndResolveDestination(new URL("https://[fd00:ec2::254]/latest/meta-data/")),
        ).rejects.toThrow(/prohibited address/i);

        await expect(
          validateAndResolveDestination(
            new URL("https://metadata.google.internal/computeMetadata/v1/"),
          ),
        ).rejects.toThrow(/prohibited release download destination hostname/i);
      });

      it("resolves and approves valid public DNS answers", async () => {
        const mockLookup = async (hostname: string) => {
          if (hostname === "dist.resin.sh") {
            return [{ address: "93.184.216.34", family: 4 }];
          }
          throw new Error("NXDOMAIN");
        };

        const result = await validateAndResolveDestination(
          new URL("https://dist.resin.sh/channels.json"),
          {
            dnsLookup: mockLookup,
          },
        );
        expect(result.address).toBe("93.184.216.34");
        expect(result.family).toBe(4);
      });

      it("rejects DNS answers containing mixed public and private IPv4 addresses", async () => {
        const mockLookupMixed = async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ];

        await expect(
          validateAndResolveDestination(new URL("https://dual-homed.resin.sh/channels.json"), {
            dnsLookup: mockLookupMixed,
          }),
        ).rejects.toThrow(
          /resolved to prohibited address '10.0.0.1'. Mixed or private DNS answers are strictly rejected/,
        );
      });

      it("rejects DNS answers containing mixed public and cloud metadata addresses", async () => {
        const mockLookupMixed = async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ];

        await expect(
          validateAndResolveDestination(new URL("https://mixed-meta.resin.sh/channels.json"), {
            dnsLookup: mockLookupMixed,
          }),
        ).rejects.toThrow(/resolved to prohibited address '169.254.169.254'/);
      });

      it("rejects DNS answers containing mixed public and IPv6 loopback addresses", async () => {
        const mockLookupMixed = async () => [
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
          { address: "::1", family: 6 },
        ];

        await expect(
          validateAndResolveDestination(new URL("https://mixed-v6.resin.sh/channels.json"), {
            dnsLookup: mockLookupMixed,
          }),
        ).rejects.toThrow(/resolved to prohibited address '::1'/);
      });

      it("rejects DNS answers containing mixed public and CGNAT/Alibaba metadata addresses", async () => {
        const mockLookupMixed = async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "100.100.100.200", family: 4 },
        ];

        await expect(
          validateAndResolveDestination(new URL("https://mixed-cgnat.resin.sh/channels.json"), {
            dnsLookup: mockLookupMixed,
          }),
        ).rejects.toThrow(/resolved to prohibited address '100.100.100.200'/);
      });

      it("rejects hosts resolving to zero DNS records", async () => {
        const mockLookupEmpty = async () => [];

        await expect(
          validateAndResolveDestination(new URL("https://empty.resin.sh/channels.json"), {
            dnsLookup: mockLookupEmpty,
          }),
        ).rejects.toThrow(/resolved to zero DNS records/);
      });
    });
  });

  describe("DNS rebinding protection and address pinning", () => {
    it("pins validated IP address during connection so subsequent DNS changes do not rebind to private destinations", async () => {
      let lookupCallCount = 0;
      // Resolver returns public on first call, but private on subsequent call
      const rebindingLookup = async () => {
        lookupCallCount++;
        if (lookupCallCount === 1) {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        return [{ address: "127.0.0.1", family: 4 }];
      };

      const mockFetch: typeof fetch = async (url) => {
        return new Response(`Fetched ${url}`, { status: 200 });
      };

      const result = await fetchBytes("https://rebind.resin.sh/channels.json", {
        fetchImpl: mockFetch,
        dnsLookup: rebindingLookup,
      });

      expect(result.toString("utf8")).toBe("Fetched https://rebind.resin.sh/channels.json");
      expect(lookupCallCount).toBe(1);
    });

    it("rejects destination when DNS lookup fails or resolves to forbidden IP", async () => {
      const forbiddenLookup = async () => [{ address: "192.168.1.1", family: 4 }];

      await expect(
        fetchBytes("https://internal.resin.sh/channels.json", {
          fetchImpl: async () => new Response("OK"),
          dnsLookup: forbiddenLookup,
        }),
      ).rejects.toThrow(/resolved to prohibited address '192.168.1.1'/);
    });
  });

  describe("Redirect re-resolution and unsafe redirect enforcement", () => {
    it("rejects redirect to literal prohibited IPv4 destination (e.g. 169.254.169.254 metadata)", async () => {
      const mockFetch: typeof fetch = async (url) => {
        if (String(url) === "https://dist.resin.sh/download") {
          return new Response(null, {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        return new Response("OK", { status: 200 });
      };

      await expect(
        fetchBytes("https://dist.resin.sh/download", {
          fetchImpl: mockFetch,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
      ).rejects.toThrow(/Release metadata and assets must use HTTPS|prohibited address/i);
    });

    it("rejects redirect to literal prohibited IPv6 destination (e.g. fd00:ec2::254 ULA metadata)", async () => {
      const mockFetch: typeof fetch = async (url) => {
        if (String(url) === "https://dist.resin.sh/download") {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://[fd00:ec2::254]/latest/meta-data/" },
          });
        }
        return new Response("OK", { status: 200 });
      };

      await expect(
        fetchBytes("https://dist.resin.sh/download", {
          fetchImpl: mockFetch,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
      ).rejects.toThrow(/prohibited address/i);
    });

    it("re-resolves destination host on redirect and rejects private IP targets", async () => {
      const mockLookup = async (hostname: string) => {
        if (hostname === "dist.resin.sh") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        if (hostname === "internal-redirect.resin.sh") {
          return [{ address: "10.0.0.1", family: 4 }];
        }
        throw new Error("NXDOMAIN");
      };

      const mockFetch: typeof fetch = async (url) => {
        if (String(url) === "https://dist.resin.sh/download") {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://internal-redirect.resin.sh/secret.json" },
          });
        }
        return new Response("OK", { status: 200 });
      };

      await expect(
        fetchBytes("https://dist.resin.sh/download", {
          fetchImpl: mockFetch,
          dnsLookup: mockLookup,
        }),
      ).rejects.toThrow(/resolved to prohibited address '10.0.0.1'/);
    });

    it("rejects redirect to embedded credentials", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://admin:secret@dist.resin.sh/channels.json" },
        });
      };

      await expect(
        fetchBytes("https://dist.resin.sh/start", {
          fetchImpl: mockFetch,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
      ).rejects.toThrow(/contains embedded credentials/);
    });

    it("rejects redirect to sensitive authentication endpoints or tokens", async () => {
      const mockFetchAuthPath: typeof fetch = async () => {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://dist.resin.sh/api/auth/token" },
        });
      };

      await expect(
        fetchBytes("https://dist.resin.sh/start", {
          fetchImpl: mockFetchAuthPath,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
      ).rejects.toThrow(/sensitive or session-bound/);

      const mockFetchTokenQuery: typeof fetch = async () => {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://dist.resin.sh/channels.json?token=my-secret" },
        });
      };

      await expect(
        fetchBytes("https://dist.resin.sh/start", {
          fetchImpl: mockFetchTokenQuery,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
      ).rejects.toThrow(/sensitive or session-bound/);
    });

    it("rejects redirect missing Location header", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(null, { status: 302 });
      };

      await expect(fetchBytes("http://127.0.0.1:8080/start", mockFetch, true)).rejects.toThrow(
        /omitted a Location header/,
      );
    });

    it("rejects redirect loops exceeding 5 hops", async () => {
      let count = 0;
      const mockFetch: typeof fetch = async () => {
        count++;
        return new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:8080/redirect-${count}` },
        });
      };

      await expect(fetchBytes("http://127.0.0.1:8080/start", mockFetch, true)).rejects.toThrow(
        /exceeded the maximum redirect count/,
      );
    });

    it("allows safe public-to-public redirects with all hops re-validated", async () => {
      const mockLookup = async (hostname: string) => {
        if (hostname === "dist.resin.sh") return [{ address: "93.184.216.34", family: 4 }];
        if (hostname === "cdn.resin.sh") return [{ address: "151.101.1.140", family: 4 }];
        throw new Error("NXDOMAIN");
      };

      const mockFetch: typeof fetch = async (url) => {
        if (String(url) === "https://dist.resin.sh/download") {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.resin.sh/releases/v1/channels.json" },
          });
        }
        if (String(url) === "https://cdn.resin.sh/releases/v1/channels.json") {
          return new Response('{"valid": true}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await fetchBytes("https://dist.resin.sh/download", {
        fetchImpl: mockFetch,
        dnsLookup: mockLookup,
      });

      expect(result.toString("utf8")).toBe('{"valid": true}');
    });
  });

  describe("RC anonymous tracer-bullet smoke fixture", () => {
    it("qualifies exact immutable RC channel → manifest → asset chain without external network", async () => {
      const rcVersion = "1.1.0-rc.1";
      const releaseDate = "2026-08-25T12:00:00.000Z";
      const baseUrl = "http://127.0.0.1:9199";

      // 1. Prepare exact RC release asset
      const releaseTarball = Buffer.from("dummy-rc-tarball-payload", "utf8");
      const releaseTarballSha = crypto.createHash("sha256").update(releaseTarball).digest("hex");

      // 2. Prepare RC manifest with Deno runtime descriptor
      const manifestUnsigned = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        version: rcVersion,
        releaseDate,
        releaseIdentity: {
          name: "Resin Language Toolchain",
          distributor: "Resin Contributors",
          repository: "https://github.com/resin-lang/resin",
          commitSha: "a".repeat(40),
        },
        assets: {
          "linux-x64": {
            filename: `resin-${rcVersion}-linux-x64.tar.gz`,
            path: `dist/release/v${rcVersion}/resin-${rcVersion}-linux-x64.tar.gz`,
            url: `${baseUrl}/assets/resin-${rcVersion}-linux-x64.tar.gz`,
            platform: "linux",
            arch: "x64",
            isWsl: false,
            sizeBytes: releaseTarball.length,
            sha256: releaseTarballSha,
          },
        },
        runtimes: {
          deno: {
            version: PINNED_DENO_VERSION,
            required: true,
            assets: {
              "linux-x64": {
                filename: `deno-x86_64-unknown-linux-gnu.zip`,
                url: `${baseUrl}/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
                sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                archive: "zip" as const,
                executable: "deno",
              },
            },
          },
        },
      };

      const manifestSignature = signPayload({
        schemaVersion: manifestUnsigned.schemaVersion,
        metadataVersion: manifestUnsigned.metadataVersion,
        expiresAt: manifestUnsigned.expiresAt,
        version: manifestUnsigned.version,
        releaseDate: manifestUnsigned.releaseDate,
        releaseIdentity: manifestUnsigned.releaseIdentity,
        assets: manifestUnsigned.assets,
        runtimes: manifestUnsigned.runtimes,
      });

      const signedManifest: SignedManifest = {
        ...manifestUnsigned,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: manifestSignature,
          },
        ],
      };

      const manifestBytes = Buffer.from(JSON.stringify(signedManifest), "utf8");
      const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");

      // 3. Prepare Channel metadata pointing to the exact RC manifest digest
      const channelUnsigned = {
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        schemaVersion: "2.0.0",
        minSupportedVersion: "0.1.0",
        currentVersion: rcVersion,
        updatedAt: releaseDate,
        releaseIdentity: {
          name: "Resin Language Toolchain",
          distributor: "Resin Contributors",
        },
        channels: {
          rc: {
            version: rcVersion,
            releaseDate,
            manifestUrl: `${baseUrl}/manifests/manifest-${rcVersion}.json`,
            manifestDigest: manifestSha,
            isLatest: false,
          },
        },
        rollbackReferences: {
          targetVersion: "0.1.0",
          minSafeVersion: "0.1.0",
        },
      };

      const channelSignature = signPayload({
        schemaVersion: channelUnsigned.schemaVersion,
        metadataVersion: channelUnsigned.metadataVersion,
        expiresAt: channelUnsigned.expiresAt,
        minSupportedVersion: channelUnsigned.minSupportedVersion,
        currentVersion: channelUnsigned.currentVersion,
        updatedAt: channelUnsigned.updatedAt,
        releaseIdentity: channelUnsigned.releaseIdentity,
        channels: channelUnsigned.channels,
        rollbackReferences: channelUnsigned.rollbackReferences,
      });

      const signedChannel: ChannelMetadata = {
        ...channelUnsigned,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: channelSignature,
          },
        ],
      };

      const channelBytes = Buffer.from(JSON.stringify(signedChannel), "utf8");

      // 4. Mock HTTP transport returning exact bytes for all requested URLs
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/channels.json`) {
          return new Response(channelBytes, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/manifests/manifest-${rcVersion}.json`) {
          return new Response(manifestBytes, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/assets/resin-${rcVersion}-linux-x64.tar.gz`) {
          return new Response(releaseTarball, {
            status: 200,
            headers: { "Content-Type": "application/gzip" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      // 5. Resolve the RC release
      const result = await resolveProductionRelease({
        platform: { os: "linux", arch: "x64", isWsl: false },
        channel: "rc",
        channelUrl: `${baseUrl}/channels.json`,
        trustedReleaseKeys: [
          { keyId: TEST_KEYPAIR.keyId, publicKeyHex: TEST_KEYPAIR.publicKeyHex },
        ],
        fetchImpl: mockFetch,
        allowInsecureHttpForTests: true,
      });

      expect(result.version).toBe(rcVersion);
      expect(result.releaseAsset.sha256).toBe(releaseTarballSha);
      expect(result.denoAsset.version).toBe(PINNED_DENO_VERSION);
      expect(result.provenance.manifestSha256).toBe(manifestSha);
      expect(result.provenance.signingKeyIds).toContain(TEST_KEYPAIR.keyId);
    });

    it("qualifies multi-root independent public key verification on channel and manifest", async () => {
      const rcVersion = "1.2.0-rc.2";
      const releaseDate = "2026-08-25T14:00:00.000Z";
      const baseUrl = "http://127.0.0.1:9199";

      const keyA_pair = crypto.generateKeyPairSync("ed25519");
      const keyB_pair = crypto.generateKeyPairSync("ed25519");

      const derA = keyA_pair.publicKey.export({ type: "spki", format: "der" });
      const derB = keyB_pair.publicKey.export({ type: "spki", format: "der" });

      const keyA: TrustedReleaseKey = {
        keyId: "resin-release-root-2026a",
        publicKeyHex: derA.subarray(-32).toString("hex"),
      };
      const keyB: TrustedReleaseKey = {
        keyId: "resin-release-root-2026b",
        publicKeyHex: derB.subarray(-32).toString("hex"),
      };

      const manifestPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        version: rcVersion,
        releaseDate,
        releaseIdentity: { repository: "https://github.com/resin-lang/resin" },
        assets: {
          "linux-x64": {
            filename: `resin-${rcVersion}-linux-x64.tar.gz`,
            path: `${baseUrl}/assets/resin-${rcVersion}-linux-x64.tar.gz`,
            platform: "linux",
            arch: "x64",
            sizeBytes: 1234,
            sha256: "b".repeat(64),
          },
        },
        runtimes: {
          deno: {
            version: PINNED_DENO_VERSION,
            required: true,
            assets: {
              "linux-x64": {
                filename: `deno-x86_64-unknown-linux-gnu.zip`,
                url: `${baseUrl}/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
                sha256: "c".repeat(64),
                archive: "zip" as const,
                executable: "deno",
              },
            },
          },
        },
      };

      const manifestCanonical = canonicalJson({
        schemaVersion: manifestPayload.schemaVersion,
        version: manifestPayload.version,
        metadataVersion: manifestPayload.metadataVersion,
        expiresAt: manifestPayload.expiresAt,
        releaseDate: manifestPayload.releaseDate,
        releaseIdentity: manifestPayload.releaseIdentity,
        assets: manifestPayload.assets,
        runtimes: manifestPayload.runtimes,
      });
      const manifestSigA = crypto
        .sign(null, Buffer.from(manifestCanonical, "utf8"), keyA_pair.privateKey)
        .toString("hex");

      const manifestSignedByA: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: keyA.keyId,
            algorithm: "Ed25519",
            publicKeyHex: keyA.publicKeyHex,
            signatureHex: manifestSigA,
          },
        ],
      };

      const manifestBytes = Buffer.from(JSON.stringify(manifestSignedByA), "utf8");
      const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");
      const channelPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        minSupportedVersion: "0.1.0",
        currentVersion: rcVersion,
        updatedAt: releaseDate,
        channels: {
          rc: {
            version: rcVersion,
            manifestUrl: `${baseUrl}/manifests/manifest-${rcVersion}.json`,
            manifestDigest: manifestSha,
            isLatest: true,
          },
        },
      };

      const channelCanonical = canonicalJson(channelPayload);
      const channelSigB = crypto
        .sign(null, Buffer.from(channelCanonical, "utf8"), keyB_pair.privateKey)
        .toString("hex");

      const channelSignedByB: ChannelMetadata = {
        ...channelPayload,
        signatures: [
          {
            keyId: keyB.keyId,
            algorithm: "Ed25519",
            publicKeyHex: keyB.publicKeyHex,
            signatureHex: channelSigB,
          },
        ],
      };

      const channelBytes = Buffer.from(JSON.stringify(channelSignedByB), "utf8");

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/channels.json`) {
          return new Response(channelBytes, { status: 200 });
        }
        if (url === `${baseUrl}/manifests/manifest-${rcVersion}.json`) {
          return new Response(manifestBytes, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await resolveProductionRelease({
        platform: { os: "linux", arch: "x64", isWsl: false },
        channel: "rc",
        channelUrl: `${baseUrl}/channels.json`,
        trustedReleaseKeys: [keyA, keyB],
        fetchImpl: mockFetch,
        allowInsecureHttpForTests: true,
      });

      expect(result.version).toBe(rcVersion);
    });

    it("verifies release resolution when configured via environment variables", async () => {
      const rcVersion = "1.3.0-rc.3";
      const releaseDate = "2026-08-25T15:00:00.000Z";
      const baseUrl = "http://127.0.0.1:9199";
      const airgappedKeyId = "resin-release-airgap-2026";

      const manifestPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        version: rcVersion,
        releaseDate,
        releaseIdentity: { repository: "https://github.com/resin-lang/resin" },
        assets: {
          "linux-x64": {
            filename: `resin-${rcVersion}-linux-x64.tar.gz`,
            path: `${baseUrl}/assets/resin-${rcVersion}-linux-x64.tar.gz`,
            platform: "linux",
            arch: "x64",
            sizeBytes: 1234,
            sha256: "d".repeat(64),
          },
        },
        runtimes: {
          deno: {
            version: PINNED_DENO_VERSION,
            required: true,
            assets: {
              "linux-x64": {
                filename: `deno-x86_64-unknown-linux-gnu.zip`,
                url: `${baseUrl}/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
                sha256: "e".repeat(64),
                archive: "zip" as const,
                executable: "deno",
              },
            },
          },
        },
      };

      const manifestSig = signPayload({
        schemaVersion: manifestPayload.schemaVersion,
        version: manifestPayload.version,
        metadataVersion: manifestPayload.metadataVersion,
        expiresAt: manifestPayload.expiresAt,
        releaseDate: manifestPayload.releaseDate,
        releaseIdentity: manifestPayload.releaseIdentity,
        assets: manifestPayload.assets,
        runtimes: manifestPayload.runtimes,
      });
      const signedManifest: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: airgappedKeyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: manifestSig,
          },
        ],
      };

      const manifestBytes = Buffer.from(JSON.stringify(signedManifest), "utf8");
      const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");
      const channelPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        minSupportedVersion: "0.1.0",
        currentVersion: rcVersion,
        updatedAt: releaseDate,
        channels: {
          stable: {
            version: rcVersion,
            manifestUrl: `${baseUrl}/manifests/manifest-${rcVersion}.json`,
            manifestDigest: manifestSha,
            isLatest: true,
          },
        },
      };

      const channelSig = signPayload(channelPayload);
      const signedChannel: ChannelMetadata = {
        ...channelPayload,
        signatures: [
          {
            keyId: airgappedKeyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: channelSig,
          },
        ],
      };

      const channelBytes = Buffer.from(JSON.stringify(signedChannel), "utf8");

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/airgapped-channels.json`) {
          return new Response(channelBytes, { status: 200 });
        }
        if (url === `${baseUrl}/manifests/manifest-${rcVersion}.json`) {
          return new Response(manifestBytes, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      };

      // Programmatic pinned trusted keys and channel URL are required and succeed
      const result = await resolveProductionRelease({
        platform: { os: "linux", arch: "x64", isWsl: false },
        channelUrl: `${baseUrl}/airgapped-channels.json`,
        trustedReleaseKeys: [{ keyId: airgappedKeyId, publicKeyHex: TEST_KEYPAIR.publicKeyHex }],
        allowInsecureHttpForTests: true,
        fetchImpl: mockFetch,
      });

      expect(result.version).toBe(rcVersion);
      expect(result.provenance.channelUrl).toBe(`${baseUrl}/airgapped-channels.json`);

      // Unvetted ambient env override is ignored/rejected without programmatic pinning
      const envOverride: Record<string, string> = {
        RESIN_RELEASE_CHANNEL_URL: `${baseUrl}/airgapped-channels.json`,
        RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: JSON.stringify([
          { keyId: airgappedKeyId, publicKeyHex: TEST_KEYPAIR.publicKeyHex },
        ]),
        RESIN_ALLOW_INSECURE_RELEASE_TRANSPORT: "1",
      };
      await expect(
        resolveProductionRelease({
          platform: { os: "linux", arch: "x64", isWsl: false },
          fetchImpl: mockFetch,
          env: envOverride,
        }),
      ).rejects.toThrow();
    });

    it("rejects release signed only by a revoked key", async () => {
      const rcVersion = "1.4.0-rc.4";
      const releaseDate = "2026-08-25T16:00:00.000Z";
      const baseUrl = "http://127.0.0.1:9199";

      const keyA_pair = crypto.generateKeyPairSync("ed25519");
      const keyB_pair = crypto.generateKeyPairSync("ed25519");

      const derA = keyA_pair.publicKey.export({ type: "spki", format: "der" });
      const derB = keyB_pair.publicKey.export({ type: "spki", format: "der" });

      const keyA: TrustedReleaseKey = {
        keyId: "resin-release-root-compromised",
        publicKeyHex: derA.subarray(-32).toString("hex"),
      };
      const keyB: TrustedReleaseKey = {
        keyId: "resin-release-root-active",
        publicKeyHex: derB.subarray(-32).toString("hex"),
      };

      const manifestPayload = {
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        schemaVersion: "2.0.0",
        version: rcVersion,
        releaseDate,
        releaseIdentity: { repository: "https://github.com/resin-lang/resin" },
        assets: {
          "linux-x64": {
            filename: `resin-${rcVersion}-linux-x64.tar.gz`,
            path: `${baseUrl}/assets/resin-${rcVersion}-linux-x64.tar.gz`,
            platform: "linux",
            arch: "x64",
            sizeBytes: 1234,
            sha256: "f".repeat(64),
          },
        },
        runtimes: {
          deno: {
            version: PINNED_DENO_VERSION,
            required: true,
            assets: {
              "linux-x64": {
                filename: `deno-x86_64-unknown-linux-gnu.zip`,
                url: `${baseUrl}/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
                sha256: "0".repeat(64),
                archive: "zip" as const,
                executable: "deno",
              },
            },
          },
        },
      };

      const manifestCanonical = canonicalJson({
        schemaVersion: manifestPayload.schemaVersion,
        metadataVersion: manifestPayload.metadataVersion,
        expiresAt: manifestPayload.expiresAt,
        version: manifestPayload.version,
        releaseDate: manifestPayload.releaseDate,
        releaseIdentity: manifestPayload.releaseIdentity,
        assets: manifestPayload.assets,
        runtimes: manifestPayload.runtimes,
      });
      const manifestSigA = crypto
        .sign(null, Buffer.from(manifestCanonical, "utf8"), keyA_pair.privateKey)
        .toString("hex");

      const manifestSignedByA: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: keyA.keyId,
            algorithm: "Ed25519",
            publicKeyHex: keyA.publicKeyHex,
            signatureHex: manifestSigA,
          },
        ],
      };

      const manifestBytes = Buffer.from(JSON.stringify(manifestSignedByA), "utf8");
      const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");

      const channelPayload = {
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        schemaVersion: "2.0.0",
        minSupportedVersion: "0.1.0",
        currentVersion: rcVersion,
        updatedAt: releaseDate,
        revokedKeyIds: [keyA.keyId],
        channels: {
          rc: {
            version: rcVersion,
            releaseDate,
            manifestUrl: `${baseUrl}/manifests/manifest-${rcVersion}.json`,
            manifestDigest: manifestSha,
            isLatest: true,
          },
        },
      };

      const channelCanonical = canonicalJson(channelPayload);
      const channelSigB = crypto
        .sign(null, Buffer.from(channelCanonical, "utf8"), keyB_pair.privateKey)
        .toString("hex");

      const channelSignedByB: ChannelMetadata = {
        ...channelPayload,
        signatures: [
          {
            keyId: keyB.keyId,
            algorithm: "Ed25519",
            publicKeyHex: keyB.publicKeyHex,
            signatureHex: channelSigB,
          },
        ],
      };

      const channelBytes = Buffer.from(JSON.stringify(channelSignedByB), "utf8");

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/channels.json`) {
          return new Response(channelBytes, { status: 200 });
        }
        if (url === `${baseUrl}/manifests/manifest-${rcVersion}.json`) {
          return new Response(manifestBytes, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      };

      await expect(
        resolveProductionRelease({
          platform: { os: "linux", arch: "x64", isWsl: false },
          channel: "rc",
          channelUrl: `${baseUrl}/channels.json`,
          trustedReleaseKeys: [keyB, keyA],
          fetchImpl: mockFetch,
          allowInsecureHttpForTests: true,
        }),
      ).rejects.toThrow(/revoked/i);
    });

    it("rejects manifest if its SHA256 digest does not match channel manifestDigest", async () => {
      const rcVersion = "1.5.0-rc.5";
      const releaseDate = "2026-08-25T17:00:00.000Z";
      const baseUrl = "http://127.0.0.1:9199";

      const channelPayload = {
        schemaVersion: "2.0.0",
        minSupportedVersion: "0.1.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        currentVersion: rcVersion,
        updatedAt: releaseDate,
        channels: {
          rc: {
            version: rcVersion,
            releaseDate,
            manifestUrl: `${baseUrl}/manifests/manifest-${rcVersion}.json`,
            manifestDigest: "0".repeat(64), // Deliberate mismatch
            isLatest: true,
          },
        },
      };

      const channelSig = signPayload(channelPayload);
      const signedChannel: ChannelMetadata = {
        ...channelPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: channelSig,
          },
        ],
      };

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/channels.json`) {
          return new Response(JSON.stringify(signedChannel), { status: 200 });
        }
        if (url === `${baseUrl}/manifests/manifest-${rcVersion}.json`) {
          return new Response(JSON.stringify({ schemaVersion: "2.0.0" }), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      };

      await expect(
        resolveProductionRelease({
          platform: { os: "linux", arch: "x64", isWsl: false },
          channel: "rc",
          channelUrl: `${baseUrl}/channels.json`,
          trustedReleaseKeys: [
            { keyId: TEST_KEYPAIR.keyId, publicKeyHex: TEST_KEYPAIR.publicKeyHex },
          ],
          fetchImpl: mockFetch,
          allowInsecureHttpForTests: true,
        }),
      ).rejects.toThrow(/Release manifest digest mismatch/);
    });

    it("qualifies root-relative channel → manifest → asset/runtime resolution and preserves absolute URLs in provenance", async () => {
      const rcVersion = "1.6.0-rc.6";
      const releaseDate = "2026-08-25T18:00:00.000Z";
      const baseUrl = "http://127.0.0.1:9199";

      const releaseTarball = Buffer.from("dummy-rc-root-relative-tarball-payload", "utf8");
      const releaseTarballSha = crypto.createHash("sha256").update(releaseTarball).digest("hex");

      const manifestPayload = {
        schemaVersion: "2.0.0",
        version: rcVersion,
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate,
        releaseIdentity: {
          name: "Resin Language Toolchain",
          distributor: "Resin Contributors",
          repository: "https://github.com/resin-lang/resin",
          commitSha: "b".repeat(40),
        },
        assets: {
          "linux-x64": {
            filename: `resin-${rcVersion}-linux-x64.tar.gz`,
            path: `/releases/v1/assets/resin-${rcVersion}-linux-x64.tar.gz`,
            platform: "linux",
            arch: "x64",
            isWsl: false,
            sizeBytes: releaseTarball.length,
            sha256: releaseTarballSha,
          },
        },
        runtimes: {
          deno: {
            version: PINNED_DENO_VERSION,
            required: true,
            assets: {
              "linux-x64": {
                filename: "deno-x86_64-unknown-linux-gnu.zip",
                url: `/releases/v1/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
                sha256: "1".repeat(64),
                archive: "zip" as const,
                executable: "deno",
              },
            },
          },
        },
      };

      const manifestSig = signPayload({
        schemaVersion: manifestPayload.schemaVersion,
        version: manifestPayload.version,
        releaseDate: manifestPayload.releaseDate,
        metadataVersion: manifestPayload.metadataVersion,
        expiresAt: manifestPayload.expiresAt,
        releaseIdentity: manifestPayload.releaseIdentity,
        assets: manifestPayload.assets,
        runtimes: manifestPayload.runtimes,
      });

      const signedManifest: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: manifestSig,
          },
        ],
      };

      const manifestBytes = Buffer.from(JSON.stringify(signedManifest), "utf8");
      const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");

      const channelPayload = {
        schemaVersion: "2.0.0",
        minSupportedVersion: "0.1.0",
        currentVersion: rcVersion,
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        updatedAt: releaseDate,
        channels: {
          rc: {
            version: rcVersion,
            releaseDate,
            manifestUrl: `/releases/v1/manifests/manifest-${rcVersion}.json`,
            manifestDigest: manifestSha,
            isLatest: true,
          },
        },
      };
      const channelSig = signPayload({
        schemaVersion: channelPayload.schemaVersion,
        metadataVersion: channelPayload.metadataVersion,
        expiresAt: channelPayload.expiresAt,
        minSupportedVersion: channelPayload.minSupportedVersion,
        currentVersion: channelPayload.currentVersion,
        updatedAt: channelPayload.updatedAt,
        channels: channelPayload.channels,
      });
      const signedChannel: ChannelMetadata = {
        ...channelPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: channelSig,
          },
        ],
      };

      const channelBytes = Buffer.from(JSON.stringify(signedChannel), "utf8");

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/releases/v1/channels.json`) {
          return new Response(channelBytes, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/releases/v1/manifests/manifest-${rcVersion}.json`) {
          return new Response(manifestBytes, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/releases/v1/assets/resin-${rcVersion}-linux-x64.tar.gz`) {
          return new Response(releaseTarball, {
            status: 200,
            headers: { "Content-Type": "application/gzip" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await resolveProductionRelease({
        platform: { os: "linux", arch: "x64", isWsl: false },
        channel: "rc",
        channelUrl: `${baseUrl}/releases/v1/channels.json`,
        trustedReleaseKeys: [
          { keyId: TEST_KEYPAIR.keyId, publicKeyHex: TEST_KEYPAIR.publicKeyHex },
        ],
        fetchImpl: mockFetch,
        allowInsecureHttpForTests: true,
      });

      expect(result.version).toBe(rcVersion);
      expect(result.releaseAssetUrl).toBe(
        `${baseUrl}/releases/v1/assets/resin-${rcVersion}-linux-x64.tar.gz`,
      );
      expect(result.provenance.manifestUrl).toBe(
        `${baseUrl}/releases/v1/manifests/manifest-${rcVersion}.json`,
      );
      expect(result.provenance.releaseAssetUrl).toBe(
        `${baseUrl}/releases/v1/assets/resin-${rcVersion}-linux-x64.tar.gz`,
      );
      expect(result.denoAsset.url).toBe(
        `${baseUrl}/releases/v1/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
      );
      expect(result.provenance.deno.url).toBe(
        `${baseUrl}/releases/v1/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
      );
      expect(result.provenance.deno.version).toBe(PINNED_DENO_VERSION);
    });

    it("enforces contracted pinned Deno runtime sha256 and size in production mode", async () => {
      const rcVersion = "1.7.0-rc.7";
      const releaseDate = "2026-08-25T19:00:00.000Z";
      const baseUrl = "https://dist.resin.sh";

      const releaseTarball = Buffer.from("dummy-rc-tarball", "utf8");
      const releaseTarballSha = crypto.createHash("sha256").update(releaseTarball).digest("hex");

      const manifestPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        version: rcVersion,
        releaseDate,
        releaseIdentity: {
          name: "Resin Language Toolchain",
          distributor: "Resin Contributors",
          repository: "https://github.com/resin-lang/resin",
          commitSha: "c".repeat(40),
        },
        assets: {
          "linux-x64": {
            filename: `resin-${rcVersion}-linux-x64.tar.gz`,
            path: `${baseUrl}/assets/resin-${rcVersion}-linux-x64.tar.gz`,
            platform: "linux",
            arch: "x64",
            isWsl: false,
            sizeBytes: releaseTarball.length,
            sha256: releaseTarballSha,
          },
        },
        runtimes: {
          deno: {
            version: PINNED_DENO_VERSION,
            required: true,
            assets: {
              "linux-x64": {
                filename: `deno-x86_64-unknown-linux-gnu.zip`,
                url: `${baseUrl}/assets/deno-${PINNED_DENO_VERSION}-linux-x64.zip`,
                sha256: "0".repeat(64),
                sizeBytes: 12345,
                archive: "zip" as const,
                executable: "deno",
              },
            },
          },
        },
      };

      const manifestSig = signPayload({
        schemaVersion: manifestPayload.schemaVersion,
        metadataVersion: manifestPayload.metadataVersion,
        expiresAt: manifestPayload.expiresAt,
        version: manifestPayload.version,
        releaseDate: manifestPayload.releaseDate,
        releaseIdentity: manifestPayload.releaseIdentity,
        assets: manifestPayload.assets,
        runtimes: manifestPayload.runtimes,
      });

      const signedManifest: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: manifestSig,
          },
        ],
      };

      const manifestBytes = Buffer.from(JSON.stringify(signedManifest), "utf8");
      const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");

      const channelPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        minSupportedVersion: "0.1.0",
        currentVersion: rcVersion,
        updatedAt: releaseDate,
        channels: {
          rc: {
            version: rcVersion,
            releaseDate,
            manifestUrl: `${baseUrl}/manifests/manifest-${rcVersion}.json`,
            manifestDigest: manifestSha,
            isLatest: true,
          },
        },
      };

      const channelSig = signPayload(channelPayload);
      const signedChannel: ChannelMetadata = {
        ...channelPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: channelSig,
          },
        ],
      };

      const channelBytes = Buffer.from(JSON.stringify(signedChannel), "utf8");

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/channels.json`) {
          return new Response(channelBytes, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/manifests/manifest-${rcVersion}.json`) {
          return new Response(manifestBytes, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const mockLookup = async () => [{ address: "93.184.216.34", family: 4 }];

      await expect(
        resolveProductionRelease({
          platform: { os: "linux", arch: "x64", isWsl: false },
          channel: "rc",
          channelUrl: `${baseUrl}/channels.json`,
          trustedReleaseKeys: [
            { keyId: TEST_KEYPAIR.keyId, publicKeyHex: TEST_KEYPAIR.publicKeyHex },
          ],
          fetchImpl: mockFetch,
          dnsLookup: mockLookup,
          allowInsecureHttpForTests: false,
        }),
      ).rejects.toThrow(/Deno runtime asset (size|sha256) mismatch/);
    });
  });

  describe("Bundled release trust parsing and validation", () => {
    const generateRootKey = (keyId: string) => {
      const kp = crypto.generateKeyPairSync("ed25519");
      const der = kp.publicKey.export({ type: "spki", format: "der" });
      const publicKeyHex = der.subarray(-32).toString("hex");
      const publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
      const publicKeyFingerprintSha256 = crypto.createHash("sha256").update(der).digest("hex");
      return {
        keyId,
        algorithm: "Ed25519",
        trustDomain: "production",
        publicKeyPem,
        publicKeyHex,
        publicKeyFingerprintSha256,
      };
    };

    it("parses valid schema 2.0.0 production bundles and preserves multi-root key ordering", () => {
      const rootA = generateRootKey("resin-release-root-2026a");
      const rootB = generateRootKey("resin-release-root-2026b");
      const rootC = generateRootKey("resin-release-root-2026c");

      // Single root
      const singleBundle = {
        schemaVersion: "2.0.0",
        trustDomain: "production",
        trustedKeys: [rootA],
      };
      const resultSingle = parseBundledReleaseTrust(singleBundle);
      expect(resultSingle).toHaveLength(1);
      expect(resultSingle[0].keyId).toBe("resin-release-root-2026a");
      expect(resultSingle[0].publicKeyHex).toBe(rootA.publicKeyHex);

      // Multi root ordering
      const multiBundle = {
        schemaVersion: "2.0.0",
        trustDomain: "production",
        trustedKeys: [rootB, rootA, rootC],
      };
      const resultMulti = parseBundledReleaseTrust(multiBundle);
      expect(resultMulti).toHaveLength(3);
      expect(resultMulti[0].keyId).toBe("resin-release-root-2026b");
      expect(resultMulti[1].keyId).toBe("resin-release-root-2026a");
      expect(resultMulti[2].keyId).toBe("resin-release-root-2026c");
    });
    it("resolves bundled release-trust.json path relative to parent directory in production dist layout", async () => {
      await expect(loadBundledTrustedReleaseKeys()).rejects.toThrow(
        /Failed to load bundled release trust file at .*release-trust\.json/,
      );
    });

    it("rejects non-object and non-conforming bundle structures", () => {
      expect(() => parseBundledReleaseTrust(null)).toThrow(/must be a JSON object/);
      expect(() => parseBundledReleaseTrust([])).toThrow(/must be a JSON object/);
      expect(() => parseBundledReleaseTrust("string")).toThrow(/must be a JSON object/);
      expect(() => parseBundledReleaseTrust(123)).toThrow(/must be a JSON object/);
    });

    it("rejects invalid schemaVersion and non-production trustDomain", () => {
      const rootA = generateRootKey("resin-release-root-2026a");

      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "1.0.0",
          trustDomain: "production",
          trustedKeys: [rootA],
        }),
      ).toThrow(/Unsupported bundled release trust schemaVersion/);

      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "staging",
          trustedKeys: [rootA],
        }),
      ).toThrow(/Unsupported bundled release trust trustDomain/);
    });

    it("rejects empty or missing trustedKeys array", () => {
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [],
        }),
      ).toThrow(/requires a non-empty 'trustedKeys' array/);

      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
        }),
      ).toThrow(/requires a non-empty 'trustedKeys' array/);
    });

    it("rejects permanently revoked key IDs in bundled release trust", () => {
      const revokedRoot = generateRootKey("resin-release-v1");
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [revokedRoot],
        }),
      ).toThrow(/is revoked/i);
    });

    it("rejects duplicate keyIds and duplicate public root key hexes", () => {
      const rootA = generateRootKey("resin-release-root-2026a");
      const rootB = generateRootKey("resin-release-root-2026b");

      // Duplicate keyId
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [rootA, { ...rootB, keyId: rootA.keyId }],
        }),
      ).toThrow(/Duplicate trusted keyId/);

      // Duplicate publicKeyHex
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [
            rootA,
            {
              ...rootB,
              publicKeyHex: rootA.publicKeyHex,
              publicKeyPem: rootA.publicKeyPem,
              publicKeyFingerprintSha256: rootA.publicKeyFingerprintSha256,
            },
          ],
        }),
      ).toThrow(/Duplicate public root key hex/);
    });

    it("rejects unsupported algorithms and non-production key records", () => {
      const rootA = generateRootKey("resin-release-root-2026a");

      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [{ ...rootA, algorithm: "RSA" }],
        }),
      ).toThrow(/unsupported algorithm/);

      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [{ ...rootA, trustDomain: "development" }],
        }),
      ).toThrow(/belongs to 'development' trust domain/);
    });

    it("rejects keys with missing or invalid publicKeyPem, publicKeyHex, and fingerprint", () => {
      const rootA = generateRootKey("resin-release-root-2026a");
      const rootB = generateRootKey("resin-release-root-2026b");

      // Missing publicKeyPem
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [{ ...rootA, publicKeyPem: "" }],
        }),
      ).toThrow(/missing 'publicKeyPem'/);

      // publicKeyHex does not match publicKeyPem
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [{ ...rootA, publicKeyHex: rootB.publicKeyHex }],
        }),
      ).toThrow(/publicKeyHex does not match publicKeyPem/);

      // publicKeyFingerprintSha256 does not match publicKeyPem
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [
            {
              ...rootA,
              publicKeyFingerprintSha256:
                "0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        }),
      ).toThrow(/publicKeyFingerprintSha256 mismatch/);

      // Corrupted PEM
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [
            {
              ...rootA,
              publicKeyPem: "-----BEGIN PUBLIC KEY-----\ncorrupt\n-----END PUBLIC KEY-----",
            },
          ],
        }),
      ).toThrow(/invalid publicKeyPem/);
    });

    it("rejects forbidden extra properties in bundled trustedKeys objects", () => {
      const rootA = generateRootKey("resin-release-root-2026a");
      expect(() =>
        parseBundledReleaseTrust({
          schemaVersion: "2.0.0",
          trustDomain: "production",
          trustedKeys: [{ ...rootA, unauthorizedExtraField: true }],
        }),
      ).toThrow(/contains forbidden property 'unauthorizedExtraField'/);
    });
  });

  describe("RESIN_TRUSTED_RELEASE_PUBLIC_KEYS environment override", () => {
    it("parses valid override JSON with keyId and publicKeyHex", async () => {
      const keys = await loadBundledTrustedReleaseKeys({
        RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: JSON.stringify([
          { keyId: "resin-release-root-2026a", publicKeyHex: "a".repeat(64) },
          { keyId: "resin-release-root-2026b", publicKeyHex: "b".repeat(64) },
        ]),
      });

      expect(keys).toHaveLength(2);
      expect(keys[0].keyId).toBe("resin-release-root-2026a");
      expect(keys[0].publicKeyHex).toBe("a".repeat(64));
      expect(keys[1].keyId).toBe("resin-release-root-2026b");
      expect(keys[1].publicKeyHex).toBe("b".repeat(64));
    });

    it("rejects invalid override formats and revoked keys", async () => {
      // Non-JSON string
      await expect(
        loadBundledTrustedReleaseKeys({ RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: "not-json" }),
      ).rejects.toThrow(/is not valid JSON/);

      // Empty array
      await expect(
        loadBundledTrustedReleaseKeys({ RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: "[]" }),
      ).rejects.toThrow(/must be a non-empty array/);

      // Revoked keyId
      await expect(
        loadBundledTrustedReleaseKeys({
          RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: JSON.stringify([
            { keyId: "resin-release-v1", publicKeyHex: "a".repeat(64) },
          ]),
        }),
      ).rejects.toThrow(/is revoked/i);

      // Invalid hex length
      await expect(
        loadBundledTrustedReleaseKeys({
          RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: JSON.stringify([
            { keyId: "resin-release-root-2026a", publicKeyHex: "short" },
          ]),
        }),
      ).rejects.toThrow(/requires a 64-character hex publicKeyHex/);

      // Duplicate keyId
      await expect(
        loadBundledTrustedReleaseKeys({
          RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: JSON.stringify([
            { keyId: "resin-release-root-2026a", publicKeyHex: "a".repeat(64) },
            { keyId: "resin-release-root-2026a", publicKeyHex: "b".repeat(64) },
          ]),
        }),
      ).rejects.toThrow(/Duplicate trusted keyId/i);

      // Duplicate publicKeyHex
      await expect(
        loadBundledTrustedReleaseKeys({
          RESIN_TRUSTED_RELEASE_PUBLIC_KEYS: JSON.stringify([
            { keyId: "resin-release-root-2026a", publicKeyHex: "a".repeat(64) },
            { keyId: "resin-release-root-2026b", publicKeyHex: "a".repeat(64) },
          ]),
        }),
      ).rejects.toThrow(/Duplicate public root key hex/i);
    });
  });

  describe("Node native pinned loopback transport", () => {
    it("fetches bytes from a real loopback HTTP server without injected fetch", async () => {
      const payload = Buffer.from("real-loopback-http-payload-ok", "utf8");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(payload.length),
        });
        res.end(payload);
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      try {
        const fetched = await fetchBytes(`http://127.0.0.1:${port}/payload.bin`, {
          allowInsecureHttpForTests: true,
        });
        expect(fetched).toEqual(payload);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("Prefixed staging channel and release ref resolution", () => {
    it("preserves staging prefix for root-relative /releases/v1/ refs", () => {
      const stagingChannelUrl =
        "https://dist.resin.sh/dry-runs/stage-token-123/releases/v1/channels.json";
      const manifestRef = "/releases/v1/manifests/manifest-1.0.0.json";
      const resolvedManifest = resolveReleaseRefUrl(manifestRef, stagingChannelUrl);
      expect(resolvedManifest).toBe(
        "https://dist.resin.sh/dry-runs/stage-token-123/releases/v1/manifests/manifest-1.0.0.json",
      );

      const releaseAssetRef = "/releases/v1/assets/resin-v1.0.0-linux-x64.tar.gz";
      const resolvedAsset = resolveReleaseRefUrl(releaseAssetRef, resolvedManifest);
      expect(resolvedAsset).toBe(
        "https://dist.resin.sh/dry-runs/stage-token-123/releases/v1/assets/resin-v1.0.0-linux-x64.tar.gz",
      );

      const runtimeAssetRef = "/releases/v1/runtimes/deno/v2.9.5/deno-x86_64-unknown-linux-gnu.zip";
      const resolvedRuntime = resolveReleaseRefUrl(runtimeAssetRef, resolvedManifest);
      expect(resolvedRuntime).toBe(
        "https://dist.resin.sh/dry-runs/stage-token-123/releases/v1/runtimes/deno/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
      );
    });

    it("leaves production root and absolute external URLs unchanged", () => {
      const prodChannelUrl = "https://dist.resin.sh/releases/v1/channels.json";
      const manifestRef = "/releases/v1/manifests/manifest-1.0.0.json";
      expect(resolveReleaseRefUrl(manifestRef, prodChannelUrl)).toBe(
        "https://dist.resin.sh/releases/v1/manifests/manifest-1.0.0.json",
      );

      const externalUrl =
        "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip";
      expect(
        resolveReleaseRefUrl(
          externalUrl,
          "https://dist.resin.sh/dry-runs/stage-token-123/releases/v1/manifests/manifest-1.0.0.json",
        ),
      ).toBe(externalUrl);
    });
  });
});
