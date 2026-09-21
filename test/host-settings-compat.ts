import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";

export * from "@tokens-host/dsh-settings";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;

export function settingsNamespace(value: string): string {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
  }
  return value;
}

export function installSettingsSection<T>(
  ctx: Context,
  ns: string,
  schema: z<T>,
  entry: T,
  hooks: object,
): void {
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks);
  });
}
