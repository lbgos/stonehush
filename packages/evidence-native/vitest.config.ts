import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@stonehush/contracts": fileURLToPath(
        new URL("../contracts/src/index.ts", import.meta.url),
      ),
      "@stonehush/domain": fileURLToPath(
        new URL("../domain/src/index.ts", import.meta.url),
      ),
    },
    conditions: ["development"],
  },
});
