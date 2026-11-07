import { build } from "esbuild";
import path from "node:path";

await build({
  entryPoints: ["server/src/vercel-entry.ts"],
  outfile: "api/generated/gate.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  plugins: [
    {
      name: "resolve-ts",
      setup(build) {
        build.onResolve({ filter: /^\..*\.ts$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path),
        }));
      },
    },
  ],
});
