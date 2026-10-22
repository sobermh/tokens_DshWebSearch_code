/**
 * Resolve hook that points every `@deepseek-ai/*` specifier at one staged host.
 *
 * The plugin ships with those packages as optional peers, so nothing in this
 * repository installs them. The host-contract cases must exercise the copies the
 * product actually ships, which live in a staged host's `node_modules`. The hook
 * is read-only: it rewrites nothing else, so the plugin's own modules still load
 * from the work tree (HOST-005 asserts exactly that).
 *
 * `register()` runs this in its own thread, so the host root arrives through the
 * `data` argument rather than an environment variable.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

let hostRequire;

export function initialize(data) {
  hostRequire = createRequire(path.join(data.hostRoot, "package.json"));
}

export function resolve(specifier, context, nextResolve) {
  if (hostRequire !== undefined && (specifier === "@deepseek-ai" || specifier.startsWith("@deepseek-ai/"))) {
    try {
      return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true };
    } catch {
      // Not shipped by this host generation; let Node report the real failure so
      // a case can report "this host has no such package" instead of a mystery.
    }
  }
  return nextResolve(specifier, context);
}
