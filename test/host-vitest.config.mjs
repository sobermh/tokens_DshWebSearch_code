import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outerRoot = path.resolve(process.env.TOKENS_OUTER_ROOT ?? "");
const harnessRoot = path.join(outerRoot, "desktop", "deepseek-harness");
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const hostSpec = path.join(pluginRoot, "test", "host-runtime.spec.ts").replaceAll("\\", "/");
const { default: tsconfigPaths } = await import(pathToFileURL(path.join(
  harnessRoot,
  "node_modules",
  "vite-tsconfig-paths",
  "dist",
  "index.js",
)));
const { standardDecoratorPlugin } = await import(pathToFileURL(path.join(harnessRoot, "vitest.shared.ts")));

export default {
  root: harnessRoot,
  plugins: [
    tsconfigPaths({ projects: [path.join(harnessRoot, "tsconfig.base.json")] }),
    standardDecoratorPlugin(),
  ],
  resolve: {
    alias: {
      "@deepseek-ai/cordis": path.join(harnessRoot, "vendor", "cordis", "src", "index.ts"),
      "@deepseek-ai/schemastery": path.join(harnessRoot, "vendor", "schemastery", "src", "index.ts"),
      "@deepseek-ai/dsh-settings": path.join(pluginRoot, "test", "host-settings-compat.ts"),
      "@tokens-host/dsh-settings": path.join(harnessRoot, "packages", "settings", "settings", "src", "index.ts"),
      "@deepseek-ai/dsh-system-prompt": path.join(harnessRoot, "packages", "core", "system-prompt", "src", "index.ts"),
      "@deepseek-ai/dsh-tools": path.join(harnessRoot, "packages", "core", "tools", "src", "index.ts"),
      "@deepseek-ai/dsh-web": path.join(harnessRoot, "packages", "web", "web", "src", "index.ts"),
      "@deepseek-ai/dsh-tool-web": path.join(harnessRoot, "packages", "web", "tool-web", "src", "index.ts"),
    },
  },
  test: {
    include: [hostSpec],
    environment: "node",
    pool: "forks",
    testTimeout: 30_000,
  },
};
