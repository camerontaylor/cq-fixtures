import { constants, openSync, fstatSync, writeSync, closeSync } from 'node:fs';
export type LifecyclePhase = 'trigger-timer' | 'trigger-close' | 'trigger-error' | 'terminate-start' | 'terminate-reused' | 'terminate-done' | 'terminate-error' | 'session-stop-start' | 'session-stop-done' | 'session-stop-error' | 'dispose-start' | 'dispose-done' | 'dispose-error' | 'finalize-start' | 'export-start' | 'export-done' | 'publication-start' | 'publication-done' | 'cleanup-start' | 'cleanup-done' | 'finalize-error' | 'control-close' | 'runtime-abort' | 'runtime-cleanup-start' | 'runtime-cleanup-done' | 'runtime-cleanup-error';
export type LifecycleRecord = (phase: LifecyclePhase, error?: unknown) => void;
/** Trusted private path only. Never serialize error messages, command args, outputs or auth. */
export function privateLifecycleRecorder(path: string): LifecycleRecord {
  return (phase, error) => {
    const value = error as { name?: unknown; code?: unknown; message?: unknown } | undefined;
    const errorClass = ['Error','TypeError','RangeError','AbortError','DaemonPreregistrationMismatch','DeadlineExceeded','OutputLimitExceeded','DockerOperationFailed'].includes(String(value?.name)) ? value?.name : error === undefined ? undefined : 'unknown';
    const code = ['EACCES','EPERM','ENOENT','ESRCH','ETIMEDOUT','ERR_INVALID_ARG_TYPE'].includes(String(value?.code)) ? value?.code : error === undefined ? undefined : 'unknown';
    const docker = typeof value?.message === 'string' ? /^bounded Docker operation failed \((info|inspect|ps|rm|volume|network|run|exec|create|start), (null|-?[0-9]+)\)$/.exec(value.message) : null;
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (s.size > 1024 * 1024 || !s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.()) throw new Error('private lifecycle evidence ownership changed');
      writeSync(fd, JSON.stringify({ schemaVersion:1, at:new Date().toISOString(), phase, ...(error === undefined ? {} : { errorClass, code, ...(docker ? { operation:docker[1], exitCode:docker[2] === 'null' ? null : Number(docker[2]) } : {}) }) }) + '\n');
    } finally { closeSync(fd); }
  };
}
