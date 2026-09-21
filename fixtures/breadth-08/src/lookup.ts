import type { Profile } from './types.ts';

export function cityOf(profile: Profile | undefined): string {
  return profile!.address?.city ?? 'unknown';
}
