import {
  TARGET_NORMALIZATION_PROFILE,
  type CanonicalCidrTarget,
  type CanonicalHostnameTarget,
  type CanonicalIpTarget,
  type CanonicalUrlHost,
  type CanonicalUrlTarget,
  type TargetNormalizationErrorCode,
  type TargetNormalizationFailure,
  type TargetNormalizationResult,
} from "@stonehush/contracts";
import { toASCII } from "tr46";

const MAXIMUM_TARGET_UTF8_BYTES = 4_096;
const MAXIMUM_ZONE_LENGTH = 15;
const ASCII_SURROUNDING_WHITESPACE = /^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g;
const CONTROL_BYTE = /[\x00-\x1f\x7f]/;
const STRICT_IPV4_COMPONENT = /^(?:0|[1-9]\d{0,2})$/;
const ZONE_PATTERN = /^[A-Za-z0-9._~-]+$/;

interface ParsedIpv6 {
  words: number[];
  address: string;
  mappedIpv4: string | null;
}

interface NormalizedHostname {
  ok: true;
  hostname: string;
}

interface NormalizedIpv4Host {
  ok: true;
  family: 4;
  address: string;
}

type NormalizedNonIpv6Host = NormalizedHostname | NormalizedIpv4Host;

function failure(
  code: TargetNormalizationErrorCode,
): TargetNormalizationFailure {
  return { ok: false, error: { code } };
}

function success<T extends CanonicalIpTarget | CanonicalCidrTarget | CanonicalHostnameTarget | CanonicalUrlTarget>(
  target: T,
): TargetNormalizationResult {
  return { ok: true, target };
}

function parseStrictIpv4(value: string): number[] | null {
  const components = value.split(".");
  if (
    components.length !== 4 ||
    components.some(
      (component) =>
        !STRICT_IPV4_COMPONENT.test(component) || Number(component) > 255,
    )
  ) {
    return null;
  }

  return components.map(Number);
}

function serializeIpv4(components: readonly number[]): string {
  return components.join(".");
}

function numericHostError(
  value: string,
): TargetNormalizationErrorCode | null {
  if (/^[+-]?0x[0-9a-f]+$/i.test(value)) {
    return "ambiguous_numeric_host";
  }

  if (/^[0-9.]+$/.test(value) && /\d/.test(value)) {
    return value.split(".").length === 4
      ? "invalid_ipv4"
      : "ambiguous_numeric_host";
  }

  const components = value.split(".");
  if (
    components.length > 1 &&
    components.every((component) => {
      const candidate = component.trim();
      return (
        /^[+-]?\d+$/.test(candidate) ||
        /^[+-]?0x[0-9a-f]+$/i.test(candidate)
      );
    })
  ) {
    return "invalid_ipv4";
  }

  if (/^[+-]\d/.test(value)) {
    return "invalid_ipv4";
  }

  return null;
}

function parseIpv6(value: string): ParsedIpv6 | null {
  if (
    value.length === 0 ||
    value.includes("%") ||
    value.includes(":::")
  ) {
    return null;
  }

  let hexadecimalValue = value;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }

    const ipv4Components = parseStrictIpv4(value.slice(lastColon + 1));
    if (ipv4Components === null) {
      return null;
    }

    const highWord = (ipv4Components[0] ?? 0) * 256 + (ipv4Components[1] ?? 0);
    const lowWord = (ipv4Components[2] ?? 0) * 256 + (ipv4Components[3] ?? 0);
    hexadecimalValue = `${value.slice(0, lastColon)}:${highWord.toString(16)}:${lowWord.toString(16)}`;
  }

  if (!/^[0-9a-f:]+$/i.test(hexadecimalValue)) {
    return null;
  }

  const compressionParts = hexadecimalValue.split("::");
  if (compressionParts.length > 2) {
    return null;
  }

  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) {
      return [];
    }

    const groups = side.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
      return null;
    }

    return groups.map((group) => Number.parseInt(group, 16));
  };

  const left = parseSide(compressionParts[0] ?? "");
  const right = parseSide(compressionParts[1] ?? "");
  if (left === null || right === null) {
    return null;
  }

  let words: number[];
  if (compressionParts.length === 1) {
    if (left.length !== 8) {
      return null;
    }
    words = left;
  } else {
    const omittedCount = 8 - left.length - right.length;
    if (omittedCount < 1) {
      return null;
    }
    words = [...left, ...Array<number>(omittedCount).fill(0), ...right];
  }

  const mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const mappedIpv4 = mapped
    ? serializeIpv4([
        (words[6] ?? 0) >>> 8,
        (words[6] ?? 0) & 0xff,
        (words[7] ?? 0) >>> 8,
        (words[7] ?? 0) & 0xff,
      ])
    : null;

  return { words, address: serializeIpv6(words), mappedIpv4 };
}

