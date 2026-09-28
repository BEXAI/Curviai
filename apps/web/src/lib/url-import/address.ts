/**
 * Which IP addresses a server side import may connect to. Only public
 * unicast addresses pass: private, loopback, link local (which holds the
 * 169.254.169.254 cloud metadata address), carrier grade NAT (which holds
 * 100.100.100.200 on some clouds), documentation, benchmarking, multicast
 * and reserved ranges all fail. IPv6 is an allow list: only global unicast
 * (2000::/3) passes, minus the special blocks inside it, so unique local
 * (fc00::/7, which holds fd00:ec2::254), link local, IPv4 mapped, NAT64,
 * 6to4 and Teredo forms of a private address never slip through.
 */

import { BlockList, isIP } from "node:net";

const BLOCKED_V4: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link local and cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

const GLOBAL_V6: ReadonlyArray<[string, number]> = [["2000::", 3]];

const BLOCKED_V6: ReadonlyArray<[string, number]> = [
  ["2001::", 23], // IETF protocol assignments, Teredo, benchmarking, ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
  ["3fff::", 20], // documentation
];

function buildList(entries: ReadonlyArray<[string, number]>, family: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of entries) {
    list.addSubnet(network, prefix, family);
  }
  return list;
}

const blockedV4 = buildList(BLOCKED_V4, "ipv4");
const globalV6 = buildList(GLOBAL_V6, "ipv6");
const blockedV6 = buildList(BLOCKED_V6, "ipv6");

/** True only for a public unicast IPv4 or IPv6 address. Anything that does
 * not parse fails closed. */
export function isPublicAddress(address: string): boolean {
  // A zone id (fe80::1%en0) only ever appears on link local addresses.
  if (address.includes("%")) {
    return false;
  }
  try {
    switch (isIP(address)) {
      case 4:
        return !blockedV4.check(address, "ipv4");
      case 6:
        return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
      default:
        return false;
    }
  } catch {
    return false;
  }
}
