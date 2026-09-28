import { DockerControl, teardownContainer } from './docker-control.ts';
import { exportStoppedTask, validateStageReceipt } from './task-staging.ts';
import type { TaskStageReceipt } from './task-staging.ts';

/** Native runSupervised must await terminate on close, timeout, cancellation and
 * spawn failure, then finalize. Killing its Docker exec client is insufficient.
 * This contract deliberately does not impersonate visible-calibration receipts.
 */
export function containerTaskSession(input: TaskStageReceipt, containerId: string) {
  const receipt = structuredClone(input);
  validateStageReceipt(receipt);
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('exact private container ID required');
  const control = new DockerControl();
  let termination: Promise<void> | undefined;
  let exported = false;
  const terminate = () => termination ??= (async () => {
    if (await control.run(['info', '--format', '{{.ID}}']) !== receipt.daemonId) throw new Error('session daemon changed');
    const ids = await control.run(['ps', '-aq', '--no-trunc', '--filter', `id=${containerId}`]);
    if (ids) {
      const c = JSON.parse(await control.run(['inspect', containerId]))[0];
      if (!c.Mounts?.some((m: { Name?: string; Destination: string }) => m.Name === receipt.taskVolume && m.Destination === '/task')) throw new Error('session container does not own intended task');
    }
    await teardownContainer(control, containerId);
  })();
  return {
    scope: 'boundary-unverified' as const, heldOut: false as const, taskIdentity: receipt.taskIdentity,
    terminate,
    async finalize(destination: string) {
      if (exported) throw new Error('task already exported');
      await terminate();
      const result = await exportStoppedTask(control, receipt, destination);
      exported = true;
      return result;
    },
    /** Explicit cleanup after export acceptance; failed exports retain private volumes. */
    async cleanup() {
      await terminate();
      if (!exported) throw new Error('export must succeed before task cleanup');
      for (const volume of [receipt.taskVolume, receipt.contextVolume]) {
        const m = JSON.parse(await control.run(['volume', 'inspect', volume]))[0];
        if (m.Labels?.['cq.boundary.staging'] !== receipt.receiptHash || (await control.run(['ps', '-aq', '--filter', `volume=${volume}`]))) throw new Error('private volume cleanup ownership unverified');
        await control.run(['volume', 'rm', volume]);
      }
      control.close();
    },
    closeControl: () => control.close(),
  };
}