function serializeIpv6(words: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;

  for (let index = 0; index < words.length; ) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < words.length && words[index] === 0) {
      index += 1;
    }

    const length = index - start;
    if (length >= 2 && length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }

  if (bestStart === -1) {
    return words.map((word) => word.toString(16)).join(":");
  }

  const left = words
    .slice(0, bestStart)
    .map((word) => word.toString(16))
    .join(":");
  const right = words
    .slice(bestStart + bestLength)
    .map((word) => word.toString(16))
    .join(":");

  return `${left}::${right}`;
}

function validateZone(zone: string): TargetNormalizationFailure | null {
  if (
    zone.length === 0 ||
    zone.length > MAXIMUM_ZONE_LENGTH ||
    !ZONE_PATTERN.test(zone)
  ) {
    return failure("invalid_zone");
  }

  return null;
}

function isLinkLocal(words: readonly number[]): boolean {
  return ((words[0] ?? 0) & 0xffc0) === 0xfe80;
}

function normalizeIpv6Target(value: string): TargetNormalizationResult {
  const zoneDelimiter = value.indexOf("%");
  const addressInput =
    zoneDelimiter === -1 ? value : value.slice(0, zoneDelimiter);
  const zone = zoneDelimiter === -1 ? null : value.slice(zoneDelimiter + 1);

  if (zoneDelimiter !== -1 && value.indexOf("%", zoneDelimiter + 1) !== -1) {
    return failure("invalid_zone");
  }

  const parsed = parseIpv6(addressInput);
  if (parsed === null) {
    return failure("invalid_ipv6");
  }

  if (zone !== null) {
    const zoneError = validateZone(zone);
    if (zoneError !== null) {
      return zoneError;
    }
    if (!isLinkLocal(parsed.words)) {
      return failure("zone_requires_link_local");
    }
  }

  if (parsed.mappedIpv4 !== null) {
    return success({
      normalizationProfile: TARGET_NORMALIZATION_PROFILE,
      kind: "ip",
      family: 4,
      address: parsed.mappedIpv4,
      zone: null,
    });
  }

  return success({
    normalizationProfile: TARGET_NORMALIZATION_PROFILE,
    kind: "ip",
    family: 6,
    address: parsed.address,
    zone,
  });
}

function normalizeHostname(
  value: string,
): NormalizedHostname | TargetNormalizationFailure {
  if (value.includes("*")) {
    return failure("wildcard_unsupported");
  }
  if (value === ".") {
    return failure("invalid_hostname");
  }

  const withoutFinalDot = value.endsWith(".") ? value.slice(0, -1) : value;
  if (withoutFinalDot.length === 0) {
    return failure("invalid_hostname");
  }
  if (withoutFinalDot.includes("_") || withoutFinalDot.includes("..")) {
    return failure("invalid_hostname_label");
  }

  let ascii: string | null;
  try {
    ascii = toASCII(withoutFinalDot, {
      checkBidi: true,
      checkHyphens: true,
      checkJoiners: true,
      ignoreInvalidPunycode: false,
      transitionalProcessing: false,
      useSTD3ASCIIRules: true,
      verifyDNSLength: false,
    });
  } catch {
    return failure("invalid_hostname");
  }

  if (ascii === null || ascii.length === 0) {
    return failure("invalid_hostname");
  }

  const hostname = ascii.toLowerCase();
  if (parseStrictIpv4(hostname) !== null) {
    return failure("ambiguous_numeric_host");
  }
  const mappedNumericError = numericHostError(hostname);
  if (mappedNumericError !== null) {
    return failure(mappedNumericError);
  }

  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return failure("invalid_hostname_label");
  }
  if (labels.some((label) => label.length > 63)) {
    return failure("hostname_label_too_long");
  }
  if (hostname.length > 253) {
    return failure("hostname_too_long");
  }

  return { ok: true, hostname };
}

function normalizeNonIpv6Host(
  value: string,
): NormalizedNonIpv6Host | TargetNormalizationFailure {
  const ipv4 = parseStrictIpv4(value);
  if (ipv4 !== null) {
    return { ok: true, family: 4, address: serializeIpv4(ipv4) };
  }

  const numericError = numericHostError(value);
  if (numericError !== null) {
    return failure(numericError);
  }

  return normalizeHostname(value);
}

