import { homedir } from 'node:os';
import { join } from 'node:path';

/** Prospective historical pin proposal, NOT current daemon qualification. PK00
 * must independently verify and freeze it before any live admission. */
export const G2_DAEMON_PROFILE = 'cq-boundary-s5';
export const G2_EXPECTED_DAEMON_ID = 'e15e4bd0-8a2f-4f5b-b335-2bd18da11100';
export function g2DaemonEndpoint(home = homedir()): string {
  return `unix://${join(home, '.colima', G2_DAEMON_PROFILE, 'docker.sock')}`;
}
export function assertG2DaemonPreregistration(expected: string, observed: string): void {
  if (expected !== G2_EXPECTED_DAEMON_ID || observed !== expected) {
    const error = new Error('daemon differs from prospective preregistration');
    error.name = 'DaemonPreregistrationMismatch';
    throw error;
  }
}
