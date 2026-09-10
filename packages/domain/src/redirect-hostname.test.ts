import { describe, expect, it } from "vitest";

import {
  decideRedirectHostnameAssociation,
  findHostsFileEdits,
  proposeRedirectHostnameAssociation,
  REDIRECT_MAPPING_NEXT_STEP,
  REDIRECT_RUNNER_ONLY_NOTE,
} from "./redirect-hostname.js";

describe("redirect hostname association", () => {
  it("offers association with connection address and requested host shown", () => {
    const result = proposeRedirectHostnameAssociation({
      associationId: "assoc-1",
      targetId: "target-1",
      engagementId: "eng-1",
      connectionAddress: "10.0.0.5",
      requestedHostname: "app.internal",
      createdAt: "2026-08-12T12:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.connectionAddress).toBe("10.0.0.5");
    expect(result.offer.requestedHostname).toBe("app.internal");
    expect(result.offer.httpHost).toBe("app.internal");
    expect(result.offer.tlsServerName).toBe("app.internal");
    expect(result.offer.runnerOnlyNote).toBe(REDIRECT_RUNNER_ONLY_NOTE);
    expect(result.offer.nextStep).toBe(REDIRECT_MAPPING_NEXT_STEP);
    expect(result.offer.hostsFileEdited).toBe(false);
  });

  it("decides association without editing the hosts file", () => {
    expect(decideRedirectHostnameAssociation("associated", "2026-08-12T12:01:00.000Z")).toEqual({
      ok: true,
      status: "associated",
      decidedAt: "2026-08-12T12:01:00.000Z",
    });
    expect(decideRedirectHostnameAssociation("bogus", "2026-08-12T12:01:00.000Z").ok).toBe(
      false,
    );
  });

  it("detects any silent hosts file edit plan", () => {
    expect(
      findHostsFileEdits([
        { description: "Run nmap against the target" },
        { description: "Silently edit /etc/hosts to add the hostname" },
      ]),
    ).toEqual(["Silently edit /etc/hosts to add the hostname"]);
    expect(findHostsFileEdits([{ description: "Propose hostname association" }])).toEqual(
      [],
    );
  });
});