function normalizeCidr(value: string): TargetNormalizationResult {
  const slash = value.indexOf("/");
  if (
    slash <= 0 ||
    slash !== value.lastIndexOf("/") ||
    slash === value.length - 1
  ) {
    return failure("invalid_cidr");
  }

  const addressInput = value.slice(0, slash);
  const prefixInput = value.slice(slash + 1);
  if (!/^\d+$/.test(prefixInput) || addressInput.includes("%")) {
    return failure("invalid_cidr");
  }

  const prefixLength = Number(prefixInput);
  const ipv4 = parseStrictIpv4(addressInput);
  if (ipv4 !== null) {
    if (prefixLength > 32) {
      return failure("invalid_cidr");
    }

    const addressNumber =
      (((ipv4[0] ?? 0) << 24) >>> 0) +
      ((ipv4[1] ?? 0) << 16) +
      ((ipv4[2] ?? 0) << 8) +
      (ipv4[3] ?? 0);
    const mask =
      prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    const networkNumber = (addressNumber & mask) >>> 0;
    const network = serializeIpv4([
      networkNumber >>> 24,
      (networkNumber >>> 16) & 0xff,
      (networkNumber >>> 8) & 0xff,
      networkNumber & 0xff,
    ]);

    return success({
      normalizationProfile: TARGET_NORMALIZATION_PROFILE,
      kind: "cidr",
      family: 4,
      network,
      prefixLength,
      hostBitsMasked: networkNumber !== addressNumber,
    });
  }

  const ipv6 = parseIpv6(addressInput);
  if (ipv6 === null || prefixLength > 128) {
    return failure("invalid_cidr");
  }
  if (ipv6.mappedIpv4 !== null) {
    return failure("mapped_ipv6_cidr_unsupported");
  }

  let remainingPrefixBits = prefixLength;
  const networkWords = ipv6.words.map((word) => {
    const wordPrefixBits = Math.min(16, remainingPrefixBits);
    remainingPrefixBits -= wordPrefixBits;
    const mask =
      wordPrefixBits === 0 ? 0 : (0xffff << (16 - wordPrefixBits)) & 0xffff;
    return word & mask;
  });
  const network = serializeIpv6(networkWords);

  return success({
    normalizationProfile: TARGET_NORMALIZATION_PROFILE,
    kind: "cidr",
    family: 6,
    network,
    prefixLength,
    hostBitsMasked: networkWords.some(
      (word, index) => word !== ipv6.words[index],
    ),
  });
}

function splitUrlAuthority(value: string):
  | {
      scheme: "http" | "https";
      authority: string;
      suffix: string;
    }
  | null {
  const match = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i.exec(value);
  if (match === null) {
    return null;
  }

  const rawScheme = match[1]?.toLowerCase();
  const authority = match[2];
  const suffix = match[3];
  if (
    (rawScheme !== "http" && rawScheme !== "https") ||
    authority === undefined ||
    authority.length === 0 ||
    suffix === undefined
  ) {
    return null;
  }

  return { scheme: rawScheme, authority, suffix };
}

