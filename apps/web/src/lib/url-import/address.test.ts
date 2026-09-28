import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./address";

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "23.227.38.65", // Shopify
    "52.94.236.248",
    "2606:4700::1111",
    "2a00:1450:4001:80b::200e",
  ])("allows the public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["0.0.0.0", "this network"],
    ["10.1.2.3", "private"],
    ["100.100.100.200", "carrier grade NAT and Alibaba metadata"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link local and cloud metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.170", "IETF assignments"],
    ["192.0.2.10", "documentation"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "IPv4 mapped loopback"],
    ["::ffff:7f00:1", "IPv4 mapped loopback, hex form"],
    ["::ffff:169.254.169.254", "IPv4 mapped metadata"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of the metadata address"],
    ["2002:7f00:1::", "6to4 of loopback"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["fc00::1", "unique local"],
    ["fd00:ec2::254", "AWS IPv6 metadata"],
    ["fe80::1", "link local"],
    ["fe80::1%en0", "link local with a zone"],
    ["ff02::1", "multicast"],
  ])("blocks %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("fails closed on anything that is not an address", () => {
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("localhost")).toBe(false);
    expect(isPublicAddress("2130706433")).toBe(false);
    expect(isPublicAddress("0x7f.1")).toBe(false);
  });
});
