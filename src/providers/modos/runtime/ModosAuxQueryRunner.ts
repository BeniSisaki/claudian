import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { resolveWindowsCmdShimSpawnSpec, terminateSpawnedProcess } from '../../../utils/windowsCmdShim';
import { getModosProviderSettings } from '../settings';

const AUX_QUERY_TIMEOUT_MS = 120_000;

/**
 * One-shot auxiliary query runner: every query spawns `modos run` and
 * streams back assistant text. Intentionally independent from the chat
 * runtime's serve process (mirrors PiAuxQueryRunner's ownership), so title
 * generation and inline edits never interfere with an active conversation.
 *
 * Note: one-shot processes carry no conversational memory across query()
 * calls; services that need continuity should be switched to a thread-backed
 * runner over the HTTP API.
 */
export class ModosAuxQueryRunner implements AuxQueryRunner {
  constructor(private readonly plugin: ProviderHost) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const modosSettings = getModosProviderSettings(settings);
    const command = await this.plugin.getResolvedProviderCliPath('modos') ?? 'modos';
    const envText = getRuntimeEnvironmentText(settings, 'modos');
    const dataDir = modosSettings.dataDir || join(homedir(), '.modos', 'data');
    const workspace = getVaultPath(this.plugin.app) ?? process.cwd();

    const args = [
      'run',
      '--data-dir', dataDir,
      '--workspace', workspace,
      '--approval-policy', 'never',
      ...(config.model?.trim() ? ['--model', config.model.trim()] : []),
      prompt,
    ];
    const env = {
      ...process.env,
      ...parseEnvironmentVariables(envText || ''),
    };

    return new Promise<string>((resolve, reject) => {
      const spawnSpec = resolveWindowsCmdShimSpawnSpec({ args, command });
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const abortSignal = config.abortController?.signal;
      const timeout = window.setTimeout(() => {
        finish(new Error('Modos aux query timed out'));
        terminateSpawnedProcess(proc, 'SIGTERM', spawn, spawnSpec);
      }, AUX_QUERY_TIMEOUT_MS);

      const finish = (error: Error | null, text?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        abortSignal?.removeEventListener('abort', onAbort);
        if (error) {
          reject(error);
        } else {
          resolve((text ?? stdout).trim());
        }
      };
      const onAbort = (): void => {
        terminateSpawnedProcess(proc, 'SIGTERM', spawn, spawnSpec);
        finish(new Error('Modos aux query aborted'));
      };

      proc.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        config.onTextChunk?.(stdout);
      });
      proc.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${typeof chunk === 'string' ? chunk : chunk.toString('utf-8')}`
          .slice(-8_000);
      });
      proc.on('error', (error) => finish(error));
      proc.on('exit', (code) => {
        if (code === 0) {
          finish(null, stdout);
        } else {
          finish(new Error(
            `modos run exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ));
        }
      });
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  reset(): void {
    // One-shot runner: no process or conversation state to clear.
  }
}
