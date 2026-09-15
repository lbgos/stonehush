import {
  NMAP_MAX_HOSTS as MAX_HOSTS,
  NMAP_MAX_SERVICES as MAX_SERVICES,
  NMAP_MAX_XML_BYTES as MAX_BYTES,
  type NmapServiceObservation,
} from "@stonehush/contracts";
import { normalizeTarget } from "./normalize-target.js";

const MAX_ATTRIBUTE_VALUE_LENGTH = 256;
const MAX_SERVICE_FIELD_LENGTH = 64;
const MAX_ELEMENT_DEPTH = 32;

export type ParsedNmapService = NmapServiceObservation;

export type ParseNmapXmlResult =
  | { ok: true; services: ParsedNmapService[] }
  | { ok: false; error: { code: "nmap_xml_invalid" } };

function invalidResult(): ParseNmapXmlResult {
  return { ok: false, error: { code: "nmap_xml_invalid" } };
}

function decodeEntities(value: string): string | null {
  let decoded = "";
  let index = 0;

  while (index < value.length) {
    const entityStart = value.indexOf("&", index);

    if (entityStart === -1) {
      decoded += value.slice(index);
      break;
    }

    decoded += value.slice(index, entityStart);

    const entityEnd = value.indexOf(";", entityStart + 1);
    if (entityEnd === -1 || entityEnd - entityStart > 12) {
      return null;
    }

    const entity = value.slice(entityStart + 1, entityEnd);

    if (entity === "lt") {
      decoded += "<";
    } else if (entity === "gt") {
      decoded += ">";
    } else if (entity === "amp") {
      decoded += "&";
    } else if (entity === "quot") {
      decoded += '"';
    } else if (entity === "apos") {
      decoded += "'";
    } else if (entity.startsWith("#")) {
      let codePoint: number | null = null;

      if (entity[1] === "x" || entity[1] === "X") {
        const hex = entity.slice(2);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) {
          return null;
        }
        codePoint = Number.parseInt(hex, 16);
      } else {
        const decimal = entity.slice(1);
        if (!/^[0-9]{1,7}$/.test(decimal)) {
          return null;
        }
        codePoint = Number.parseInt(decimal, 10);
      }

      if (
        codePoint === null ||
        codePoint < 1 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return null;
      }

      decoded += String.fromCodePoint(codePoint);
    } else {
      return null;
    }

    index = entityEnd + 1;
  }

  return decoded;
}

function findTagEnd(text: string, start: number): number {
  let quote: string | null = null;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === ">") {
      return index;
    }
  }

  return -1;
}

interface HostContext {
  address: string | null;
  hostname: string | null;
  ports: PortContext[];
}

interface PortContext {
  protocol: string | null;
  port: number | null;
  state: string | null;
  serviceName: string | null;
  product: string | null;
  version: string | null;
}

