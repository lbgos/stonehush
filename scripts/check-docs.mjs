import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ignoredDirectories = new Set([".git", "node_modules"]);
const d1FixtureVersion = 1;
const d1NormalizationProfile = "d1-v1";
const d1FixtureFiles = new Map([
  ["normalization.json", "normalization"],
  ["scope-comparison.json", "scope-comparison"],
  ["resolution-snapshot.json", "resolution-snapshot"],
  ["warning-flow.json", "warning-flow"],
  ["snapshot-canonicalization.json", "snapshot-canonicalization"],
]);
const requiredD1SnapshotCanonicalCases = new Map([
  [
    "d1.snapshot-canonical.six-fields-and-nulls",
    [
      "snapshot-canonicalization.json",
      "5287bb7e938e14f607210d2494c74a978bdc0bc89827431596de9e16ab67caad",
    ],
  ],
  [
    "d1.snapshot-canonical.object-and-array-order",
    [
      "snapshot-canonicalization.json",
      "2b9e47850536e08f4c7a1d924e3ecbfbd7bed302a97beab6086831d3258af17f",
    ],
  ],
  [
    "d1.snapshot-canonical.typed-options-null-and-key-order",
    [
      "snapshot-canonicalization.json",
      "5db831ca16a7c0f5858a3375753c5bb1bd9d6e248946438d854c976528641b9f",
    ],
  ],
  [
    "d1.snapshot-canonical.number-spelling",
    [
      "snapshot-canonicalization.json",
      "09d1f8fc6915b4fa676a3f2d1bcb1c491723213fa1df1c121836cbf78bdb667c",
    ],
  ],
  [
    "d1.snapshot-canonical.excludes-identity-and-concrete-destinations",
    [
      "snapshot-canonicalization.json",
      "f6e8dc4dcd4f8bffda7cb2b3257a92982848d53425c4c033ed2c0d5dce13932f",
    ],
  ],
  [
    "d1.snapshot-canonical.active-scope-differs-from-null",
    [
      "snapshot-canonicalization.json",
      "2b1c5f5ba3dc8c7431afd30480ed4f043265ba215afdaf5808f22b84bd4057d9",
    ],
  ],
]);
const requiredD1MalformedTargetCases = [
  {
    id: "d1.normalization.invalid-url-unclosed-ipv6-host",
    input: "https://[2001:db8::1",
    code: "invalid_url",
  },
  {
    id: "d1.normalization.invalid-url-port-out-of-range",
    input: "https://example.test:65536/",
    code: "invalid_url",
  },
  {
    id: "d1.normalization.invalid-ipv6-triple-colon",
    input: "2001:db8:::1",
    code: "invalid_ipv6",
  },
  {
    id: "d1.normalization.invalid-ipv4-cidr-prefix",
    input: "192.0.2.1/33",
    code: "invalid_cidr",
  },
  {
    id: "d1.normalization.invalid-ipv6-cidr-prefix",
    input: "2001:db8::1/129",
    code: "invalid_cidr",
  },
];
const requiredD1PositiveTargetCases = [
  {
    id: "d1.normalization.url-zone-leading-25-preserved",
    input: "https://[fe80::7%2525Eth0]/",
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
];
const d2FixtureVersion = 1;
const d2Profile = "d2-v1";
const d2FixtureFiles = new Map([
  ["canonical-request.json", "canonical-request"],
  ["state-machine.json", "state-machine"],
  ["idempotency-concurrency.json", "idempotency-concurrency"],
  ["runner-identity.json", "runner-identity"],
  ["lease-events.json", "lease-events"],
  ["process-supervision.json", "process-supervision"],
]);
const requiredD2Cases = new Map([
  ["d2.canonical.create-engagement", ["canonical-request.json", "28fa9ee97035657e6679117290161520458af1b91f24e8d71ca5eacebdd4af44"]],
  ["d2.canonical.archive-engagement", ["canonical-request.json", "38b5324f7495c9de34f82b499a7567c4f5beb340103b99548eb6fe45420f8e86"]],
  ["d2.canonical.object-and-array-order", ["canonical-request.json", "2ab97d4924f907aef3e29efa6d0efa2c94d6ece33e08cea0ea7f0071d1774a76"]],
  ["d2.canonical.number-spelling", ["canonical-request.json", "f1891544ed2a410e4c70b28370620273c44aa03b32e2df81dbdff77b1dc614b0"]],
  ["d2.idempotency.same-key-same-request-replays", ["idempotency-concurrency.json", "851169759fdbcd531716e67e44aed20f2e1f45c87a8999208ae4f9ff904ac0c4"]],
  ["d2.idempotency.same-key-different-request-conflicts", ["idempotency-concurrency.json", "0fbe3538d7b19ac4edc6ddf96d5f4cf718549adfba7044309fa192234d0369c6"]],
  ["d2.idempotency.continue-replay", ["idempotency-concurrency.json", "f13dde46d7cd0eac8240819a2582797a94177453d579d6247f8a080f94d85855"]],
  ["d2.idempotency.late-continue-replay", ["idempotency-concurrency.json", "aa049e6aa90e60273843ff461b9d65e49900c61900e6994e43ec18dd311aaa83"]],
  ["d2.idempotency.add-scope-transaction-replay", ["idempotency-concurrency.json", "b23b0638a020718fa41d6fbd2b5202e56613f2901df44aef66db198bd855a65e"]],
  ["d2.idempotency.retry-replay", ["idempotency-concurrency.json", "60a85de5a55fed2286628aa88de1db6b4df02960b3888a452bfc5542f9681f03"]],
  ["d2.idempotency.cancel-replay", ["idempotency-concurrency.json", "b8c7731ef51dba729e59d3ef93672405aa1a072288cf009ecb3d7c13ed8d4308"]],
  ["d2.idempotency.post-terminal-completion-replay", ["idempotency-concurrency.json", "090ccb9f13321890bf458c4e694033ae88d8395619ae538c6ef15096df39429e"]],
  ["d2.idempotency.expired-fence-event-replay", ["idempotency-concurrency.json", "7370de8ead13be2378c926ef0f6f2dfc7a34cc4c9cf31838c25051b7f20b8bc1"]],
  ["d2.idempotency.superseded-fence-event-replay", ["idempotency-concurrency.json", "f65aeec03b8064b5ee531d5f0a0f199ead2aeac335b3d760eb24289f5eddc92a"]],
  ["d2.concurrency.revision-conflict", ["idempotency-concurrency.json", "f04561acd8789aaa4f4fb8b416228616f97f706cc4a8c9f2f001856598ac45ef"]],
  ["d2.concurrency.sqlite-mutation-boundary", ["idempotency-concurrency.json", "0d7bbedd343fcf2cb1dc4d00ee1461b6168e40b3a35db086116ca5e319623dcf"]],
  ["d2.concurrency.sqlite-busy-retry", ["idempotency-concurrency.json", "a7194c46c4995e677683c90dc32577afe19d54a875f7cb55c3d2631563b70b97"]],
  ["d2.idempotency.runner-key-generation-and-outbox", ["idempotency-concurrency.json", "3f9f37ad08263ebcab5ee444edb2244e08fca5aad339caa4ce37b0df1041e692"]],
  ["d2.lease.acquire-once", ["lease-events.json", "94cb26b64502e8a2f2fdd720929c9655e4855a3610fe43c66bbc4b408d410f8f"]],
  ["d2.lease.heartbeat-extends-from-server-time", ["lease-events.json", "6dc4ef2e153a75359c52d0871f1ec0a802f4332e9daf17586a7c8b351492459d"]],
  ["d2.lease.heartbeat-replay", ["lease-events.json", "9b47bd1d3c48d433da172d301b4f7a5a7408c31a2888944d31ba4cc0cf0cb6b6"]],
  ["d2.lease.unstarted-expiry-requeues", ["lease-events.json", "48e1e4454f1315d007c2a79490df3574d6aeb6d30f0ae9f3f48ea95841ec5b94"]],
  ["d2.lease.reassignment-increments-fence", ["lease-events.json", "72cbac4f4387c127a8d486543b14f4e4b829a98cc0f98dbc2b9041132d3afaba"]],
  ["d2.lease.fencing-exhausted-fails-before-lease", ["lease-events.json", "37589084cc6ee1eaa53b5203a305bd3735b04ebeeda99194323a6da0c2230825"]],
  ["d2.lease.running-expiry-fails", ["lease-events.json", "367fee60373f0289e733e00eeb13b7e9f09d120a6d46e1d91b67205a59e5eb9d"]],
  ["d2.lease.control-plane-restart-preserves-lease", ["lease-events.json", "bc7eafb6f8e28550765d30331a0d0e91023c1c7a66bfbeb046b3b14f790d4930"]],
  ["d2.lease.runner-restart-fences-abandoned-work", ["lease-events.json", "ad793f4e947b8a948e74f94c712914d9c31a6f3468a57971e3cb34b21b103ffe"]],
  ["d2.lease.stale-fence-rejected", ["lease-events.json", "fb80ff67f8fe4ea5fa0ff798f04bde10847f95e494669c0f9d229de60286f6a2"]],
  ["d2.lease.expired-append-rejected", ["lease-events.json", "4c81fab3992e2feacddb56b1c4dd9c0d84503e8695fccd01256a39d6dea6d087"]],
  ["d2.lease.owner-mismatch-rejected", ["lease-events.json", "e6a2b0b25eadaa35d31295576256880c4f1d19585c8a027d131fc6c2db1272fa"]],
  ["d2.lease.partitioned-runner-self-fences", ["lease-events.json", "5b43ea99547d00eb3f7af7380dd2ac887335e9a070d6ad52bcfe9187671fbf2f"]],
  ["d2.lease.cancel-requested-expiry-fails", ["lease-events.json", "494ccee293e412a181489429baca6e3045db65a6b611f38d6354e438427c9208"]],
  ["d2.lease.paused-running-expiry-fails", ["lease-events.json", "3257135d0b7abffd1a726fd8792b4c9976dca722eac8dcc79cedf2c9bd841e75"]],
  ["d2.event.stale-late-destination-cannot-pause", ["lease-events.json", "234178468d48f0da2ee8de251be0cd217d4799a18e2efbe9770186ebd291d627"]],
  ["d2.event.identical-sequence-replay", ["lease-events.json", "bba6a0842f17789479910c668feb4a723da9ec17c008abc8cc233740958419cd"]],
  ["d2.event.sequence-body-conflict", ["lease-events.json", "8ef9ddd6c3dc40ee09c34484a594328365378874eccef81d929a367abe896245"]],
  ["d2.event.sequence-gap-rejected", ["lease-events.json", "2bf8ed7e9b91deb9ad4df8bdf52079810519e3ece6f4d42d900a81aba701874d"]],
  ["d2.event.completion-shares-event-sequence", ["lease-events.json", "627d264224fe3d17779e6216eb012977d75cae064673502dd1e47df0a7b51632"]],
  ["d2.event.duplicate-completion-no-duplicates", ["lease-events.json", "447370182c80d27b0712da460ae63f96f17867ba2cfcbcd70e20e5842eebe6df"]],
  ["d2.sse.ordered-resume", ["lease-events.json", "30548f209cbd1e5263fc8dcbcae708a64b341e11e56226bda6fedcad85b6ca51"]],
  ["d2.sse.expired-cursor", ["lease-events.json", "0a77d466bf75ed70aff93d9f216422a48d1ad775746b3d8a59a0c4099378e715"]],
  ["d2.sse.future-cursor", ["lease-events.json", "78ffc9275e792c67dd9f0528d6cd0d4d06576104752f0207ad38be6008a32611"]],
  ["d2.process.executable-version-pinned", ["process-supervision.json", "c4e4d190944f343bb7326e18132b678ab0916c80aba77f42f1184022bbc85a4a"]],
  ["d2.process.missing-executable", ["process-supervision.json", "76f01f9e97873bc7b75ffc1d0852eef3b801e066c6b975f2f8449451fd71892b"]],
  ["d2.process.relative-executable-rejected", ["process-supervision.json", "4791447e5a2529a138585a32864caf9397c784869fa1b9a25f827f26b5d3fa31"]],
  ["d2.process.symlink-executable-rejected", ["process-supervision.json", "f509baa47e2eb669cb5aa4c240cb036f678d633db3ceae06e11789209fd9c3d9"]],
  ["d2.process.executable-changed-before-launch", ["process-supervision.json", "388dbe057c132ff0319996ab709642f41f71213ae34df614899e7b080148b647"]],
  ["d2.process.unsafe-executable-parent-rejected", ["process-supervision.json", "552b9d9108a8bc951ca96c974ff1a965438f4cf67fae6f53327d409790522db2"]],
  ["d2.process.same-inode-rewrite-denied", ["process-supervision.json", "3c86ed48f4458707848ae5085334f73ca3ac3324c0c240dd306e3f0be43b9d63"]],
  ["d2.process.post-check-path-replacement-ignored", ["process-supervision.json", "9ec05375111141ccd7f4bf63244acde111864be37a7d951b072684daf9cd1b04"]],
  ["d2.process.argv-metacharacters-are-literal", ["process-supervision.json", "df65a8b53f77e2b4de7230f8124e595906054c3b4bb4af41a04a2964029a7d4b"]],
  ["d2.process.command-string-contract-rejected", ["process-supervision.json", "98d73b827411393f608fce3d345203f9e6ab0d925a708410e0f0b67894fdbdef"]],
  ["d2.process.environment-denied", ["process-supervision.json", "4482e39663f1d80ad666af0ef8a111605897ed1f1e5606e30772543742927914"]],
  ["d2.process.minimal-environment", ["process-supervision.json", "a6d763c5dfc8d28330f81cecaee725c11226a19e84fa3de21dd5fa4a1175d952"]],
  ["d2.process.cwd-escape-rejected", ["process-supervision.json", "30635590badd928649313620acdc40495954eace899c0866ebef68995432200a"]],
  ["d2.process.cancel-before-escalation", ["process-supervision.json", "9a75ee73e4602daa36eb21964861ab1b873c2f33199459347a234a5c9acfd121"]],
  ["d2.process.cancel-escalates-and-cleans-descendants", ["process-supervision.json", "53ed13257f17e0c7c18285654ad5c0ceda940c7fb035cfb9d4b4440ea6151209"]],
  ["d2.process.descendant-cleanup-failure", ["process-supervision.json", "426805b322305467cd538a5bb4d90fa2942d5a8eefd16b4122d00eadb562ca06"]],
  ["d2.process.duration-timeout", ["process-supervision.json", "96185702b635017353d46391a1db1f0924a3886af81a5c1568c3d209c122cda3"]],
  ["d2.process.resource-defaults-and-ranges", ["process-supervision.json", "8d231df1a7cd684f8a0a1bca164a45f844adea1e7be97c84cafc7b1768a96c62"]],
  ["d2.process.resource-limit-out-of-range", ["process-supervision.json", "3a1872f185ab38802405390580ad40d5fc4c81efd2f9501ba02c8c45febdbc00"]],
  ["d2.process.host-without-delegated-cgroup-rejected", ["process-supervision.json", "dceb0d1f0761cc437a88177d50bea325bf6e779ad81061eb9c818ca4b1ad4d5a"]],
  ["d2.process.resource-unlimited-supported", ["process-supervision.json", "1a0c44b991c19fe84fb14a4f4a706499f96d9075e48286d84a34236dec8348aa"]],
  ["d2.process.output-unlimited-rejected", ["process-supervision.json", "8ba8321dfff69e0f63d865f9d6383f4d6f3576eb1a855d4fc8e90933d3454cb4"]],
  ["d2.process.unsupported-finite-resource-control", ["process-supervision.json", "4705fcc5b8e45f73297ca177d4cdb6283097acfb8b0ef2b3efb06a342574cfc6"]],
  ["d2.process.unsupported-file-limit", ["process-supervision.json", "447dac7056fd2166a116e44e79707accbb6cb26725a7e39f2269fd29495469f8"]],
  ["d2.process.output-backpressure", ["process-supervision.json", "03eab07c1287a9ecafdd515b975d735b3a848637b661b9b6536e45fc127c4f71"]],
  ["d2.process.output-truncation", ["process-supervision.json", "bdc75b9f78ab8d25e45994a0da1b1552ba957718038e9bb9b6832cac3c359a57"]],
  ["d2.process.output-redaction-before-buffer", ["process-supervision.json", "49f567cb179c386bd8f74a55a5bd583945179a9fc655db273804f1829a8a1b3a"]],
  ["d2.process.redaction-every-chunk-boundary", ["process-supervision.json", "6ec12678e67c6445df000ea214787b71dc3d7bf75c81401015ce241131b21c34"]],
  ["d2.process.redaction-invalid-utf8-preserved", ["process-supervision.json", "2b0dbaf62233223b460e560213d8fdd430a86b7a54439b50318834799750331a"]],
  ["d2.process.redaction-before-truncation-boundary", ["process-supervision.json", "638b9c8dd737da920d5f20e38cea8a3e90b143b4239a7ea0b3a718bad968ea1e"]],
  ["d2.process.redaction-final-partial-frame", ["process-supervision.json", "033ab7e685de6bdc4c28a4b1ca890b1fe47c6627f5f4c3773d91ea2ecbe187b9"]],
  ["d2.process.redaction-prefix-delimiter-and-eof", ["process-supervision.json", "2eb5233e33a63aabecda5c61e8188abcb7e29a6adb631033d525da8c337cf003"]],
  ["d2.process.redaction-field-oversize", ["process-supervision.json", "c30925f4122e6ebe67e848b29ee6a43e3b56054d5c10970323a1dbc529ee3b25"]],
  ["d2.process.long-line-continuation-frames", ["process-supervision.json", "76c593f131f4ca1283213daaba17630986af611fba701cd1428174da76526a87"]],
  ["d2.process.structured-frame-too-large", ["process-supervision.json", "00e9f707f58b716923fb457616cdbdad7016496fe2099cecf2858dcba4ddaf7d"]],
  ["d2.process.restart-stale-journal-boot-mismatch", ["process-supervision.json", "5419af1b44b646d54375ce6a63c10e2dfe8f932e066cc68181b71dc5e8e80ebe"]],
  ["d2.process.restart-pid-reuse-mismatch", ["process-supervision.json", "1060122dd9115fd3d5fb64aed36d5365b389a8355bd7d5b5a2a09666fca7eb6d"]],
  ["d2.process.nmap-unprivileged-typed-argv", ["process-supervision.json", "4020f0a144b10dfd41bdb82d6691e92f2e99c2380adbe51cbea6d9f160621e4c"]],
  ["d2.process.nmap-raw-flags-rejected", ["process-supervision.json", "8d5502ce3c9e5a26cbadc208204e773dedd6601cfa37df5cef981f280819da7b"]],
  ["d2.process.nmap-privileged-mode-rejected", ["process-supervision.json", "0d5b9efae5cc7ceb80de0331a87adb9cca58bd246abe6953f71fbdd3737384a5"]],
  ["d2.runner.enrollment-owner-confirmation", ["runner-identity.json", "6ca787dc1daa104bd2a7525e6a01eb4437f9220c31daa51050f037fedd53f634"]],
  ["d2.runner.enrollment-expired", ["runner-identity.json", "3d3df47e67e19339cf118dfc49496a4e5512656d5a674ee58ca6162a8299cfee"]],
  ["d2.runner.credential-hashed-at-rest", ["runner-identity.json", "63d5957e80ed5d0257d04f86ca56ae9aca21009cceb81e7f4411c42c1c2c2584"]],
  ["d2.runner.rotation-handover", ["runner-identity.json", "b95cbf5b46fc91f57630d417fae08371f4c9353ccfce78c6416182a5051ab2d0"]],
  ["d2.runner.revocation-fences-work", ["runner-identity.json", "dd8e7cf4600da22b5b39b358443dc8847048d59b42be9dd83814833cafd6762b"]],
  ["d2.runner.lost-credential-reenrollment", ["runner-identity.json", "24395eae321dc6a4d2359e144cf841dbd3356b44e98dafb8789d26ea27e076d2"]],
  ["d2.runner.route-separation", ["runner-identity.json", "742b7757fbe900270c9a0499dd63bb268624d0047016d7d1fa9e33bb7178c5e6"]],
  ["d2.runner.protocol-handshake-accepted", ["runner-identity.json", "e2bf7f05720e3ccf9f201bfa578e1d50ec6720e0b9fbe3b4cf4e7e5a1aa6b3b8"]],
  ["d2.runner.protocol-mismatch", ["runner-identity.json", "014fbf8933b69412998067a04a0fa90072f448bbc480a27dc1c6827f99896aa4"]],
  ["d2.runner.required-capability-missing", ["runner-identity.json", "2cab2145668a5c1dcc86a5122366fa1ffc3530a604b906ec967b2d29668e95e8"]],
  ["d2.runner.event-schema-unsupported", ["runner-identity.json", "3cd1f8f3cfb8773bf951df0d02b96e1885cd11aad2ae3295cae0ffae2ceb0eab"]],
  ["d2.runner.handshake-reports-abandoned-journals", ["runner-identity.json", "7a4c906fe88622f0157b8d90f6fc2d584b55b1c15cee4092b906e099d6dbd267"]],
  ["d2.state.action-transition-matrix", ["state-machine.json", "98aefbb9f59afe966d2724f98f3264d1d059a3ede306c11c9759f68d2d99a770"]],
  ["d2.state.run-transition-matrix", ["state-machine.json", "439e1f94dd4f79f0686a3ef251cf69d20667195cf259a0266b335b8e6ee1744f"]],
  ["d2.state.d1-warning-and-capability-routing", ["state-machine.json", "a4265715fa949d3d7a3cb81ffdc051c0adf18b20fb3671c9a64d79700d749d21"]],
  ["d2.state.late-warning-pauses-before-connect", ["state-machine.json", "4b26acac6a1fe200f467dacd8b2a7bc18a9fe64646dbdf2361312165f23bfd93"]],
  ["d2.state.late-continue-binds-context-and-resumes", ["state-machine.json", "7abbeb2b685ea49bb762e50860fc3da00c5825bf12dc6e7033c78ff543ecb17d"]],
  ["d2.state.late-auto-continue-never-pauses", ["state-machine.json", "26cac6f8bce082b35bece05410f580d2ef200ab6e84b78fa3efba7e96a089de3"]],
  ["d2.state.late-covered-destination-appends-without-pause", ["state-machine.json", "1dc05d580060d9dcfa5013462238d3d562b238ca076745f01553cfe60ae90ec6"]],
  ["d2.state.late-cancel-awaits-cleanup", ["state-machine.json", "1b2278627de2b6092b275d81557302d36b306b71760e90ec9c3b6d92e6c9c5e0"]],
  ["d2.state.late-continue-after-cancel-rejected", ["state-machine.json", "baec14053c9443bde04c74048a0abbcbc254d9a8b573be0f733faa2b289aa7df"]],
  ["d2.state.late-cancel-cleanup-completes", ["state-machine.json", "d1c4a7e7e6831782ab5d790c8920136d6588379f5f1bcb0ea0dfca58e78b255d"]],
  ["d2.state.late-cancel-cleanup-failure", ["state-machine.json", "fa0fab0e3d8a1a675647b22ac4d1d66af139d3bbe87407695f2fb448411129fc"]],
  ["d2.state.add-scope-appends-planning-version", ["state-machine.json", "8f8abb8a22eb7322a7ebc8e35a89da7ba66f0f6152078c6b9908da5a487203cd"]],
  ["d2.state.queued-snapshot-is-final", ["state-machine.json", "6ae0a914dcc3c619ad8a1e718968d252401b0663989d627126a7ddd491d3e126"]],
  ["d2.state.retry-preserves-action-identity", ["state-machine.json", "5f7914a5007ea5884171e72f4b14975ddb3b4624bc065d24743b390119c0f43d"]],
  ["d2.state.successful-run-retry-rejected", ["state-machine.json", "c18e4b96674ad88e5e2c82a72cc7bb83f3e137fbd727d64fc4d330a3eb7d480d"]],
  ["d2.state.one-terminal-winner", ["state-machine.json", "660514b69c01deebbdded428bf269c4cad6c87ececc1c45c680c3ec841089a4c"]],
  ["d2.state.identical-terminal-replay", ["state-machine.json", "3de944c48be1c1a7c4dd63a67007727fed32a16cdfbbe17f5197de9dd8c02a6a"]],
]);
const d3FixtureVersion = 1;
const d3Profile = "d3-v1";
const d3FixtureFiles = new Map([
  ["publication.json", "publication"],
  ["limits.json", "limits"],
  ["path-defenses.json", "path-defenses"],
  ["recovery.json", "recovery"],
  ["privacy-download.json", "privacy-download"],
  ["doctor.json", "doctor"],
  ["backup.json", "backup"],
]);
const requiredD3Cases = new Map([
  ["d3.backup.clean-consistent", ["backup.json", "22d1e35683879ddb7b16684739215c0c166b6cf7222a9bfc2bc464afad2f6618"]],
  ["d3.backup.interrupted-detectable", ["backup.json", "5bcc702796167ef77a6ccc013ab55ecdd2df7ded5e6dcbc71ba3fa629778f2dc"]],
  ["d3.backup.restore-empty-dest", ["backup.json", "e39d687f2abb147db9a943618d37e94c78e1f939f68015c13694dcafcb46a3db"]],
  ["d3.backup.restore-non-empty-refused", ["backup.json", "5edcbd40a55f94beeff4c61e8991a5495247de73748dc718083b0e4b688c9919"]],
  ["d3.backup.consistency-mismatch-refused", ["backup.json", "d2f81e929246556bdfb2ff9eb05fbc14f8ce9460ac1b1b5fba122c8b0d006fe3"]],
  ["d3.backup.quiesces-publication", ["backup.json", "785943ae4af22b14f1c3590269408ce72d3ab2c2de32c3a17dc3aea33264e127"]],
  ["d3.backup.excludes-staging", ["backup.json", "5723e20ecb6f8250dacd28344310025ef71d00223713d242778b081fa7d37cdb"]],
  ["d3.backup.newer-schema-refused", ["backup.json", "6936cdc36e32dbc2b3a27339285ce225e819c0103f43e2db8fe00fdf874df61b"]],
  ["d3.backup.destination-not-empty", ["backup.json", "6a81bf11047304c94a7cb5c048a986a5aacaefe3ca794e49606ec1e8b74c5aa5"]],
  ["d3.doctor.healthy", ["doctor.json", "ede9c77985a5e428586fbc1ae77c16a678f457d24f6c38bcd6e1c2fb2c03ed77"]],
  ["d3.doctor.missing", ["doctor.json", "4857188ac9d57463d23f64d2490d70af03493d1719b2b3350cba19959b9c992a"]],
  ["d3.doctor.corrupt-digest", ["doctor.json", "283752bee9892a0bf50dbe0279d1504376c60878e64e56648e88a7f0dd241a8b"]],
  ["d3.doctor.wrong-owner", ["doctor.json", "541ffe06d40febf6eaf61d05502c6ddeefa7e080cd52b8c2d0e7f8a076e5d114"]],
  ["d3.doctor.link-count", ["doctor.json", "5a765a4125fad8e818d8dcefaa3ab5ba95e22b12121e25adaf423702c7b23fbd"]],
  ["d3.doctor.extra-published", ["doctor.json", "ec2f23ced7c53bc3c7887f9289af35853782704503e4d41f3010e835a7793f10"]],
  ["d3.doctor.orphan-staging", ["doctor.json", "e0c0eb93844232f9a39369af4ce21da3c23742b4e2ea6f1f58ff588ae9525286"]],
  ["d3.doctor.path-escape", ["doctor.json", "ae90c10831a54d7bb4c533fe730600ffaa5ae28d97daa8532fde32578fe95314"]],
  ["d3.limits.quota-defaults", ["limits.json", "75c195519c059f2a882f9adbef90c82eb8cb591ac19e207d4d23b892a26157cc"]],
  ["d3.limits.partial-upload-not-published", ["limits.json", "80fcf06fbba2806e75b2b4d8c91979bf2346e643e2d9ebef66b633f1eb5edd74"]],
  ["d3.limits.cancellation-publishes-partial", ["limits.json", "7c9219d45b94d765771baad9d430751ed567f7b3748369e39670f753b03c2e35"]],
  ["d3.limits.timeout-not-published", ["limits.json", "8fa27e7cd049d7cdf2c379a61faed4501e6aadb10ae34a91de0fc34b8f8c45cc"]],
  ["d3.limits.truncation-labelled", ["limits.json", "b212dd18ffd19000743029986263472121a3340f74f590143049cecf694f526b"]],
  ["d3.limits.per-artifact-quota", ["limits.json", "b0c0591dc0febad604b829f09f003cc2d271ff83382779797482ffebdf074464"]],
  ["d3.limits.per-run-quota", ["limits.json", "2c3195e582b082984697f2f2f1b3156c2ab1c46ccddcd5eedd3595362faa3b44"]],
  ["d3.limits.total-quota", ["limits.json", "9639662f1e71d1371626ff2859061d1a517bccfc4530105aeef3868667bc4f9a"]],
  ["d3.limits.quota-preserves-published", ["limits.json", "dcbfab31070beee92400976e8bd1f3c2e24f019dc5f305320bf97097d0d6dc9c"]],
  ["d3.limits.streaming-backpressure", ["limits.json", "5a8213a662a0e68fa3f0a5309c54f036dcfa81f8f806f6bb50945ea2fc95ea73"]],
  ["d3.limits.lease-expiry-aborts-upload", ["limits.json", "edc53d5428a7b9bb746e59ee8d923a091b4e55a6eb02022a813ff48f289f9ac6"]],
  ["d3.limits.inflight-reservation-refused", ["limits.json", "019cf94e95d06a7afdcdd62a38ae40a5c9789eac152dfb2b62a8147534b2c6fb"]],
  ["d3.limits.concurrent-upload-limit", ["limits.json", "7f90bb919b2a7ae7671d91bc0152502b3e03ba6c3aac62cd4eaa7e83c8964e92"]],
  ["d3.path.traversal-rejected", ["path-defenses.json", "17492171f75f0874e9b1cd68505e54ccdf1ddf9fba0348299e90ae756a9f73b2"]],
  ["d3.path.absolute-path-rejected", ["path-defenses.json", "12c71b60136d887f80e847358b7c522c51f771034a853266f6b145bed1e1138c"]],
  ["d3.path.symlink-component-rejected", ["path-defenses.json", "03cfa63cd3de632385195f62284342dd4a237926d8d92b95a1bc20a177eaec21"]],
  ["d3.path.symlink-file-rejected", ["path-defenses.json", "df6a1ca86a4e784d1a15940f18878b4404d84c49c52bd78eb62f994859f63a7a"]],
  ["d3.path.hardlink-rejected", ["path-defenses.json", "766869ea17818314e3aac79e295f6f8a5e73cde0f3945b040dbbd0f3838d1e2c"]],
  ["d3.path.overwrite-rejected", ["path-defenses.json", "ab48998d0ea8b62569890d8ad0e65aaf4daa9324272ef224865a9be1a1211687"]],
  ["d3.path.rename-race-noreplace", ["path-defenses.json", "0e2305ed026d9bf5ca59ba63a12170fd773a307a73704b6cfd2d0cd99b4353e2"]],
  ["d3.path.cross-filesystem-rejected", ["path-defenses.json", "101b791bfcc36448dfef48724adc4a73165d1bcddf5485fab189087a3f1c0a68"]],
  ["d3.path.o-nofollow-and-regular-file", ["path-defenses.json", "236a1dd071ee7e13e572f2688ea00fe3de96f5ba9208a76d2b025e63a4cd9060"]],
  ["d3.path.link-count-must-be-one", ["path-defenses.json", "48c9bfec22e6268af066b9f3e2570ba6248012c0da36c0c62f2983aa85541c67"]],
  ["d3.path.same-device-staging-and-published", ["path-defenses.json", "a37e75a4a28d41d48a94c275a7e82630682bf3fe802df975fd4b41122cb0e742"]],
  ["d3.path.published-root-replaced-after-startup", ["path-defenses.json", "0efdc8b43dd7d2c67f7935aa396311d8c84e84267718bdd219e20a9074a064f3"]],
  ["d3.privacy.immutable-raw-bound-to-run", ["privacy-download.json", "629d74269b867f6cc0a6e294fd750db5cd5ecd799894607199233656946eb136"]],
  ["d3.privacy.parsed-observation-linkage", ["privacy-download.json", "7971a3ac58eedff92654e509b80791b2337727b3f69b2c74e602dd6b59bf8812"]],
  ["d3.privacy.parser-cannot-rewrite-raw", ["privacy-download.json", "2e63c6f40885740419779a887fc263f646941893ebc45399cada89c5979c9cf7"]],
  ["d3.privacy.redacted-stream-metadata", ["privacy-download.json", "3ba7130664cd3e509a2be35aaf0367ff9b58a619648ab2e6058d004f8f5bc965"]],
  ["d3.privacy.raw-tool-metadata", ["privacy-download.json", "a95fb1bf66456dab51975bcfcfee118667e5c43c1ac7a95126a98a7b8d0a4839"]],
  ["d3.privacy.logs-exclude-bytes", ["privacy-download.json", "6159248442219114f825c85b9dd8b31b27b2ebe6eab735c8672bd3735fa810e6"]],
  ["d3.privacy.redaction-cannot-claim-raw-preserved", ["privacy-download.json", "3e67f8412f808e50f20403794d71583898fb9f71e8fec4d84e23a92262662ae9"]],
  ["d3.download.safe-headers", ["privacy-download.json", "f3a1c2e7235c9125188064300af7957240a9ea43c7819acda586df22d8504c02"]],
  ["d3.download.untrusted-content-type-ignored", ["privacy-download.json", "6385d85954ba36d5fb7ec1888feed6b349e76953b166ce03afc5ff80475378e4"]],
  ["d3.download.unsafe-filename-replaced", ["privacy-download.json", "1debb4ed95f79301ce43acc62c5403ac7724ccc328766bd24caa1f7f6c9816ba"]],
  ["d3.download.range-not-supported", ["privacy-download.json", "c70be19c5380f91ceb2c43b9e1ac712b60ddf738e55ce67b45b2976292fb7fe9"]],
  ["d3.download.authorization-boundary", ["privacy-download.json", "c859523730c94775d07e2e1dde13e6d13a2ba1fd494d339b7f13f49c04b0a6a2"]],
  ["d3.download.missing-truthful", ["privacy-download.json", "000f27715977bbdbf8df26d925e13557c7fef2e3843051c42f15f0e222b85790"]],
  ["d3.download.corrupt-truthful", ["privacy-download.json", "7b8b3282649fee1c5de160528640f5f88ddab7ae3c36dac3e7971b0ddb34d2ba"]],
  ["d3.download.safe-filename-preserved", ["privacy-download.json", "74442b0ae4aa86659745a4254e7f0f82cb2e773bd20d52948eef9fae1a64163d"]],
  ["d3.download.engagement-mismatch", ["privacy-download.json", "58fea4fe7a72fd8891a841c31141f02ad69cc6b0db4ece06a953a9872d716ea1"]],
  ["d3.privacy.parsed-input-metadata", ["privacy-download.json", "94d254c19682b72b2086a684bff4f4811baa4f804188e8abb319d72b4e853831"]],
  ["d3.publication.grant-authenticated-runner", ["publication.json", "2fe9d7c68f9055c4ba1446a22781b59b5d94731af442592afa511a5e065a40fb"]],
  ["d3.publication.operator-cannot-upload", ["publication.json", "c6e92bc1da2ec31dc01e15cfff60a8723deef9fec9d5cd027d2b7ca72f76886d"]],
  ["d3.publication.control-plane-generates-ids-and-paths", ["publication.json", "46c8df2c04f539cc44ad43244b9e952c4fe146bd49d62d51e9d53f3f8c467052"]],
  ["d3.publication.caller-supplied-path-ignored", ["publication.json", "3271330404556ce7a9cc793deeef20af3022fa1a8da5d18c386b888c416cb751"]],
  ["d3.publication.successful-upload-digest-fsync", ["publication.json", "ee689d3b3f394b6fd8ee0f008214ff82ae03e76b696432d96857765425a8f46c"]],
  ["d3.publication.metadata-after-durable-file", ["publication.json", "ac9f0ab17237efe37df2bd51420e57e1b71c829c10b207a4d6c865b57b085325"]],
  ["d3.publication.no-replace-existing-dest", ["publication.json", "eda1acf0cdfe1a25e49b436d144a12ff3f5e18c76dde00b43c21749b672e9afc"]],
  ["d3.publication.identity-unique-by-run-fence-sequence-slot", ["publication.json", "7a760e630335aa4ac9680c15012436999ed0286a324ea2d5fe6d98ddd9678db8"]],
  ["d3.publication.identical-replay", ["publication.json", "c22c3577aa096f04f016c008050dbcdad097adcad8bb4c6256d7d38342fe05b4"]],
  ["d3.publication.digest-mismatch-not-published", ["publication.json", "a9e3c9e96bf2e7fba9501265cdf46b5c6d08f070993681b390cbba57e0091599"]],
  ["d3.publication.digest-conflict-preserves-original", ["publication.json", "197ebc23de8745037bb1d493be0a6e61f47abb10a1910fdfc86019fff22fbd1e"]],
  ["d3.publication.no-shared-filesystem", ["publication.json", "e7a8f339826a2e1c2b9a3b5c8fe6653bb835fe9ad25ead56dd636c7469ce9b27"]],
  ["d3.publication.empty-artifact-allowed", ["publication.json", "a26ec245673c93f2124d1dd7aec28da0221f25a1f259aeb1b061b9ab9dabc49c"]],
  ["d3.publication.same-upload-complete-replay", ["publication.json", "69deda1e03f78f8f984571b986da6b37cc3700c027e2576c398c644c7b289898"]],
  ["d3.recovery.orphan-staging-not-published", ["recovery.json", "b82615c6d7179cac9672516804c570291cf2118f00ce13a402922f841ecf6949"]],
  ["d3.recovery.committed-metadata-missing-file", ["recovery.json", "79604c53b8d1e7a1f6cae4a3f7aa2d94d79a4394ac69c5107e38976d05562d90"]],
  ["d3.recovery.crash-after-rename-before-row", ["recovery.json", "f35bc5b65ec46b5aab521187927374ed196352e37b4619af60c2addc3b6bcc58"]],
  ["d3.recovery.no-silent-repair", ["recovery.json", "0e5564c30f70a29d46b00fb5f544c57d92f0282794508c34e2e2020d04d20f8c"]],
  ["d3.recovery.restart-inflight-upload", ["recovery.json", "27aa9be9a1f5b873ffde176768bdf9d0346f5721330cdd24cdc967e24131cac6"]],
  ["d3.recovery.extra-published-not-imported", ["recovery.json", "5cf01f1b0261c541b57c6f7c54b35e63a41864f4b017c16f32e337ad1ac3b25b"]],
  ["d3.recovery.finalized-complete-retry", ["recovery.json", "8d498b8f7f7863187435107f3b43e6f45be789ea4fdfd192496a461550c2970c"]],
  ["d3.recovery.complete-after-rename-matches-grant", ["recovery.json", "dfdc9e6a7163f9ea7625983d6f50e59e833a7885b126c8d29fc406d588e80b72"]],
]);
const forbiddenFixtureValue =
  /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bbearer\s+\S+|\bsk-[a-z0-9_-]{12,}|\bghp_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\bxoxb-[a-z0-9-]{20,})/i;
