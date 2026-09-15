import { describe, expect, it } from "vitest";
import { NMAP_MAX_XML_BYTES } from "@stonehush/contracts";
import { parseNmapXml } from "./nmap-xml.js";
const enc = new TextEncoder();
const b = (s: string) => enc.encode(s);
const valid = b(`<?xml version="1.0"?><nmaprun><host><address addr="192.0.2.10" addrtype="ipv4"/><hostnames><hostname name="host.test"/></hostnames><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http" product="nginx" version="1.18"/></port></ports></host></nmaprun>`);
const empty = b(`<?xml version="1.0"?><nmaprun></nmaprun>`);
describe("parseNmapXml", () => {
  it("parses valid single service", () => {
    const r = parseNmapXml(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.services).toHaveLength(1);
      expect(r.services[0]).toMatchObject({ address: "192.0.2.10", port: 80, hostname: "host.test", serviceName: "http" });
    }
  });
  it("accepts empty nmaprun", () => {
    const r = parseNmapXml(empty);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.services).toHaveLength(0);
  });
  it("rejects exact ancestry violations", () => {
    const samples = [
      b(`<nmaprun><hostnames><host><address addr="192.0.2.1" addrtype="ipv4"/></host></hostnames></nmaprun>`),
      b(`<nmaprun><host><ports><address addr="192.0.2.1" addrtype="ipv4"/></ports></host></nmaprun>`),
      b(`<nmaprun><host><hostname name="bad.test"/></host></nmaprun>`),
      b(`<nmaprun><host><port protocol="tcp" portid="80"><state state="open"/></port></host></nmaprun>`),
      b(`<nmaprun><host><address addr="192.0.2.1" addrtype="ipv4"/><state state="open"/></host></nmaprun>`),
      b(`<nmaprun><host><host><address addr="192.0.2.1" addrtype="ipv4"/></host></host></nmaprun>`),
      b(`<nmaprun><host><address addr="192.0.2.1" addrtype="ipv4"/><ports><port protocol="tcp" portid="80"><port protocol="tcp" portid="81"><state state="open"/></port></port></ports></host></nmaprun>`),
    ];
    for (const s of samples) expect(parseNmapXml(s).ok).toBe(false);
  });
  it("allows unknown balanced elements within depth", () => {
    const v = b(`<nmaprun><host><address addr="192.0.2.10" addrtype="ipv4"/><extra><inner>ok</inner></extra><ports><port protocol="tcp" portid="80"><state state="open"/></port></ports></host></nmaprun>`);
    expect(parseNmapXml(v).ok).toBe(true);
  });
  it("rejects deep nesting beyond max depth", () => {
    const build = (n: number) => {
      let x = "<nmaprun>";
      for (let i = 0; i < n; i += 1) x += "<a>";
      for (let i = 0; i < n; i += 1) x += "</a>";
      x += "</nmaprun>";
      return b(x);
    };
    expect(parseNmapXml(build(33)).ok).toBe(false);
  });
  it("rejects unsafe character-data entity syntax", () => {
    expect(parseNmapXml(b(`<nmaprun> hello &bad; world </nmaprun>`)).ok).toBe(false);
    expect(parseNmapXml(b(`<nmaprun><host><address addr="a &foo; b" addrtype="ipv4"/></host></nmaprun>`)).ok).toBe(false);
    expect(parseNmapXml(b(`<nmaprun> hello &amp; world </nmaprun>`)).ok).toBe(true);
  });
  it("rejects DTD and ENTITY", () => {
    expect(parseNmapXml(b(`<!DOCTYPE nmaprun [<!ENTITY x "y">]><nmaprun></nmaprun>`)).ok).toBe(false);
  });
  it("accepts benign nmap DOCTYPE without an internal subset", () => {
    const withDoctype = b(
      `<?xml version="1.0"?><!DOCTYPE nmaprun><nmaprun><host><address addr="192.0.2.10" addrtype="ipv4"/><hostnames><hostname name="host.test"/></hostnames><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http" product="nginx" version="1.18"/></port></ports></host></nmaprun>`,
    );
    const r = parseNmapXml(withDoctype);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.services).toHaveLength(1);
      expect(r.services[0]).toMatchObject({ address: "192.0.2.10", port: 80 });
    }
  });
  it("accepts mixed-case benign nmap DOCTYPE", () => {
    expect(parseNmapXml(b(`<!DoCtYpE nmaprun><nmaprun></nmaprun>`)).ok).toBe(true);
  });
  it("rejects ENTITY and internal subset doctypes", () => {
    expect(parseNmapXml(b(`<!DOCTYPE nmaprun [<!ENTITY x "y">]><nmaprun></nmaprun>`)).ok).toBe(false);
    expect(parseNmapXml(b(`<!doctype nmaprun [<!entity x "y">]><nmaprun></nmaprun>`)).ok).toBe(false);
    expect(parseNmapXml(b(`<!DOCTYPE nmaprun [ ]><nmaprun></nmaprun>`)).ok).toBe(false);
  });
  it("rejects external SYSTEM and PUBLIC doctypes", () => {
    expect(parseNmapXml(b(`<!DOCTYPE nmaprun SYSTEM "https://example.test/nmap.dtd"><nmaprun></nmaprun>`)).ok).toBe(false);
    expect(parseNmapXml(b(`<!DOCTYPE nmaprun PUBLIC "-//Test//EN" "https://example.test/nmap.dtd"><nmaprun></nmaprun>`)).ok).toBe(false);
    expect(parseNmapXml(b(`<!doctype nmaprun system "https://example.test/nmap.dtd"><nmaprun></nmaprun>`)).ok).toBe(false);
  });
  it("rejects invalid UTF-8 and oversize", () => {
    expect(parseNmapXml(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
    const big = new Uint8Array(NMAP_MAX_XML_BYTES + 1);
    big.fill(0x41);
    expect(parseNmapXml(big).ok).toBe(false);
  });
});