function normalizeUrl(value: string): TargetNormalizationResult {
  if (value.includes("#")) {
    return failure("url_fragment_unsupported");
  }

  const parts = splitUrlAuthority(value);
  if (parts === null) {
    return failure("invalid_url");
  }
  if (parts.authority.includes("@")) {
    return failure("url_userinfo_unsupported");
  }

  let hostForParser: string;
  let canonicalHostText: string;
  let canonicalHost: CanonicalUrlHost;
  let portInput: string | null = null;

  if (parts.authority.startsWith("[")) {
    const closingBracket = parts.authority.indexOf("]");
    if (closingBracket === -1) {
      return failure("invalid_url");
    }

    const remainder = parts.authority.slice(closingBracket + 1);
    if (remainder.length > 0) {
      if (!remainder.startsWith(":")) {
        return failure("invalid_url");
      }
      portInput = remainder.slice(1);
    }

    const bracketContent = parts.authority.slice(1, closingBracket);
    const percentIndex = bracketContent.indexOf("%");
    let addressInput = bracketContent;
    let zone: string | null = null;

    if (percentIndex !== -1) {
      const marker = bracketContent.slice(percentIndex, percentIndex + 3);
      if (
        marker.toLowerCase() !== "%25" ||
        bracketContent.indexOf("%", percentIndex + 1) !== -1
      ) {
        return failure("invalid_zone_encoding");
      }
      addressInput = bracketContent.slice(0, percentIndex);
      zone = bracketContent.slice(percentIndex + 3);
      const zoneError = validateZone(zone);
      if (zoneError !== null) {
        return zoneError;
      }
    }

    const ipv6 = parseIpv6(addressInput);
    if (ipv6 === null) {
      return failure("invalid_url");
    }
    if (zone !== null && !isLinkLocal(ipv6.words)) {
      return failure("zone_requires_link_local");
    }
    if (ipv6.mappedIpv4 !== null) {
      hostForParser = ipv6.mappedIpv4;
      canonicalHostText = ipv6.mappedIpv4;
      canonicalHost = { address: ipv6.mappedIpv4, zone: null };
    } else {
      hostForParser = `[${ipv6.address}]`;
      canonicalHostText = `[${ipv6.address}${zone === null ? "" : `%25${zone}`}]`;
      canonicalHost = { address: ipv6.address, zone };
    }
  } else {
    if (parts.authority.includes("[") || parts.authority.includes("]")) {
      return failure("invalid_url");
    }

    const colon = parts.authority.lastIndexOf(":");
    let encodedHost = parts.authority;
    if (colon !== -1) {
      if (parts.authority.indexOf(":") !== colon) {
        return failure("invalid_url");
      }
      encodedHost = parts.authority.slice(0, colon);
      portInput = parts.authority.slice(colon + 1);
    }
    if (encodedHost.length === 0) {
      return failure("invalid_url");
    }

    let decodedHost: string;
    try {
      decodedHost = decodeURIComponent(encodedHost);
    } catch {
      return failure("invalid_url");
    }

    const normalizedHost = normalizeNonIpv6Host(decodedHost);
    if (!normalizedHost.ok) {
      return normalizedHost;
    }

    if ("hostname" in normalizedHost) {
      hostForParser = normalizedHost.hostname;
      canonicalHostText = normalizedHost.hostname;
      canonicalHost = { hostname: normalizedHost.hostname };
    } else {
      hostForParser = normalizedHost.address;
      canonicalHostText = normalizedHost.address;
      canonicalHost = { address: normalizedHost.address, zone: null };
    }
  }

  let explicitPort: number | null = null;
  if (portInput !== null) {
    if (!/^\d+$/.test(portInput)) {
      return failure("invalid_url");
    }
    explicitPort = Number(portInput);
    if (explicitPort < 1 || explicitPort > 65_535) {
      return failure("invalid_url");
    }
  }

  const defaultPort = parts.scheme === "http" ? 80 : 443;
  const effectivePort = explicitPort ?? defaultPort;
  const parserPort = portInput === null ? "" : `:${portInput}`;

  let parsed: URL;
  try {
    parsed = new URL(
      `${parts.scheme}://${hostForParser}${parserPort}${parts.suffix}`,
    );
  } catch {
    return failure("invalid_url");
  }

  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    return failure("invalid_url");
  }

  const serializedParserHost =
    hostForParser.startsWith("[") && hostForParser.endsWith("]")
      ? hostForParser
      : parsed.hostname;
  const canonicalUrl = parsed.href.replace(
    serializedParserHost,
    canonicalHostText,
  );
  const serializedQuery =
    parsed.search.length > 0 ? parsed.search : parsed.href.endsWith("?") ? "?" : "";

  return success({
    normalizationProfile: TARGET_NORMALIZATION_PROFILE,
    kind: "url",
    url: canonicalUrl,
    origin: `${parts.scheme}://${canonicalHostText}:${effectivePort}`,
    host: canonicalHost,
    effectivePort,
    pathAndQuery: `${parsed.pathname}${serializedQuery}`,
  });
}

function normalizeTargetInternal(input: string): TargetNormalizationResult {
  if (new TextEncoder().encode(input).byteLength > MAXIMUM_TARGET_UTF8_BYTES) {
    return failure("target_too_long");
  }

  const value = input.replace(ASCII_SURROUNDING_WHITESPACE, "");
  if (value.length === 0) {
    return failure("empty_target");
  }
  if (CONTROL_BYTE.test(value)) {
    return failure("control_byte");
  }

  if (/^https?:/i.test(value)) {
    return normalizeUrl(value);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return failure("unsupported_url_scheme");
  }
  if (value.includes("/")) {
    return normalizeCidr(value);
  }
  if (value.includes(":") || value.includes("%")) {
    return normalizeIpv6Target(value);
  }

  const normalizedHost = normalizeNonIpv6Host(value);
  if (!normalizedHost.ok) {
    return normalizedHost;
  }
  if ("hostname" in normalizedHost) {
    return success({
      normalizationProfile: TARGET_NORMALIZATION_PROFILE,
      kind: "hostname",
      hostname: normalizedHost.hostname,
    });
  }

  return success({
    normalizationProfile: TARGET_NORMALIZATION_PROFILE,
    kind: "ip",
    family: 4,
    address: normalizedHost.address,
    zone: null,
  });
}

export function normalizeTarget(input: string): TargetNormalizationResult {
  try {
    if (typeof input !== "string") {
      return failure("invalid_hostname");
    }
    return normalizeTargetInternal(input);
  } catch {
    return failure("invalid_hostname");
  }
}
