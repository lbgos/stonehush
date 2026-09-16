import { z } from "zod";

/**
 * STONE-6 ffuf wordlist-by-name and rate-truthfulness contracts.
 * Additive only: the launch route keeps accepting a resolved absolute
 * wordlist path. Name resolution happens client-side in this slice, so the
 * strict launch schema never sees `wordlistName`. The demo list is labeled
 * as synthetic and never poses as a serious preset.
 */

export const FFUF_WORDLIST_DEMO_NAME = "demo-tiny" as const;

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const FfufWordlistNameSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 64), {
    message: "must contain between 1 and 64 Unicode code points",
  })
  .refine((value) => /^[a-z0-9][a-z0-9_-]*$/.test(value), {
    message: "must be a lowercase slug",
  });

export type FfufWordlistName = z.infer<typeof FfufWordlistNameSchema>;

export const FfufWordlistOptionSchema = z.strictObject({
  name: FfufWordlistNameSchema,
  purpose: z.string().min(1).max(200),
  approxEntries: z.number().int().nonnegative(),
  /** Absolute managed path, or null when the operator has not configured it. */
  path: z.string().min(1).max(1024).nullable(),
  isDemo: z.boolean(),
});

export type FfufWordlistOption = z.infer<typeof FfufWordlistOptionSchema>;

/** Shipped catalog shape. Only the demo entry is synthetic and tiny. */
export const FfufWordlistCatalogSchema = z.strictObject({
  version: z.literal(1),
  options: z.array(FfufWordlistOptionSchema).min(1).max(64),
});

export type FfufWordlistCatalog = z.infer<typeof FfufWordlistCatalogSchema>;

export const FFUF_WORDLIST_CATALOG: FfufWordlistCatalog = {
  version: 1,
  options: [
    {
      name: FFUF_WORDLIST_DEMO_NAME,
      purpose: "Synthetic smoke test only, not a serious preset",
      approxEntries: 12,
      path: null,
      isDemo: true,
    },
    {
      name: "common",
      purpose: "Common web paths for quick discovery",
      approxEntries: 4600,
      path: null,
      isDemo: false,
    },
    {
      name: "raft-small",
      purpose: "Curated small wordlist for focused runs",
      approxEntries: 43000,
      path: null,
      isDemo: false,
    },
  ],
};

export const FfufRateTruthSchema = z.strictObject({
  installedVersion: z.string().min(1).max(64).nullable(),
  supportsRate: z.boolean(),
  /** Exact user-facing limitation copy; always present when unsupported. */
  limitation: z.string().min(1).max(500).nullable(),
});

export type FfufRateTruth = z.infer<typeof FfufRateTruthSchema>;

/**
 * ffuf 1.1.0 rejects `-rate`, so the argv builder never emits it and the
 * rate option is stored for forward compatibility only. Any other version
 * is reported as unknown until verified against its real binary.
 */
export function describeFfufRateSupport(installedVersion: string | null): FfufRateTruth {
  if (installedVersion === "1.1.0") {
    return {
      installedVersion,
      supportsRate: false,
      limitation:
        "Installed ffuf 1.1.0 does not accept -rate. The rate value is stored for forward compatibility and is not sent to this binary.",
    };
  }
  if (installedVersion === null || installedVersion.trim().length === 0) {
    return {
      installedVersion: null,
      supportsRate: false,
      limitation:
        "Installed ffuf version is unknown. Rate is stored but may not affect this run; verify the binary before relying on it.",
    };
  }
  return {
    installedVersion,
    supportsRate: false,
    limitation: `Rate support for installed ffuf ${installedVersion} is unverified. The rate value is stored and shown, but not claimed to affect this run.`,
  };
}
