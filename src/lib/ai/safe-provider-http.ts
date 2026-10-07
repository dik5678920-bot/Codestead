import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ProviderError } from "./types";

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const resolveAll: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Allow routable unicast only; IPv4-mapped/tunneled IPv6 is deliberately excluded. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes(".")) return false;
  const [first, second = "0"] = address.toLowerCase().split(":");
  const prefix = Number.parseInt(first, 16);
  const next = Number.parseInt(second, 16);
  return prefix >= 0x2000 && prefix <= 0x3fff && prefix !== 0x2002 &&
    !(prefix === 0x2001 && (next < 0x200 || next === 0xdb8));
}

export function providerBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("Use a public HTTPS base URL.", "POLICY"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new ProviderError("Use a public HTTPS base URL without credentials or query parameters.", "POLICY");
  }
  return url.href.replace(/\/+$/, "");
}

export async function resolvePublicProviderUrl(value: string, resolve: Resolver = resolveAll) {
  const url = new URL(providerBaseUrl(value));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ProviderError("Provider hostname must resolve only to public addresses.", "POLICY");
  }
  return { url, hostname, addresses };
}

/** DNS answers are checked AND pinned into the TLS connection to prevent rebinding. */
export async function safeProviderRequest(value: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try {
    const target = new URL(value);
    // Google pagination is generated internally; credentials never go in the query string.
    const query = target.search;
    target.search = "";
    const resolved = await Promise.race([
      resolvePublicProviderUrl(target.href),
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(new ProviderError("Provider request timed out.", "TIMEOUT"));
        controller.signal.addEventListener("abort", () => reject(new ProviderError("Provider request timed out.", "TIMEOUT")), { once: true });
      }),
    ]);
    resolved.url.search = query;
    const pinned = resolved.addresses[0];
    const maxResponseBytes = (init.method ?? "GET") === "GET" && resolved.url.pathname.endsWith("/models")
      ? 8_388_608 : 1_048_576;
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(resolved.url, {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        agent: false,
        signal: controller.signal,
        // Keep URL hostname, Host and TLS verification; only socket DNS is pinned.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status > 599) {
          incoming.destroy(); reject(new ProviderError("Provider returned an invalid HTTP status.", "BAD_RESPONSE", status)); return;
        }
        if (status >= 300 && status < 400) {
          incoming.destroy(); reject(new ProviderError("Provider redirects are not allowed.", "POLICY", status)); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            incoming.destroy(); reject(new ProviderError("Provider response exceeds the size limit.", maxResponseBytes === 8_388_608 ? "MODEL_LIST_LIMIT" : "BAD_RESPONSE", status)); return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            const headers = new Headers();
            for (const [name, entry] of Object.entries(incoming.headers)) {
              if (entry !== undefined) headers.set(name, Array.isArray(entry) ? entry.join(", ") : entry);
            }
            resolve(new Response(status === 204 || status === 205 ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers }));
          } catch {
            reject(new ProviderError("Provider returned an invalid HTTP response.", "BAD_RESPONSE", status));
          }
        });
      });
      outgoing.on("error", () => reject(new ProviderError(
        controller.signal.aborted ? "Provider request timed out." : "Provider request failed.",
        controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE",
      )));
      if (typeof init.body === "string") outgoing.write(init.body);
      outgoing.end();
    });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
