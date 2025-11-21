import { defineConfig } from "tsup";
import fs from 'fs-extra'
export default defineConfig({
  format: ["cjs", "esm"],
  entry: ["./src/index.ts"],
  dts: true,
  shims: true,
  skipNodeModulesBundle: true,
  clean: true,
  onSuccess: async () => {
    await fs.copy('src/abi', 'dist/abi')
  }
});
