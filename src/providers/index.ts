/** Provider metadata only; all providers share the transport. */
import { DEFAULT_BASE_URL } from "./base.ts";
export * from "./base.ts";

export interface Provider {
  readonly name: string;
  readonly base_url: string;
  readonly api_key_env: string;
  readonly default_model: string | null;
  readonly supports_responses: boolean;
}

export const CORAL: Provider = Object.freeze({
  name: "coral",
  base_url: DEFAULT_BASE_URL,
  api_key_env: "CORALBRICKS_API_KEY",
  default_model: "deepseek-v4.1-flash-fast",
  supports_responses: true,
});

// Like Python's module-level table, the default export captures the import-time env.
export const OPENAI: Provider = Object.freeze({
  name: "openai",
  base_url: "https://api.openai.com",
  api_key_env: "OPENAI_API_KEY",
  default_model: process.env.GOBY_MODEL ?? "gpt-4.1",
  supports_responses: true,
});

export const PROVIDERS: Readonly<Record<string, Provider>> = Object.freeze({
  coral: CORAL, openai: OPENAI,
});

export function resolve_provider(
  name?: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Provider {
  const key = (name || env.GOBY_PROVIDER || CORAL.name).trim().toLowerCase();
  // Own-property lookup avoids accepting JS prototype names as providers.
  if (!Object.hasOwn(PROVIDERS, key)) {
    throw new Error(`unknown provider '${key}' — known providers: coral, openai`);
  }
  const provider = PROVIDERS[key]!;
  if (key === "openai" && env !== process.env) {
    return Object.freeze({ ...provider, default_model: env.GOBY_MODEL ?? "gpt-4.1" });
  }
  return provider;
}
