import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF guard for outbound webhooks. Blocks loopback, private, link-local (incl. cloud metadata
 * 169.254.169.254), CGNAT, multicast and unspecified addresses. Checked when a URL is saved *and*
 * again right before each delivery (DNS can change between the two). Set WEBHOOK_ALLOW_PRIVATE=true
 * for local development against an internal receiver.
 */
function blockedV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function blockedV6(ip: string) {
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return blockedV4(x.slice(7));
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
}
export const isBlockedIp = (ip: string) => (net.isIPv4(ip) ? blockedV4(ip) : net.isIPv6(ip) ? blockedV6(ip) : true);

export async function assertPublicUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw Object.assign(new Error("Invalid URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error("Webhook must use http or https"), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("Credentials in webhook URLs are not allowed"), { status: 400 });
  if (process.env.WEBHOOK_ALLOW_PRIVATE === "true") return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw Object.assign(new Error(`Cannot resolve ${host}`), { status: 400 });
  const bad = addrs.find(isBlockedIp);
  if (bad) throw Object.assign(new Error(`Webhook host resolves to a private or reserved address (${bad}); set WEBHOOK_ALLOW_PRIVATE=true to allow`), { status: 400 });
  return u;
}
