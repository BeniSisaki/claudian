import { type ChildProcessByStdio,spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderCliResolver } from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '../../../utils/windowsCmdShim';
import { getModosProviderSettings } from '../settings';

const MODOS_READY_PREFIX = 'MODOS_READY ';
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const SIGKILL_TIMEOUT_MS = 3_000;
const STDERR_BUFFER_LIMIT = 8_000;

export interface ModosServeConnection {
  baseUrl: string;
  host: string;
  port: number;
  token: string;
}

type ModosServeChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Owns the shared `modos serve` child process for the whole plugin. Every
 * chat runtime and auxiliary service talks to this single instance; the
 * process is relaunched when the launch-relevant settings change. The
 * bearer token is minted per launch and passed via the environment so it
 * never appears in the process argument list.
 */
export class ModosServeManager {
  private connection: ModosServeConnection | null = null;
  private launchKey: string | null = null;
  private proc: ModosServeChild | null = null;
  private resolvedSpawnSpec: WindowsCmdShimSpawnSpec | null = null;
  private starting: Promise<ModosServeConnection> | null = null;
  private stderrBuffer = '';

  constructor(
    private readonly plugin: ProviderHost,
    private readonly cliResolver?: ProviderCliResolver | null,
  ) {}

  getConnection(): ModosServeConnection | null {
    return this.connection;
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  getDiagnostics(): string {
    return this.stderrBuffer.trim();
  }

  async ensureReady(): Promise<ModosServeConnection> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const modosSettings = getModosProviderSettings(settings);

    if (modosSettings.connectionMode === 'paired') {
      return this.ensurePairedConnection(modosSettings);
    }

    const command = (await this.plugin.getResolvedProviderCliPath('modos'))
      ?? (await this.cliResolver?.resolveFromSettings(settings))
      ?? 'modos';
    const envText = getRuntimeEnvironmentText(settings, 'modos');
    const dataDir = modosSettings.dataDir || join(homedir(), '.modos', 'data');
    const launchKey = JSON.stringify({
      approvalPolicy: modosSettings.approvalPolicy,
      command,
      dataDir,
      envText,
      sandboxMode: modosSettings.sandboxMode,
    });

    if (this.connection && this.isRunning() && this.launchKey === launchKey) {
      return this.connection;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.restart({
      approvalPolicy: modosSettings.approvalPolicy,
      command,
      dataDir,
      envText,
      launchKey,
      sandboxMode: modosSettings.sandboxMode,
    });
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Paired mode: drive the already-running MODOS desktop app's serve with a
   * paired device token. No child process is spawned; any managed process
   * left over from managed mode is stopped. The app's `/health` endpoint is
   * unauthenticated, so it doubles as the "is the app running" probe.
   */
  private async ensurePairedConnection(
    modosSettings: ReturnType<typeof getModosProviderSettings>,
  ): Promise<ModosServeConnection> {
    await this.shutdown();
    if (!modosSettings.pairedDeviceToken) {
      throw new Error('No paired MODOS device. Pair with the desktop app first (Modos settings → Connection).');
    }
    const host = modosSettings.pairedHost;
    const port = modosSettings.pairedPort;
    const baseUrl = `http://${host}:${port}`;
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      throw new Error(
        `The MODOS app is not reachable at ${baseUrl}. Start the desktop app, or switch back to the managed runtime`,
        { cause: error },
      );
    }
    return { baseUrl, host, port, token: modosSettings.pairedDeviceToken };
  }

  async shutdown(): Promise<void> {
    this.connection = null;
    this.launchKey = null;
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let killTimer: number | null = null;
      let finalTimer: number | null = null;
      const onClose = () => {
        if (killTimer) window.clearTimeout(killTimer);
        if (finalTimer) window.clearTimeout(finalTimer);
        resolve();
      };
      killTimer = window.setTimeout(() => {
        terminateSpawnedProcess(proc, 'SIGKILL', spawn, this.resolvedSpawnSpec);
        finalTimer = window.setTimeout(onClose, SIGKILL_TIMEOUT_MS);
      }, SIGKILL_TIMEOUT_MS);
      proc.once('exit', onClose);
      terminateSpawnedProcess(proc, 'SIGTERM', spawn, this.resolvedSpawnSpec);
    });
  }

  private async restart(launch: {
    approvalPolicy: string;
    command: string;
    dataDir: string;
    envText: string;
    launchKey: string;
    sandboxMode: string;
  }): Promise<ModosServeConnection> {
    await this.shutdown();

    const port = await pickFreePort();
    const token = randomUUID();
    const args = [
      'serve',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--data-dir', launch.dataDir,
      '--approval-policy', launch.approvalPolicy,
      '--sandbox-mode', launch.sandboxMode,
      // The JSONL file backend avoids loading better-sqlite3, whose ABI must
      // match the spawning Node (Obsidian's Electron Node ≠ system Node).
      '--storage-backend', 'file',
    ];
    const env = {
      ...process.env,
      ...parseEnvironmentVariables(launch.envText || ''),
      MODOS_RUNTIME_TOKEN: token,
    };

    const spawnSpec = resolveWindowsCmdShimSpawnSpec({ args, command: launch.command });
    this.resolvedSpawnSpec = spawnSpec;
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    this.proc = proc;
    this.stderrBuffer = '';

    proc.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-STDERR_BUFFER_LIMIT);
    });

    const connection: ModosServeConnection = {
      baseUrl: `http://127.0.0.1:${port}`,
      host: '127.0.0.1',
      port,
      token,
    };

    await this.waitForReady(proc, connection);
    this.connection = connection;
    this.launchKey = launch.launchKey;

    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null;
        this.connection = null;
        this.launchKey = null;
      }
    });

    return connection;
  }

  private async waitForReady(
    proc: ModosServeChild,
    connection: ModosServeConnection,
  ): Promise<void> {
    let stdoutBuffer = '';
    let sawReadyLine = false;
    proc.stdout.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      stdoutBuffer = `${stdoutBuffer}${text}`.slice(-STDERR_BUFFER_LIMIT);
      if (!sawReadyLine && stdoutBuffer.includes(MODOS_READY_PREFIX)) {
        sawReadyLine = true;
      }
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(
          `modos serve exited during startup (code ${proc.exitCode})${this.formatStderr()}`,
        );
      }
      try {
        const response = await fetch(`${connection.baseUrl}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => window.setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }

    throw new Error(
      `modos serve did not become ready within ${STARTUP_TIMEOUT_MS}ms`
      + `${sawReadyLine ? '' : ' (no MODOS_READY line seen)'}`
      + `${lastError instanceof Error ? `; last health probe: ${lastError.message}` : ''}`
      + this.formatStderr(),
    );
  }

  private formatStderr(): string {
    const stderr = this.getDiagnostics();
    return stderr ? `\n\nmodos stderr:\n${stderr}` : '';
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a loopback port for modos serve'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
