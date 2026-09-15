import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkD1Fixtures,
  checkD2Fixtures,
  checkD3Fixtures,
  checkDocumentation,
  localMarkdownTargets,
} from "./check-docs.mjs";

const fixtureKinds = new Map([
  ["normalization.json", "normalization"],
  ["scope-comparison.json", "scope-comparison"],
  ["resolution-snapshot.json", "resolution-snapshot"],
  ["warning-flow.json", "warning-flow"],
  ["snapshot-canonicalization.json", "snapshot-canonicalization"],
]);
const d2FixtureKinds = new Map([
  ["canonical-request.json", "canonical-request"],
  ["state-machine.json", "state-machine"],
  ["idempotency-concurrency.json", "idempotency-concurrency"],
  ["runner-identity.json", "runner-identity"],
  ["lease-events.json", "lease-events"],
  ["process-supervision.json", "process-supervision"],
]);
const d3FixtureKinds = new Map([
  ["publication.json", "publication"],
  ["limits.json", "limits"],
  ["path-defenses.json", "path-defenses"],
  ["recovery.json", "recovery"],
  ["privacy-download.json", "privacy-download"],
  ["doctor.json", "doctor"],
  ["backup.json", "backup"],
]);
const requiredMalformedTargetCases = [
  {
    id: "d1.normalization.invalid-url-unclosed-ipv6-host",
    given: { input: "https://[2001:db8::1" },
    error: { code: "invalid_url" },
  },
  {
    id: "d1.normalization.invalid-url-port-out-of-range",
    given: { input: "https://example.test:65536/" },
    error: { code: "invalid_url" },
  },
  {
    id: "d1.normalization.invalid-ipv6-triple-colon",
    given: { input: "2001:db8:::1" },
    error: { code: "invalid_ipv6" },
  },
  {
    id: "d1.normalization.invalid-ipv4-cidr-prefix",
    given: { input: "192.0.2.1/33" },
    error: { code: "invalid_cidr" },
  },
  {
    id: "d1.normalization.invalid-ipv6-cidr-prefix",
    given: { input: "2001:db8::1/129" },
    error: { code: "invalid_cidr" },
  },
];
const requiredPositiveTargetCases = [
  {
    id: "d1.normalization.url-zone-leading-25-preserved",
    given: { input: "https://[fe80::7%2525Eth0]/" },
    expected: {
      canonicalTarget: {
        normalizationProfile: "d1-v1",
        kind: "url",
        url: "https://[fe80::7%2525Eth0]/",
        origin: "https://[fe80::7%2525Eth0]:443",
        host: { address: "fe80::7", zone: "25Eth0" },
        effectivePort: 443,
        pathAndQuery: "/",
      },
    },
  },
];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function copyD2FixtureSuite(root) {
  const fixtureDirectory = path.join(root, "docs", "architecture", "fixtures", "d2");
  await mkdir(path.dirname(fixtureDirectory), { recursive: true });
  await cp(
    path.join(repositoryRoot, "docs", "architecture", "fixtures", "d2"),
    fixtureDirectory,
    { recursive: true },
  );
  return fixtureDirectory;
}

async function copyD3FixtureSuite(root) {
  const fixtureDirectory = path.join(root, "docs", "architecture", "fixtures", "d3");
  await mkdir(path.dirname(fixtureDirectory), { recursive: true });
  await cp(
    path.join(repositoryRoot, "docs", "architecture", "fixtures", "d3"),
    fixtureDirectory,
    { recursive: true },
  );
  return fixtureDirectory;
}

function materializeInputTemplate(template) {
  if (Array.isArray(template.labels)) {
    return template.labels
      .map((label) =>
        typeof label === "string" ? label : label.repeat.repeat(label.count),
      )
      .join(template.separator);
  }
  return `${template.prefix ?? ""}${template.repeat.repeat(template.count)}${template.suffix ?? ""}`;
}

