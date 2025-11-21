// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/types.ts",
    "src/constants.ts",
    "src/modules/*/index.ts",
    "src/abi/*.ts"
  ],
  format: ["cjs", "esm"],
  dts: true,
  shims: true,
  skipNodeModulesBundle: true,
  treeshake: false,
  clean: true
});