const ipv4Like = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const ipv6Like = /(?<![a-z0-9])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*(?:%25?[a-z0-9._~-]+)?(?:\/\d{1,3})?/gi;
const domainLike = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}\.?/giu;
const singleLabelHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const forbiddenMetaPatterns = [
  /what was learned/i,
  /reference studied/i,
  /proposed amendments/i,
  /legacy working tree/i,
];

export function localMarkdownTargets(markdown) {
  const targets = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

  for (const match of markdown.matchAll(linkPattern)) {
    const rawTarget = match[1].trim();
    if (
      rawTarget.length === 0 ||
      rawTarget.startsWith("#") ||
      /^(?:https?:|mailto:)/i.test(rawTarget)
    ) {
      continue;
    }

    const target = rawTarget.split("#", 1)[0];
    if (target.length > 0) targets.push(target);
  }

  return targets;
}

async function markdownFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function d2CaseFingerprint(fixtureCase) {
  const outcomeName = Object.hasOwn(fixtureCase, "expected") ? "expected" : "error";
  const criticalContract = {
    given: fixtureCase.given,
    [outcomeName]: fixtureCase[outcomeName],
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(criticalContract)))
    .digest("hex");
}

function normalizedFieldName(key) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isForbiddenFixtureKey(key) {
  const normalizedKey = normalizedFieldName(key);
  return (
    /(?:secret|token|password|apikey|privatekey|cookie)$/.test(normalizedKey) ||
    normalizedKey === "authorization"
  );
}