export function parseNmapXml(bytes: Uint8Array): ParseNmapXmlResult {
  if (bytes.length > MAX_BYTES) {
    return invalidResult();
  }

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidResult();
  }

  const lowerCased = xml.toLowerCase();

  if (lowerCased.includes("<!entity")) {
    return invalidResult();
  }

  // Allow only a benign real-nmap DOCTYPE such as `<!DOCTYPE nmaprun>`.
  // Anything with an internal subset or external reference stays rejected.
  let doctypeSearchFrom = 0;
  let doctypeCount = 0;
  while (true) {
    const doctypeStart = lowerCased.indexOf("<!doctype", doctypeSearchFrom);
    if (doctypeStart === -1) {
      break;
    }
    doctypeCount += 1;
    if (doctypeCount > 1) {
      return invalidResult();
    }
    const doctypeEnd = findTagEnd(xml, doctypeStart + 1);
    if (doctypeEnd === -1) {
      return invalidResult();
    }
    const declaration = xml.slice(doctypeStart, doctypeEnd + 1);
    const declarationLower = declaration.toLowerCase();
    if (
      declarationLower.includes("[") ||
      declarationLower.includes("]") ||
      declarationLower.includes("entity") ||
      declarationLower.includes("system") ||
      declarationLower.includes("public")
    ) {
      return invalidResult();
    }
    if (!/^<!doctype\s+nmaprun\s*>$/i.test(declaration)) {
      return invalidResult();
    }
    doctypeSearchFrom = doctypeEnd + 1;
  }

  if (!lowerCased.includes("<nmaprun")) {
    return invalidResult();
  }

  const elementStack: string[] = [];
  let seenOpenNmapRun = false;
  let seenCloseNmapRun = false;

  const hosts: HostContext[] = [];
  let currentHost: HostContext | null = null;
  let currentPort: PortContext | null = null;
  let totalPorts = 0;
  let position = 0;

  while (position < xml.length) {
    const tagStart = xml.indexOf("<", position);

    if (tagStart === -1) {
      const tail = xml.slice(position);
      if (decodeEntities(tail) === null) {
        return invalidResult();
      }
      if (/\S/.test(tail) && elementStack.length === 0) {
        return invalidResult();
      }
      break;
    }

    if (tagStart > position) {
      const between = xml.slice(position, tagStart);
      if (decodeEntities(between) === null) {
        return invalidResult();
      }
      if (/\S/.test(between) && elementStack.length === 0) {
        return invalidResult();
      }
    }

    if (xml.startsWith("<!--", tagStart)) {
      const commentEnd = xml.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) {
        return invalidResult();
      }
      position = commentEnd + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = xml.indexOf("]]>", tagStart + 9);
      if (cdataEnd === -1) {
        return invalidResult();
      }
      position = cdataEnd + 3;
      continue;
    }

    if (xml.startsWith("<?", tagStart)) {
      const piEnd = xml.indexOf("?>", tagStart + 2);
      if (piEnd === -1) {
        return invalidResult();
      }
      position = piEnd + 2;
      continue;
    }

    if (xml.startsWith("<!", tagStart)) {
      const tagHead = xml.slice(tagStart, tagStart + 9).toLowerCase();
      if (tagHead.startsWith("<!doctype") && !seenOpenNmapRun) {
        const doctypeEnd = findTagEnd(xml, tagStart + 1);
        if (doctypeEnd === -1) {
          return invalidResult();
        }
        const declaration = xml.slice(tagStart, doctypeEnd + 1);
        const declarationLower = declaration.toLowerCase();
        if (
          declarationLower.includes("[") ||
          declarationLower.includes("]") ||
          declarationLower.includes("entity") ||
          declarationLower.includes("system") ||
          declarationLower.includes("public") ||
          !/^<!doctype\s+nmaprun\s*>$/i.test(declaration)
        ) {
          return invalidResult();
        }
        position = doctypeEnd + 1;
        continue;
      }
      return invalidResult();
    }

    const tagEnd = findTagEnd(xml, tagStart + 1);
    if (tagEnd === -1) {
      return invalidResult();
    }

    const rawTag = xml.slice(tagStart + 1, tagEnd);
    const trimmedTag = rawTag.trim();
    if (!trimmedTag) {
      return invalidResult();
    }

    let isClosing = false;
    let inner = trimmedTag;

    if (inner.startsWith("/")) {
      isClosing = true;
      inner = inner.slice(1).trim();
    }

    let isSelfClosing = false;
    if (!isClosing && inner.endsWith("/")) {
      isSelfClosing = true;
      inner = inner.slice(0, -1).trim();
    }

    let index = 0;
    while (index < inner.length && /\s/.test(inner[index] ?? "")) {
      index += 1;
    }

    const nameStart = index;
    while (index < inner.length && /[A-Za-z0-9_.\-:]/.test(inner[index] ?? "")) {
      index += 1;
    }

    const tagName = inner.slice(nameStart, index);
    if (!tagName || tagName.length > 64 || !/^[A-Za-z_][A-Za-z0-9_.\-:]*$/.test(tagName)) {
      return invalidResult();
    }

    const attributes = new Map<string, string>();

    if (!isClosing) {
      while (index < inner.length) {
        while (index < inner.length && /\s/.test(inner[index] ?? "")) {
          index += 1;
        }
        if (index >= inner.length) {
          break;
        }

        const attributeStart = index;
        while (index < inner.length && /[A-Za-z0-9_:\-.]/.test(inner[index] ?? "")) {
          index += 1;
        }

        const attributeName = inner.slice(attributeStart, index);
        if (!attributeName || attributeName.length > 64) {
          return invalidResult();
        }

        while (index < inner.length && /\s/.test(inner[index] ?? "")) {
          index += 1;
        }

        if (inner[index] !== "=") {
          return invalidResult();
        }
        index += 1;

        while (index < inner.length && /\s/.test(inner[index] ?? "")) {
          index += 1;
        }

        const quote = inner[index];
        if (quote !== '"' && quote !== "'") {
          return invalidResult();
        }
        index += 1;

        const valueEnd = inner.indexOf(quote, index);
        if (valueEnd === -1) {
          return invalidResult();
        }

        const rawValue = inner.slice(index, valueEnd);
        index = valueEnd + 1;

        const decodedValue = decodeEntities(rawValue);
        if (decodedValue === null || decodedValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
          return invalidResult();
        }
        if (decodedValue.includes("\0")) {
          return invalidResult();
        }
        if (
          (attributeName === "name" || attributeName === "product" || attributeName === "version") &&
          decodedValue.length > MAX_SERVICE_FIELD_LENGTH
        ) {
          return invalidResult();
        }
        if (attributeName === "addr" && decodedValue.length > 45) {
          return invalidResult();
        }
        if (attributes.has(attributeName)) {
          return invalidResult();
        }

        attributes.set(attributeName, decodedValue);
      }
    } else {
      while (index < inner.length && /\s/.test(inner[index] ?? "")) {
        index += 1;
      }
      if (index !== inner.length) {
        return invalidResult();
      }
    }

    if (isClosing) {
      const top = elementStack[elementStack.length - 1];
      if (!top || top !== tagName) {
        return invalidResult();
      }
      elementStack.pop();

      if (tagName === "nmaprun") {
        seenCloseNmapRun = true;
      }
      if (tagName === "host") {
        currentHost = null;
        currentPort = null;
      }
      if (tagName === "port") {
        currentPort = null;
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "nmaprun") {
      if (seenOpenNmapRun || elementStack.length !== 0) {
        return invalidResult();
      }
      seenOpenNmapRun = true;

      if (isSelfClosing) {
        seenCloseNmapRun = true;
      } else {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (elementStack.length === 0 || elementStack[0] !== "nmaprun") {
      return invalidResult();
    }

    const parent = elementStack[elementStack.length - 1] ?? null;
    const grandParent = elementStack[elementStack.length - 2] ?? null;

    if (tagName === "host") {
      if (parent !== "nmaprun" || hosts.length >= MAX_HOSTS) {
        return invalidResult();
      }

      const host: HostContext = { address: null, hostname: null, ports: [] };
      hosts.push(host);

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        currentHost = host;
        currentPort = null;
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "hostnames" || tagName === "ports") {
      if (parent !== "host") {
        return invalidResult();
      }

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "address") {
      if (parent !== "host" || currentHost === null) {
        return invalidResult();
      }

      const address = attributes.get("addr");
      const addressType = attributes.get("addrtype");
      if (address && (addressType === "ipv4" || addressType === "ipv6") && currentHost.address === null) {
        currentHost.address = address;
      }

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "hostname") {
      if (parent !== "hostnames" || grandParent !== "host" || currentHost === null) {
        return invalidResult();
      }

      if (currentHost.hostname === null) {
        const hostname = attributes.get("name");
        if (hostname && hostname.length >= 1 && hostname.length <= 253) {
          currentHost.hostname = hostname;
        }
      }

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "port") {
      if (parent !== "ports" || grandParent !== "host" || currentHost === null) {
        return invalidResult();
      }
      if (totalPorts >= MAX_SERVICES) {
        return invalidResult();
      }

      const protocol = attributes.get("protocol") ?? null;
      const portId = attributes.get("portid");
      let portNumber: number | null = null;
      if (portId && /^[0-9]{1,5}$/.test(portId)) {
        const numericPort = Number(portId);
        if (numericPort >= 1 && numericPort <= 65535) {
          portNumber = numericPort;
        }
      }

      const portContext: PortContext = {
        protocol,
        port: portNumber,
        state: null,
        serviceName: null,
        product: null,
        version: null,
      };
      currentHost.ports.push(portContext);
      totalPorts += 1;

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        currentPort = portContext;
        elementStack.push(tagName);
      } else {
        currentPort = null;
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "state") {
      if (parent !== "port" || currentPort === null) {
        return invalidResult();
      }

      const state = attributes.get("state");
      if (state) {
        currentPort.state = state;
      }

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (tagName === "service") {
      if (parent !== "port" || currentPort === null) {
        return invalidResult();
      }

      const serviceName = attributes.get("name") ?? null;
      const product = attributes.get("product") ?? null;
      const version = attributes.get("version") ?? null;
      if (serviceName) {
        currentPort.serviceName = serviceName;
      }
      if (product) {
        currentPort.product = product;
      }
      if (version) {
        currentPort.version = version;
      }

      if (!isSelfClosing) {
        if (elementStack.length >= MAX_ELEMENT_DEPTH) {
          return invalidResult();
        }
        elementStack.push(tagName);
      }

      position = tagEnd + 1;
      continue;
    }

    if (!isSelfClosing) {
      if (elementStack.length >= MAX_ELEMENT_DEPTH) {
        return invalidResult();
      }
      elementStack.push(tagName);
    }

    position = tagEnd + 1;
  }

  if (!seenOpenNmapRun || !seenCloseNmapRun || elementStack.length !== 0) {
    return invalidResult();
  }

  const services: ParsedNmapService[] = [];

  for (const host of hosts) {
    if (!host.address) {
      continue;
    }

    const normalized = normalizeTarget(host.address);
    if (!normalized.ok || normalized.target.kind !== "ip") {
      continue;
    }

    const address = normalized.target.address;

    for (const port of host.ports) {
      if (port.protocol !== "tcp" || port.port === null || port.state !== "open") {
        continue;
      }
      if (services.length >= MAX_SERVICES) {
        return invalidResult();
      }

      services.push({
        address,
        port: port.port,
        protocol: "tcp",
        hostname: host.hostname,
        serviceName: port.serviceName,
        product: port.product,
        version: port.version,
      });
    }
  }

  return { ok: true, services };
}
