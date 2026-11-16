import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  // Workspace TS sources are bundled in; npm dependencies stay external.
  noExternal: ["@relay/core"],
});
