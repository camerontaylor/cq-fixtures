import type { Config } from './types.ts';

export function withDefaults(partial: Partial<Config>, retries?: number): Config {
  return { verbose: false, retries: retries as number, ...partial };
}