function isSingleLabelTargetField(key) {
  return /(?:input|target|hostname|host|queryname|sniname|hostheader)$/.test(
    normalizedFieldName(key),
  );
}

function isTargetBearingField(key) {
  return (
    isSingleLabelTargetField(key) ||
    /(?:url|origin|location|destination)$/.test(normalizedFieldName(key))
  );
}

function documentationIpv4(address) {
  return /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(address);
}

function ipv6Words(address) {
  let expandedAddress = address.toLowerCase();
  if (expandedAddress.includes(".")) {
    const lastColon = expandedAddress.lastIndexOf(":");
    const octets = expandedAddress
      .slice(lastColon + 1)
      .split(".")
      .map((octet) => Number.parseInt(octet, 10));
    expandedAddress = `${expandedAddress.slice(0, lastColon)}:${(
      (octets[0] << 8) |
      octets[1]
    ).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = expandedAddress.split("::");
  const left = halves[0] ? halves[0].split(":").map((word) => Number.parseInt(word, 16)) : [];
  const right = halves[1] ? halves[1].split(":").map((word) => Number.parseInt(word, 16)) : [];
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function isReservedFixtureIpv6(address) {
  const words = ipv6Words(address);
  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (isMappedIpv4) {
    const mappedAddress = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(
      ".",
    );
    return documentationIpv4(mappedAddress);
  }

  const isDocumentationAddress = words[0] === 0x2001 && words[1] === 0x0db8;
  const isLinkLocalAddress = (words[0] & 0xffc0) === 0xfe80;
  return isDocumentationAddress || isLinkLocalAddress;
}

function unicodeTargetHostname(value, key) {
  if (!isTargetBearingField(key)) return undefined;

  if (/^https?:\/\//i.test(value)) {
    try {
      const hostname = new URL(value).hostname;
      if (!hostname.startsWith("[") && isIP(hostname) === 0) return hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }

  if (value.includes(".") && /[^\x00-\x7f]/u.test(value)) {
    const hostname = domainToASCII(value.replace(/\.$/, ""));
    if (hostname) return hostname.toLowerCase();
  }

  return undefined;
}

function fixtureContentErrors(value, location, key = "") {
  const errors = [];

  if (isForbiddenFixtureKey(key)) {
    errors.push(`${location}: forbidden secret-bearing field ${key}`);
  }

  if (typeof value === "string") {
    if (forbiddenFixtureValue.test(value)) {
      errors.push(`${location}: contains secret-like content`);
    }

    for (const match of value.matchAll(ipv4Like)) {
      const address = match[0];
      if (!documentationIpv4(address)) {
        errors.push(`${location}: contains non-documentation IPv4 address ${address}`);
      }
    }

    for (const match of value.matchAll(ipv6Like)) {
      const address = match[0].replace(/\/\d{1,3}$/, "").replace(/%25?[a-z0-9._~-]+$/i, "");
      if (isIP(address) === 6 && !isReservedFixtureIpv6(address)) {
        errors.push(`${location}: contains non-documentation IPv6 address ${address}`);
      }
    }

    if (
      isSingleLabelTargetField(key) &&
      singleLabelHostname.test(value) &&
      !/-lab$/i.test(value)
    ) {
      errors.push(`${location}: contains non-synthetic single-label hostname ${value}`);
    }

    const unicodeHostname = unicodeTargetHostname(value, key);
    if (unicodeHostname && !/\.(?:test|example|invalid)$/.test(unicodeHostname)) {
      errors.push(`${location}: contains non-reserved hostname ${unicodeHostname}`);
    }

    if (key !== "id" && key !== "description" && value !== "C.UTF-8") {
      for (const match of value.matchAll(domainLike)) {
        const hostname = match[0].replace(/\.$/, "").toLowerCase();
        if (!/\.(?:test|example|invalid)$/.test(hostname)) {
          errors.push(`${location}: contains non-reserved hostname ${match[0]}`);
        }
      }
    }

    return errors;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      errors.push(...fixtureContentErrors(item, `${location}[${index}]`, key));
    }
    return errors;
  }

  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      errors.push(...fixtureContentErrors(childValue, `${location}.${childKey}`, childKey));
    }
  }

  return errors;
}

function requiredMalformedTargetErrors(fixtureCases, relativePath) {
  const errors = [];
  const casesById = new Map(
    fixtureCases
      .filter((fixtureCase) => isRecord(fixtureCase) && typeof fixtureCase.id === "string")
      .map((fixtureCase) => [fixtureCase.id, fixtureCase]),
  );

  for (const requiredCase of requiredD1MalformedTargetCases) {
    const fixtureCase = casesById.get(requiredCase.id);
    if (!fixtureCase) {
      errors.push(`${relativePath}: missing required malformed target case ${requiredCase.id}`);
      continue;
    }
    if (fixtureCase.given?.input !== requiredCase.input) {
      errors.push(
        `${relativePath}: ${requiredCase.id}.given.input must be ${JSON.stringify(requiredCase.input)}`,
      );
    }
    if (fixtureCase.error?.code !== requiredCase.code) {
      errors.push(`${relativePath}: ${requiredCase.id}.error.code must be ${requiredCase.code}`);
    }
  }

  return errors;
}

function requiredPositiveTargetErrors(fixtureCases, relativePath) {
  const errors = [];
  const casesById = new Map(
    fixtureCases
      .filter((fixtureCase) => isRecord(fixtureCase) && typeof fixtureCase.id === "string")
      .map((fixtureCase) => [fixtureCase.id, fixtureCase]),
  );

  for (const requiredCase of requiredD1PositiveTargetCases) {
    const fixtureCase = casesById.get(requiredCase.id);
    if (!fixtureCase) {
      errors.push(`${relativePath}: missing required positive target case ${requiredCase.id}`);
      continue;
    }
    if (fixtureCase.given?.input !== requiredCase.input) {
      errors.push(
        `${relativePath}: ${requiredCase.id}.given.input must be ${JSON.stringify(requiredCase.input)}`,
      );
    }
    if (!isDeepStrictEqual(fixtureCase.expected?.canonicalTarget, requiredCase.canonicalTarget)) {
      errors.push(
        `${relativePath}: ${requiredCase.id}.expected.canonicalTarget must preserve zone 25Eth0`,
      );
    }
  }

  return errors;
}

export async function checkD1Fixtures(repositoryRoot) {
  const fixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d1");
  const errors = [];
  const caseIds = new Map();

  if (!(await exists(fixtureDirectory))) {
    return ["docs/architecture/fixtures/d1: missing D1 fixture directory"];
  }

  const fixtureEntries = await readdir(fixtureDirectory, { withFileTypes: true });
  for (const entry of fixtureEntries) {
    if (entry.isFile() && entry.name.endsWith(".json") && !d1FixtureFiles.has(entry.name)) {
      errors.push(`docs/architecture/fixtures/d1/${entry.name}: unexpected D1 fixture file`);
    }
  }

  for (const [fileName, expectedKind] of d1FixtureFiles) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const relativePath = path.relative(repositoryRoot, fixturePath);

    if (!(await exists(fixturePath))) {
      errors.push(`${relativePath}: missing required D1 fixture file`);
      continue;
    }

    let fixture;
    try {
      fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    } catch (error) {
      errors.push(`${relativePath}: invalid JSON: ${error.message}`);
      continue;
    }

    if (!isRecord(fixture)) {
      errors.push(`${relativePath}: fixture root must be an object`);
      continue;
    }

    if (fixture.fixtureVersion !== d1FixtureVersion) {
      errors.push(`${relativePath}: fixtureVersion must be ${d1FixtureVersion}`);
    }
    if (fixture.normalizationProfile !== d1NormalizationProfile) {
      errors.push(`${relativePath}: normalizationProfile must be ${d1NormalizationProfile}`);
    }
    if (fixture.kind !== expectedKind) {
      errors.push(`${relativePath}: kind must be ${expectedKind}`);
    }
    if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
      errors.push(`${relativePath}: cases must be a non-empty array`);
      continue;
    }

    for (const [index, fixtureCase] of fixture.cases.entries()) {
      const caseLocation = `${relativePath}: cases[${index}]`;
      if (!isRecord(fixtureCase)) {
        errors.push(`${caseLocation} must be an object`);
        continue;
      }

      if (typeof fixtureCase.id !== "string" || !/^d1\.[a-z0-9.-]+$/.test(fixtureCase.id)) {
        errors.push(`${caseLocation}.id must be a stable d1 case ID`);
      } else if (caseIds.has(fixtureCase.id)) {
        errors.push(
          `${caseLocation}.id duplicates ${fixtureCase.id} from ${caseIds.get(fixtureCase.id)}`,
        );
      } else {
        caseIds.set(fixtureCase.id, caseLocation);
      }

      if (typeof fixtureCase.description !== "string" || fixtureCase.description.trim() === "") {
        errors.push(`${caseLocation}.description must be a non-empty string`);
      }
      if (!isRecord(fixtureCase.given)) {
        errors.push(`${caseLocation}.given must be an object`);
      }

      const hasExpected = Object.hasOwn(fixtureCase, "expected");
      const hasError = Object.hasOwn(fixtureCase, "error");
      if (hasExpected === hasError) {
        errors.push(`${caseLocation} must contain exactly one of expected or error`);
      } else {
        const outcomeName = hasExpected ? "expected" : "error";
        const outcome = fixtureCase[outcomeName];
        if (!isRecord(outcome) || Object.keys(outcome).length === 0) {
          errors.push(`${caseLocation}.${outcomeName} must be a non-empty object`);
        }
        if (hasError && (typeof outcome?.code !== "string" || outcome.code.trim() === "")) {
          errors.push(`${caseLocation}.error.code must be a non-empty string`);
        }
      }

      errors.push(...fixtureContentErrors(fixtureCase, caseLocation));
    }

    if (expectedKind === "normalization") {
      errors.push(...requiredMalformedTargetErrors(fixture.cases, relativePath));
      errors.push(...requiredPositiveTargetErrors(fixture.cases, relativePath));
    }

    if (expectedKind === "snapshot-canonicalization") {
      const seenRequired = new Set();
      for (const [index, fixtureCase] of fixture.cases.entries()) {
        if (!isRecord(fixtureCase) || typeof fixtureCase.id !== "string") continue;
        const required = requiredD1SnapshotCanonicalCases.get(fixtureCase.id);
        if (required === undefined) {
          errors.push(
            `${relativePath}: cases[${index}].id ${fixtureCase.id} is not a required action-snapshot-json-v1 case`,
          );
          continue;
        }
        const [requiredFileName, requiredFingerprint] = required;
        if (requiredFileName !== fileName) {
          errors.push(
            `${relativePath}: cases[${index}].id ${fixtureCase.id} belongs in ${requiredFileName}`,
          );
          continue;
        }
        seenRequired.add(fixtureCase.id);
        const fingerprint = d2CaseFingerprint(fixtureCase);
        if (fingerprint !== requiredFingerprint) {
          errors.push(
            `${relativePath}: cases[${index}]: ${fixtureCase.id} critical given fields or exact outcome changed`,
          );
        }
      }
      for (const [requiredId, [requiredFileName]] of requiredD1SnapshotCanonicalCases) {
        if (requiredFileName === fileName && !seenRequired.has(requiredId)) {
          errors.push(`${relativePath}: missing required D1 case ${requiredId}`);
        }
      }
    }
  }

  return errors;
}

export async function checkD2Fixtures(repositoryRoot) {
  const fixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d2");
  const errors = [];
  const caseIds = new Map();

  if (!(await exists(fixtureDirectory))) {
    return ["docs/architecture/fixtures/d2: missing D2 fixture directory"];
  }

  const fixtureEntries = await readdir(fixtureDirectory, { withFileTypes: true });
  for (const entry of fixtureEntries) {
    if (entry.isFile() && entry.name.endsWith(".json") && !d2FixtureFiles.has(entry.name)) {
      errors.push(`docs/architecture/fixtures/d2/${entry.name}: unexpected D2 fixture file`);
    }
  }

  for (const [fileName, expectedKind] of d2FixtureFiles) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const relativePath = path.relative(repositoryRoot, fixturePath);

    if (!(await exists(fixturePath))) {
      errors.push(`${relativePath}: missing required D2 fixture file`);
      continue;
    }

    let fixture;
    try {
      fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    } catch (error) {
      errors.push(`${relativePath}: invalid JSON: ${error.message}`);
      continue;
    }

    if (!isRecord(fixture)) {
      errors.push(`${relativePath}: fixture root must be an object`);
      continue;
    }
    if (fixture.fixtureVersion !== d2FixtureVersion) {
      errors.push(`${relativePath}: fixtureVersion must be ${d2FixtureVersion}`);
    }
    if (fixture.profile !== d2Profile) {
      errors.push(`${relativePath}: profile must be ${d2Profile}`);
    }
    if (fixture.kind !== expectedKind) {
      errors.push(`${relativePath}: kind must be ${expectedKind}`);
    }
    if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
      errors.push(`${relativePath}: cases must be a non-empty array`);
      continue;
    }

    for (const [index, fixtureCase] of fixture.cases.entries()) {
      const caseLocation = `${relativePath}: cases[${index}]`;
      if (!isRecord(fixtureCase)) {
        errors.push(`${caseLocation} must be an object`);
        continue;
      }

      if (typeof fixtureCase.id !== "string" || !/^d2\.[a-z0-9.-]+$/.test(fixtureCase.id)) {
        errors.push(`${caseLocation}.id must be a stable d2 case ID`);
      } else if (caseIds.has(fixtureCase.id)) {
        errors.push(
          `${caseLocation}.id duplicates ${fixtureCase.id} from ${caseIds.get(fixtureCase.id)}`,
        );
      } else {
        caseIds.set(fixtureCase.id, caseLocation);
      }

      if (typeof fixtureCase.description !== "string" || fixtureCase.description.trim() === "") {
        errors.push(`${caseLocation}.description must be a non-empty string`);
      }
      if (!isRecord(fixtureCase.given) || Object.keys(fixtureCase.given).length === 0) {
        errors.push(`${caseLocation}.given must be a non-empty object`);
      }

      const hasExpected = Object.hasOwn(fixtureCase, "expected");
      const hasError = Object.hasOwn(fixtureCase, "error");
      if (hasExpected === hasError) {
        errors.push(`${caseLocation} must contain exactly one of expected or error`);
      } else {
        const outcomeName = hasExpected ? "expected" : "error";
        const outcome = fixtureCase[outcomeName];
        if (!isRecord(outcome) || Object.keys(outcome).length === 0) {
          errors.push(`${caseLocation}.${outcomeName} must be a non-empty object`);
        }
        if (hasError && (typeof outcome?.code !== "string" || outcome.code.trim() === "")) {
          errors.push(`${caseLocation}.error.code must be a non-empty string`);
        }
      }

      errors.push(...fixtureContentErrors(fixtureCase, caseLocation));

      if (typeof fixtureCase.id === "string") {
        const required = requiredD2Cases.get(fixtureCase.id);
        if (!required) {
          errors.push(`${caseLocation}.id is not a required d2-v1 case`);
        } else {
          const [requiredFileName, requiredFingerprint] = required;
          if (fileName !== requiredFileName) {
            errors.push(`${caseLocation}.id must be in ${requiredFileName}`);
          }
          if (hasExpected !== hasError) {
            const fingerprint = d2CaseFingerprint(fixtureCase);
            if (fingerprint !== requiredFingerprint) {
              errors.push(
                `${caseLocation}: ${fixtureCase.id} critical given fields or exact outcome changed`,
              );
            }
          }
        }
      }
    }
  }

  for (const [requiredId, [requiredFileName]] of requiredD2Cases) {
    if (!caseIds.has(requiredId)) {
      errors.push(
        `docs/architecture/fixtures/d2/${requiredFileName}: missing required D2 case ${requiredId}`,
      );
    }
  }

  return errors;
}

export async function checkD3Fixtures(repositoryRoot) {
  const fixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d3");
  const errors = [];
  const caseIds = new Map();

  if (!(await exists(fixtureDirectory))) {
    return ["docs/architecture/fixtures/d3: missing D3 fixture directory"];
  }

  const fixtureEntries = await readdir(fixtureDirectory, { withFileTypes: true });
  for (const entry of fixtureEntries) {
    if (entry.isFile() && entry.name.endsWith(".json") && !d3FixtureFiles.has(entry.name)) {
      errors.push(`docs/architecture/fixtures/d3/${entry.name}: unexpected D3 fixture file`);
    }
  }

  for (const [fileName, expectedKind] of d3FixtureFiles) {
    const fixturePath = path.join(fixtureDirectory, fileName);
    const relativePath = path.relative(repositoryRoot, fixturePath);

    if (!(await exists(fixturePath))) {
      errors.push(`${relativePath}: missing required D3 fixture file`);
      continue;
    }

    let fixture;
    try {
      fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    } catch (error) {
      errors.push(`${relativePath}: invalid JSON: ${error.message}`);
      continue;
    }

    if (!isRecord(fixture)) {
      errors.push(`${relativePath}: fixture root must be an object`);
      continue;
    }
    if (fixture.fixtureVersion !== d3FixtureVersion) {
      errors.push(`${relativePath}: fixtureVersion must be ${d3FixtureVersion}`);
    }
    if (fixture.profile !== d3Profile) {
      errors.push(`${relativePath}: profile must be ${d3Profile}`);
    }
    if (fixture.kind !== expectedKind) {
      errors.push(`${relativePath}: kind must be ${expectedKind}`);
    }
    if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
      errors.push(`${relativePath}: cases must be a non-empty array`);
      continue;
    }

    for (const [index, fixtureCase] of fixture.cases.entries()) {
      const caseLocation = `${relativePath}: cases[${index}]`;
      if (!isRecord(fixtureCase)) {
        errors.push(`${caseLocation} must be an object`);
        continue;
      }

      if (typeof fixtureCase.id !== "string" || !/^d3\.[a-z0-9.-]+$/.test(fixtureCase.id)) {
        errors.push(`${caseLocation}.id must be a stable d3 case ID`);
      } else if (caseIds.has(fixtureCase.id)) {
        errors.push(
          `${caseLocation}.id duplicates ${fixtureCase.id} from ${caseIds.get(fixtureCase.id)}`,
        );
      } else {
        caseIds.set(fixtureCase.id, caseLocation);
      }

      if (typeof fixtureCase.description !== "string" || fixtureCase.description.trim() === "") {
        errors.push(`${caseLocation}.description must be a non-empty string`);
      }
      if (!isRecord(fixtureCase.given) || Object.keys(fixtureCase.given).length === 0) {
        errors.push(`${caseLocation}.given must be a non-empty object`);
      }

      const hasExpected = Object.hasOwn(fixtureCase, "expected");
      const hasError = Object.hasOwn(fixtureCase, "error");
      if (hasExpected === hasError) {
        errors.push(`${caseLocation} must contain exactly one of expected or error`);
      } else {
        const outcomeName = hasExpected ? "expected" : "error";
        const outcome = fixtureCase[outcomeName];
        if (!isRecord(outcome) || Object.keys(outcome).length === 0) {
          errors.push(`${caseLocation}.${outcomeName} must be a non-empty object`);
        }
        if (hasError && (typeof outcome?.code !== "string" || outcome.code.trim() === "")) {
          errors.push(`${caseLocation}.error.code must be a non-empty string`);
        }
      }

      errors.push(...fixtureContentErrors(fixtureCase, caseLocation));

      if (typeof fixtureCase.id === "string") {
        const required = requiredD3Cases.get(fixtureCase.id);
        if (!required) {
          errors.push(`${caseLocation}.id is not a required d3-v1 case`);
        } else {
          const [requiredFileName, requiredFingerprint] = required;
          if (fileName !== requiredFileName) {
            errors.push(`${caseLocation}.id must be in ${requiredFileName}`);
          }
          if (hasExpected !== hasError) {
            const fingerprint = d2CaseFingerprint(fixtureCase);
            if (fingerprint !== requiredFingerprint) {
              errors.push(
                `${caseLocation}: ${fixtureCase.id} critical given fields or exact outcome changed`,
              );
            }
          }
        }
      }
    }
  }

  for (const [requiredId, [requiredFileName]] of requiredD3Cases) {
    if (!caseIds.has(requiredId)) {
      errors.push(
        `docs/architecture/fixtures/d3/${requiredFileName}: missing required D3 case ${requiredId}`,
      );
    }
  }

  return errors;
}

export async function checkDocumentation(repositoryRoot) {
  const errors = [];

  for (const file of await markdownFiles(repositoryRoot)) {
    const relativeFile = path.relative(repositoryRoot, file);
    const markdown = await readFile(file, "utf8");

    for (const pattern of forbiddenMetaPatterns) {
      if (pattern.test(markdown)) {
        errors.push(`${relativeFile}: contains review/source metadata matching ${pattern}`);
      }
    }

    for (const target of localMarkdownTargets(markdown)) {
      const resolvedTarget = path.resolve(path.dirname(file), target);
      if (!(await exists(resolvedTarget))) {
        errors.push(`${relativeFile}: missing local link target ${target}`);
      }
    }
  }

  const d1FixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d1");
  const d1AdrPath = path.join(
    repositoryRoot,
    "docs",
    "architecture",
    "0001-target-normalization-scope-warnings.md",
  );
  if ((await exists(d1AdrPath)) || (await exists(d1FixtureDirectory))) {
    errors.push(...(await checkD1Fixtures(repositoryRoot)));
  }

  const d2FixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d2");
  const d2AdrPath = path.join(
    repositoryRoot,
    "docs",
    "architecture",
    "0002-actions-runs-runner-trust.md",
  );
  if ((await exists(d2AdrPath)) || (await exists(d2FixtureDirectory))) {
    errors.push(...(await checkD2Fixtures(repositoryRoot)));
  }

  const d3FixtureDirectory = path.join(repositoryRoot, "docs", "architecture", "fixtures", "d3");
  const d3AdrPath = path.join(
    repositoryRoot,
    "docs",
    "architecture",
    "0003-evidence-publication-recovery.md",
  );
  if ((await exists(d3AdrPath)) || (await exists(d3FixtureDirectory))) {
    errors.push(...(await checkD3Fixtures(repositoryRoot)));
  }

  return errors;
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = await checkDocumentation(repositoryRoot);

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log("Documentation check passed.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