async function writeFixtureSuite(root) {
  const fixtureDirectory = path.join(root, "docs", "architecture", "fixtures", "d1");
  await mkdir(fixtureDirectory, { recursive: true });

  let caseNumber = 0;
  for (const [fileName, kind] of fixtureKinds) {
    if (kind === "snapshot-canonicalization") {
      await cp(
        path.join(
          repositoryRoot,
          "docs",
          "architecture",
          "fixtures",
          "d1",
          "snapshot-canonicalization.json",
        ),
        path.join(fixtureDirectory, fileName),
      );
      continue;
    }
    caseNumber += 1;
    await writeFile(
      path.join(fixtureDirectory, fileName),
      `${JSON.stringify(
        {
          fixtureVersion: 1,
          normalizationProfile: "d1-v1",
          kind,
          cases: [
            {
              id: `d1.test.case-${caseNumber}`,
              description: "Synthetic reserved fixture case.",
              given: { target: `target-${caseNumber}.test`, address: `192.0.2.${caseNumber}` },
              expected: { accepted: true },
            },
            ...(kind === "normalization"
              ? [
                  ...requiredMalformedTargetCases.map((fixtureCase) => ({
                    ...fixtureCase,
                    description: "Required synthetic malformed target case.",
                  })),
                  ...requiredPositiveTargetCases.map((fixtureCase) => ({
                    ...fixtureCase,
                    description: "Required synthetic positive target case.",
                  })),
                ]
              : []),
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return fixtureDirectory;
}

test("extracts only local Markdown targets", () => {
  assert.deepEqual(
    localMarkdownTargets(
      "[local](./guide.md) [section](#one) [web](https://example.test) [mail](mailto:test@example.test)",
    ),
    ["./guide.md"],
  );
});

test("reports missing local links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  await writeFile(path.join(root, "README.md"), "[missing](./missing.md)\n", "utf8");

  assert.deepEqual(await checkDocumentation(root), [
    "README.md: missing local link target ./missing.md",
  ]);
});

test("accepts links to existing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "README.md"), "[guide](./docs/guide.md)\n", "utf8");
  await writeFile(path.join(root, "docs/guide.md"), "# Guide\n", "utf8");

  assert.deepEqual(await checkDocumentation(root), []);
});

test("reports review metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  await writeFile(path.join(root, "README.md"), "Reference studied: example\n", "utf8");

  const errors = await checkDocumentation(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /review\/source metadata/);
});

test("accepts a complete reserved D1 fixture suite through the documentation check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  await writeFixtureSuite(root);

  assert.deepEqual(await checkD1Fixtures(root), []);
  assert.deepEqual(await checkDocumentation(root), []);
});

test("requires the D1 fixture suite when the accepted ADR marker exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const architectureDirectory = path.join(root, "docs", "architecture");
  await mkdir(architectureDirectory, { recursive: true });
  await writeFile(
    path.join(architectureDirectory, "0001-target-normalization-scope-warnings.md"),
    "# ADR-0001\n\nStatus: accepted\n",
    "utf8",
  );

  assert.deepEqual(await checkDocumentation(root), [
    "docs/architecture/fixtures/d1: missing D1 fixture directory",
  ]);
});

test("reports fixture version, shape, and duplicate case IDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const scopePath = path.join(fixtureDirectory, "scope-comparison.json");
  const scopeFixture = JSON.parse(await readFile(scopePath, "utf8"));
  scopeFixture.fixtureVersion = 2;
  scopeFixture.cases[0].id = "d1.test.case-1";
  delete scopeFixture.cases[0].expected;
  await writeFile(scopePath, `${JSON.stringify(scopeFixture, null, 2)}\n`, "utf8");

  const errors = await checkD1Fixtures(root);
  assert.ok(errors.some((error) => error.includes("fixtureVersion must be 1")));
  assert.ok(errors.some((error) => error.includes("duplicates d1.test.case-1")));
  assert.ok(errors.some((error) => error.includes("exactly one of expected or error")));
});

test("requires exact malformed target vectors and error codes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const normalizationPath = path.join(fixtureDirectory, "normalization.json");
  const validFixture = JSON.parse(await readFile(normalizationPath, "utf8"));

  for (const requiredCase of requiredMalformedTargetCases) {
    const missingFixture = structuredClone(validFixture);
    missingFixture.cases = missingFixture.cases.filter(
      (fixtureCase) => fixtureCase.id !== requiredCase.id,
    );
    await writeFile(normalizationPath, `${JSON.stringify(missingFixture, null, 2)}\n`, "utf8");
    let errors = await checkD1Fixtures(root);
    assert.ok(
      errors.some((error) =>
        error.includes(`missing required malformed target case ${requiredCase.id}`),
      ),
    );

    const changedInputFixture = structuredClone(validFixture);
    changedInputFixture.cases.find(
      (fixtureCase) => fixtureCase.id === requiredCase.id,
    ).given.input = `${requiredCase.given.input} `;
    await writeFile(
      normalizationPath,
      `${JSON.stringify(changedInputFixture, null, 2)}\n`,
      "utf8",
    );
    errors = await checkD1Fixtures(root);
    assert.ok(
      errors.some((error) => error.includes(`${requiredCase.id}.given.input must be`)),
    );

    const changedCodeFixture = structuredClone(validFixture);
    changedCodeFixture.cases.find(
      (fixtureCase) => fixtureCase.id === requiredCase.id,
    ).error.code = "invalid_target";
    await writeFile(
      normalizationPath,
      `${JSON.stringify(changedCodeFixture, null, 2)}\n`,
      "utf8",
    );
    errors = await checkD1Fixtures(root);
    assert.ok(
      errors.some((error) =>
        error.includes(`${requiredCase.id}.error.code must be ${requiredCase.error.code}`),
      ),
    );
  }
});

test("requires the exact positive zone-leading-25 target vector", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const normalizationPath = path.join(fixtureDirectory, "normalization.json");
  const validFixture = JSON.parse(await readFile(normalizationPath, "utf8"));
  const requiredCase = requiredPositiveTargetCases[0];

  const missingFixture = structuredClone(validFixture);
  missingFixture.cases = missingFixture.cases.filter(
    (fixtureCase) => fixtureCase.id !== requiredCase.id,
  );
  await writeFile(normalizationPath, `${JSON.stringify(missingFixture, null, 2)}\n`, "utf8");
  let errors = await checkD1Fixtures(root);
  assert.ok(
    errors.some((error) =>
      error.includes(`missing required positive target case ${requiredCase.id}`),
    ),
  );

  const changedInputFixture = structuredClone(validFixture);
  changedInputFixture.cases.find(
    (fixtureCase) => fixtureCase.id === requiredCase.id,
  ).given.input = "https://[fe80::7%25Eth0]/";
  await writeFile(
    normalizationPath,
    `${JSON.stringify(changedInputFixture, null, 2)}\n`,
    "utf8",
  );
  errors = await checkD1Fixtures(root);
  assert.ok(errors.some((error) => error.includes(`${requiredCase.id}.given.input must be`)));

  const changedOutputFixture = structuredClone(validFixture);
  changedOutputFixture.cases.find(
    (fixtureCase) => fixtureCase.id === requiredCase.id,
  ).expected.canonicalTarget.host.zone = "Eth0";
  await writeFile(
    normalizationPath,
    `${JSON.stringify(changedOutputFixture, null, 2)}\n`,
    "utf8",
  );
  errors = await checkD1Fixtures(root);
  assert.ok(
    errors.some((error) =>
      error.includes(
        `${requiredCase.id}.expected.canonicalTarget must preserve zone 25Eth0`,
      ),
    ),
  );
});

test("pins every action-snapshot-json-v1 critical input and exact outcome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const fixturePath = path.join(fixtureDirectory, "snapshot-canonicalization.json");
  const validFixture = JSON.parse(await readFile(fixturePath, "utf8"));

  for (const [index, fixtureCase] of validFixture.cases.entries()) {
    const mutatedInput = structuredClone(validFixture);
    mutatedInput.cases[index].given.validatorMutation = true;
    await writeFile(fixturePath, `${JSON.stringify(mutatedInput, null, 2)}\n`, "utf8");
    let errors = await checkD1Fixtures(root);
    assert.ok(
      errors.some((error) =>
        error.includes(`${fixtureCase.id} critical given fields or exact outcome changed`),
      ),
      `${fixtureCase.id} input mutation was not rejected`,
    );

    const mutatedOutcome = structuredClone(validFixture);
    mutatedOutcome.cases[index].expected.validatorMutation = true;
    await writeFile(fixturePath, `${JSON.stringify(mutatedOutcome, null, 2)}\n`, "utf8");
    errors = await checkD1Fixtures(root);
    assert.ok(
      errors.some((error) =>
        error.includes(`${fixtureCase.id} critical given fields or exact outcome changed`),
      ),
      `${fixtureCase.id} outcome mutation was not rejected`,
    );
  }

  const extraCase = structuredClone(validFixture);
  extraCase.cases.push({
    id: "d1.snapshot-canonical.unpinned-case",
    description: "Synthetic unpinned case.",
    given: { accepted: true },
    expected: { accepted: true },
  });
  await writeFile(fixturePath, `${JSON.stringify(extraCase, null, 2)}\n`, "utf8");
  const extraErrors = await checkD1Fixtures(root);
  assert.ok(
    extraErrors.some((error) =>
      error.includes("d1.snapshot-canonical.unpinned-case is not a required action-snapshot-json-v1 case"),
    ),
  );
});

test("reports malformed JSON and a missing required fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = path.join(root, "docs", "architecture", "fixtures", "d1");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(path.join(fixtureDirectory, "normalization.json"), "{\n", "utf8");

  const errors = await checkD1Fixtures(root);
  assert.ok(errors.some((error) => error.includes("normalization.json: invalid JSON")));
  assert.ok(errors.some((error) => error.includes("warning-flow.json: missing required")));
});

test("reports secret-bearing fields and non-reserved target content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const warningPath = path.join(fixtureDirectory, "warning-flow.json");
  const warningFixture = JSON.parse(await readFile(warningPath, "utf8"));
  warningFixture.cases[0].given.password = "synthetic-fixture-value";
  warningFixture.cases[0].given.client_secret = "synthetic-fixture-value";
  warningFixture.cases[0].given.runner_token = "synthetic-fixture-value";
  warningFixture.cases[0].given.githubToken = "synthetic-fixture-value";
  warningFixture.cases[0].given.target = "host.example.org";
  warningFixture.cases[0].given.address = "ff02::1";
  warningFixture.cases[0].given.note = ["gh", "p_", "a".repeat(36)].join("");
  warningFixture.cases[0].given.metadata = ["github", "_pat_", "b".repeat(24)].join("");
  warningFixture.cases[0].given.message = ["xo", "xb-", "1".repeat(12), "-", "c".repeat(24)].join(
    "",
  );
  await writeFile(warningPath, `${JSON.stringify(warningFixture, null, 2)}\n`, "utf8");

  const errors = await checkD1Fixtures(root);
  assert.ok(errors.some((error) => error.includes("forbidden secret-bearing field password")));
  assert.ok(errors.some((error) => error.includes("forbidden secret-bearing field client_secret")));
  assert.ok(errors.some((error) => error.includes("forbidden secret-bearing field runner_token")));
  assert.ok(errors.some((error) => error.includes("forbidden secret-bearing field githubToken")));
  assert.ok(errors.some((error) => error.includes("non-reserved hostname host.example.org")));
  assert.ok(errors.some((error) => error.includes("non-documentation IPv6 address ff02::1")));
  assert.equal(errors.filter((error) => error.includes("secret-like content")).length, 3);
});

test("allows only the synthetic lab convention in target-bearing fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const normalizationPath = path.join(fixtureDirectory, "normalization.json");
  const normalizationFixture = JSON.parse(await readFile(normalizationPath, "utf8"));
  normalizationFixture.cases[0].given.target = "internal-db";
  await writeFile(
    normalizationPath,
    `${JSON.stringify(normalizationFixture, null, 2)}\n`,
    "utf8",
  );

  let errors = await checkD1Fixtures(root);
  assert.ok(
    errors.some((error) => error.includes("non-synthetic single-label hostname internal-db")),
  );

  normalizationFixture.cases[0].given.target = "TARGET-LAB";
  await writeFile(
    normalizationPath,
    `${JSON.stringify(normalizationFixture, null, 2)}\n`,
    "utf8",
  );
  errors = await checkD1Fixtures(root);
  assert.deepEqual(errors, []);
});

test("reports encoded mapped IPv6 and Unicode live targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await writeFixtureSuite(root);
  const normalizationPath = path.join(fixtureDirectory, "normalization.json");
  const normalizationFixture = JSON.parse(await readFile(normalizationPath, "utf8"));
  normalizationFixture.cases[0].given.input = [
    "https://[::ffff:",
    "0808:0808",
    "]/",
  ].join("");
  normalizationFixture.cases[0].given.target = ["https://faß", ".de/"].join("");
  await writeFile(
    normalizationPath,
    `${JSON.stringify(normalizationFixture, null, 2)}\n`,
    "utf8",
  );

  const errors = await checkD1Fixtures(root);
  assert.ok(
    errors.some((error) =>
      error.includes("non-documentation IPv6 address ::ffff:0808:0808"),
    ),
  );
  assert.ok(errors.some((error) => error.includes("non-reserved hostname xn--fa-hia.de")));
});

test("encodes exact D1 accepted and just-over boundary vectors", async () => {
  const fixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d1");
  const normalizationFixture = JSON.parse(
    await readFile(path.join(fixtureDirectory, "normalization.json"), "utf8"),
  );
  const normalizationCases = new Map(
    normalizationFixture.cases.map((fixtureCase) => [fixtureCase.id, fixtureCase]),
  );

  const input4096 = materializeInputTemplate(
    normalizationCases.get("d1.normalization.utf8-4096-byte-input-accepted").given
      .inputTemplate,
  );
  const input4097 = materializeInputTemplate(
    normalizationCases.get("d1.normalization.utf8-4097-byte-input-rejected").given
      .inputTemplate,
  );
  assert.equal(Buffer.byteLength(input4096, "utf8"), 4096);
  assert.equal(Buffer.byteLength(input4097, "utf8"), 4097);

  const label63 = materializeInputTemplate(
    normalizationCases.get("d1.normalization.hostname-label-63-bytes-accepted").given
      .inputTemplate,
  );
  const label64 = materializeInputTemplate(
    normalizationCases.get("d1.normalization.hostname-label-64-bytes-rejected").given
      .inputTemplate,
  );
  assert.equal(Buffer.byteLength(label63.split(".")[0], "utf8"), 63);
  assert.equal(Buffer.byteLength(label64.split(".")[0], "utf8"), 64);

  const hostname253 = materializeInputTemplate(
    normalizationCases.get("d1.normalization.hostname-253-bytes-accepted").given.inputTemplate,
  );
  const hostname254 = materializeInputTemplate(
    normalizationCases.get("d1.normalization.hostname-254-bytes-rejected").given.inputTemplate,
  );
  assert.equal(Buffer.byteLength(hostname253, "utf8"), 253);
  assert.equal(Buffer.byteLength(hostname254, "utf8"), 254);

  const zone15 = normalizationCases
    .get("d1.normalization.zone-maximum-length-accepted")
    .given.input.split("%", 2)[1];
  const zone16 = normalizationCases
    .get("d1.normalization.zone-too-long-rejected")
    .given.input.split("%", 2)[1];
  assert.equal(zone15.length, 15);
  assert.equal(zone16.length, 16);

  const scopeFixture = JSON.parse(
    await readFile(path.join(fixtureDirectory, "scope-comparison.json"), "utf8"),
  );
  const scopeCases = new Map(scopeFixture.cases.map((fixtureCase) => [fixtureCase.id, fixtureCase]));
  assert.equal(scopeCases.get("d1.scope.port-lower-bound-accepted").given.ranges[0].from, 1);
  assert.equal(scopeCases.get("d1.scope.port-upper-bound-accepted").given.ranges[0].to, 65535);
  assert.equal(scopeCases.get("d1.scope.port-zero-rejected").given.ranges[0].from, 0);
  assert.equal(scopeCases.get("d1.scope.port-65536-rejected").given.ranges[0].to, 65536);
});

test("accepts the complete pinned d2-v1 fixture suite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  await copyD2FixtureSuite(root);

  assert.deepEqual(await checkD2Fixtures(root), []);
  assert.deepEqual(await checkDocumentation(root), []);
});

test("requires the D2 fixture suite when the accepted ADR marker exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const architectureDirectory = path.join(root, "docs", "architecture");
  await mkdir(architectureDirectory, { recursive: true });
  await writeFile(
    path.join(architectureDirectory, "0002-actions-runs-runner-trust.md"),
    "# ADR-0002\n\nStatus: accepted\n",
    "utf8",
  );

  assert.deepEqual(await checkDocumentation(root), [
    "docs/architecture/fixtures/d2: missing D2 fixture directory",
  ]);
});

test("reports D2 version, profile, kind, shape, duplicate IDs, and unexpected cases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD2FixtureSuite(root);
  const statePath = path.join(fixtureDirectory, "state-machine.json");
  const stateFixture = JSON.parse(await readFile(statePath, "utf8"));
  stateFixture.fixtureVersion = 2;
  stateFixture.profile = "d2-v2";
  stateFixture.kind = "other";
  stateFixture.cases[1].id = stateFixture.cases[0].id;
  stateFixture.cases.push({
    id: "d2.state.unpinned-case",
    description: "Synthetic unpinned case.",
    given: { accepted: true },
    expected: { accepted: true },
  });
  await writeFile(statePath, `${JSON.stringify(stateFixture, null, 2)}\n`, "utf8");

  const errors = await checkD2Fixtures(root);
  assert.ok(errors.some((error) => error.includes("fixtureVersion must be 1")));
  assert.ok(errors.some((error) => error.includes("profile must be d2-v1")));
  assert.ok(errors.some((error) => error.includes("kind must be state-machine")));
  assert.ok(errors.some((error) => error.includes("duplicates d2.state.action-transition-matrix")));
  assert.ok(errors.some((error) => error.includes("is not a required d2-v1 case")));
  assert.ok(errors.some((error) => error.includes("missing required D2 case d2.state.run-transition-matrix")));
});

test("pins every D2 case critical input field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD2FixtureSuite(root);

  for (const fileName of d2FixtureKinds.keys()) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const validFixture = JSON.parse(await readFile(fixturePath, "utf8"));
    for (const [index, fixtureCase] of validFixture.cases.entries()) {
      const mutatedFixture = structuredClone(validFixture);
      mutatedFixture.cases[index].given.validatorMutation = true;
      await writeFile(fixturePath, `${JSON.stringify(mutatedFixture, null, 2)}\n`, "utf8");

      const errors = await checkD2Fixtures(root);
      assert.ok(
        errors.some((error) =>
          error.includes(`${fixtureCase.id} critical given fields or exact outcome changed`),
        ),
        `${fixtureCase.id} input mutation was not rejected`,
      );
    }
    await writeFile(fixturePath, `${JSON.stringify(validFixture, null, 2)}\n`, "utf8");
  }
});

test("pins every D2 case exact outcome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD2FixtureSuite(root);

  for (const fileName of d2FixtureKinds.keys()) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const validFixture = JSON.parse(await readFile(fixturePath, "utf8"));
    for (const [index, fixtureCase] of validFixture.cases.entries()) {
      const mutatedFixture = structuredClone(validFixture);
      const outcomeName = Object.hasOwn(fixtureCase, "expected") ? "expected" : "error";
      mutatedFixture.cases[index][outcomeName].validatorMutation = true;
      await writeFile(fixturePath, `${JSON.stringify(mutatedFixture, null, 2)}\n`, "utf8");

      const errors = await checkD2Fixtures(root);
      assert.ok(
        errors.some((error) =>
          error.includes(`${fixtureCase.id} critical given fields or exact outcome changed`),
        ),
        `${fixtureCase.id} outcome mutation was not rejected`,
      );
    }
    await writeFile(fixturePath, `${JSON.stringify(validFixture, null, 2)}\n`, "utf8");
  }
});

test("reports malformed, missing, misplaced, and unexpected D2 fixtures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD2FixtureSuite(root);
  await writeFile(path.join(fixtureDirectory, "state-machine.json"), "{\n", "utf8");
  await writeFile(
    path.join(fixtureDirectory, "unexpected.json"),
    '{"fixtureVersion":1}\n',
    "utf8",
  );

  const errors = await checkD2Fixtures(root);
  assert.ok(errors.some((error) => error.includes("unexpected.json: unexpected D2 fixture file")));
  assert.ok(errors.some((error) => error.includes("state-machine.json: invalid JSON")));
  assert.ok(
    errors.some((error) =>
      error.includes("missing required D2 case d2.state.action-transition-matrix"),
    ),
  );
});

test("accepts the complete pinned d3-v1 fixture suite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  await copyD3FixtureSuite(root);

  assert.deepEqual(await checkD3Fixtures(root), []);
  assert.deepEqual(await checkDocumentation(root), []);
});

test("requires the D3 fixture suite when the accepted ADR marker exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const architectureDirectory = path.join(root, "docs", "architecture");
  await mkdir(architectureDirectory, { recursive: true });
  await writeFile(
    path.join(architectureDirectory, "0003-evidence-publication-recovery.md"),
    "# ADR-0003\n\nStatus: accepted\n",
    "utf8",
  );

  assert.deepEqual(await checkDocumentation(root), [
    "docs/architecture/fixtures/d3: missing D3 fixture directory",
  ]);
});

test("reports D3 version, profile, kind, shape, duplicate IDs, and unexpected cases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD3FixtureSuite(root);
  const publicationPath = path.join(fixtureDirectory, "publication.json");
  const publicationFixture = JSON.parse(await readFile(publicationPath, "utf8"));
  publicationFixture.fixtureVersion = 2;
  publicationFixture.profile = "d3-v2";
  publicationFixture.kind = "other";
  publicationFixture.cases[1].id = publicationFixture.cases[0].id;
  publicationFixture.cases.push({
    id: "d3.publication.unpinned-case",
    description: "Synthetic unpinned case.",
    given: { accepted: true },
    expected: { accepted: true },
  });
  await writeFile(publicationPath, `${JSON.stringify(publicationFixture, null, 2)}\n`, "utf8");

  const errors = await checkD3Fixtures(root);
  assert.ok(errors.some((error) => error.includes("fixtureVersion must be 1")));
  assert.ok(errors.some((error) => error.includes("profile must be d3-v1")));
  assert.ok(errors.some((error) => error.includes("kind must be publication")));
  assert.ok(
    errors.some((error) =>
      error.includes("duplicates d3.publication.grant-authenticated-runner"),
    ),
  );
  assert.ok(errors.some((error) => error.includes("is not a required d3-v1 case")));
  assert.ok(
    errors.some((error) =>
      error.includes("missing required D3 case d3.publication.operator-cannot-upload"),
    ),
  );
});

test("pins every D3 case critical input field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD3FixtureSuite(root);

  for (const fileName of d3FixtureKinds.keys()) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const validFixture = JSON.parse(await readFile(fixturePath, "utf8"));
    for (const [index, fixtureCase] of validFixture.cases.entries()) {
      const mutatedFixture = structuredClone(validFixture);
      mutatedFixture.cases[index].given.validatorMutation = true;
      await writeFile(fixturePath, `${JSON.stringify(mutatedFixture, null, 2)}\n`, "utf8");

      const errors = await checkD3Fixtures(root);
      assert.ok(
        errors.some((error) =>
          error.includes(`${fixtureCase.id} critical given fields or exact outcome changed`),
        ),
        `${fixtureCase.id} input mutation was not rejected`,
      );
    }
    await writeFile(fixturePath, `${JSON.stringify(validFixture, null, 2)}\n`, "utf8");
  }
});

test("pins every D3 case exact outcome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD3FixtureSuite(root);

  for (const fileName of d3FixtureKinds.keys()) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const validFixture = JSON.parse(await readFile(fixturePath, "utf8"));
    for (const [index, fixtureCase] of validFixture.cases.entries()) {
      const mutatedFixture = structuredClone(validFixture);
      const outcomeName = Object.hasOwn(fixtureCase, "expected") ? "expected" : "error";
      mutatedFixture.cases[index][outcomeName].validatorMutation = true;
      await writeFile(fixturePath, `${JSON.stringify(mutatedFixture, null, 2)}\n`, "utf8");

      const errors = await checkD3Fixtures(root);
      assert.ok(
        errors.some((error) =>
          error.includes(`${fixtureCase.id} critical given fields or exact outcome changed`),
        ),
        `${fixtureCase.id} outcome mutation was not rejected`,
      );
    }
    await writeFile(fixturePath, `${JSON.stringify(validFixture, null, 2)}\n`, "utf8");
  }
});

test("reports malformed, missing, misplaced, and unexpected D3 fixtures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-docs-"));
  const fixtureDirectory = await copyD3FixtureSuite(root);
  await writeFile(path.join(fixtureDirectory, "publication.json"), "{\n", "utf8");
  await writeFile(
    path.join(fixtureDirectory, "unexpected.json"),
    '{"fixtureVersion":1}\n',
    "utf8",
  );

  const errors = await checkD3Fixtures(root);
  assert.ok(errors.some((error) => error.includes("unexpected.json: unexpected D3 fixture file")));
  assert.ok(errors.some((error) => error.includes("publication.json: invalid JSON")));
  assert.ok(
    errors.some((error) =>
      error.includes("missing required D3 case d3.publication.grant-authenticated-runner"),
    ),
  );
});
