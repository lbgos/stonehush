import { describe, expect, it } from "vitest";

import {
  buildCopyText,
  COPIED_NOT_RAN_NOTE,
  copyResolvedText,
  resolveRecipeCopy,
} from "./target-context-recipes.js";

const SNAPSHOT = {
  address: "10.0.0.9",
  hostname: "app.internal",
  origin: "https://app.internal:443",
  accountRef: "op-account",
  connectionRef: "lab-vpn",
  command: "nmap -sV 10.0.0.9",
};

describe("stone target context recipes", () => {
  it("resolves recipe commands against inspectable values", () => {
    const resolved = resolveRecipeCopy(
      {
        commandTemplate: "nmap -sV {address}",
        requiredInputs: ["address"],
      },
      SNAPSHOT,
    );
    expect(resolved).toEqual({ ok: true, text: "nmap -sV 10.0.0.9" });
  });

  it("reports missing inputs before copying", () => {
    const resolved = resolveRecipeCopy(
      {
        commandTemplate: "ffuf -u {origin}/FUZZ",
        requiredInputs: ["origin"],
      },
      { ...SNAPSHOT, origin: null },
    );
    expect(resolved).toEqual({ ok: false, missing: ["origin"] });
  });

  it("distinguishes address, hostname, URL, and command copies", () => {
    expect(buildCopyText("address", SNAPSHOT)).toEqual({ ok: true, text: "10.0.0.9" });
    expect(buildCopyText("hostname", SNAPSHOT)).toEqual({
      ok: true,
      text: "app.internal",
    });
    expect(buildCopyText("url", SNAPSHOT)).toEqual({
      ok: true,
      text: "https://app.internal:443",
    });
    expect(buildCopyText("command", SNAPSHOT)).toEqual({
      ok: true,
      text: "nmap -sV 10.0.0.9",
    });
  });

  it("refuses to invent a URL scheme when no origin is stored", () => {
    expect(buildCopyText("url", { ...SNAPSHOT, origin: null })).toEqual({
      ok: false,
      missing: ["origin"],
    });
  });

  it("marks copies as not run", async () => {
    expect(COPIED_NOT_RAN_NOTE).toBe("Copied, not run.");
    const written: string[] = [];
    await copyResolvedText("10.0.0.9", async (value) => {
      written.push(value);
    });
    expect(written).toEqual(["10.0.0.9"]);
  });
});
