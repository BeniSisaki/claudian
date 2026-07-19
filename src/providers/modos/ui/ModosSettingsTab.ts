import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { maybeGetModosWorkspaceServices } from '../app/ModosWorkspaceServices';
import { ModosModelDiscoveryService } from '../runtime/ModosModelDiscoveryService';
import type { ModosApprovalPolicy, ModosSandboxMode } from '../settings';
import { getModosProviderSettings, updateModosProviderSettings } from '../settings';

export const modosSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const modosSettings = getModosProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetModosWorkspaceServices();
    const rerender = (): void => {
      container.empty();
      modosSettingsTabRenderer.render(container, context);
    };

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName(t('settings.modos.enable.name'))
      .setDesc(t('settings.modos.enable.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(modosSettings.enabled)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, 'modos', value);
            });
            context.refreshModelSelectors();
            context.refreshTitleGenerationModelOptions();
          })
      );

    /* ---------------------------- Connection ---------------------------- */

    new Setting(container).setName(t('settings.modos.connection.heading')).setHeading();

    new Setting(container)
      .setName(t('settings.modos.connection.mode'))
      .setDesc(t('settings.modos.connection.modeDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            managed: t('settings.modos.connection.modeManaged'),
            paired: t('settings.modos.connection.modePaired'),
          })
          .setValue(modosSettings.connectionMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, {
                connectionMode: value === 'paired' ? 'paired' : 'managed',
              });
            });
            rerender();
          })
      );

    if (modosSettings.connectionMode === 'paired') {
      renderPairedSection(container, context, rerender);
    }

    if (modosSettings.connectionMode === 'managed') {
      renderManagedSections(container, context, modosSettings, hostnameKey, workspace);
    }

    renderSharedSections(container, context, modosSettings, workspace);
  },
};

function renderPairedSection(
  container: HTMLElement,
  context: Parameters<ProviderSettingsTabRenderer['render']>[1],
  rerender: () => void,
): void {
  const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
  const modosSettings = getModosProviderSettings(settingsBag);
  const baseUrl = `http://${modosSettings.pairedHost}:${modosSettings.pairedPort}`;

    new Setting(container)
      .setName(t('settings.modos.connection.host'))
      .addText((text) =>
        text
          .setPlaceholder('127.0.0.1')
          .setValue(modosSettings.pairedHost)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, {
                pairedHost: value.trim() || '127.0.0.1',
              });
            });
          })
      );

    new Setting(container)
      .setName(t('settings.modos.connection.port'))
      .addText((text) =>
        text
          .setPlaceholder('18899')
          .setValue(String(modosSettings.pairedPort))
          .onChange(async (value) => {
            const port = Number.parseInt(value.trim(), 10);
            if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
              return;
            }
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, { pairedPort: port });
            });
          })
      );

    if (modosSettings.pairedDeviceToken) {
      new Setting(container)
        .setName(t('settings.modos.connection.paired', { deviceId: modosSettings.pairedDeviceId }))
        .setDesc(t('settings.modos.connection.unpairDesc'))
        .addButton((button) =>
          button
            .setButtonText(t('settings.modos.connection.unpair'))
            .onClick(async () => {
              await context.plugin.mutateSettings((settings) => {
                updateModosProviderSettings(settings, {
                  connectionMode: 'managed',
                  pairedDeviceId: '',
                  pairedDeviceToken: '',
                });
              });
              rerender();
            })
        );
      return;
    }

    const statusEl = container.createDiv({ cls: 'claudian-modos-pair-status' });
    let codeInput = '';
    new Setting(container)
      .setName(t('settings.modos.connection.pairingCode'))
      .setDesc(t('settings.modos.connection.pairingCodeDesc'))
      .addText((text) =>
        text
          .onChange((value) => {
            codeInput = value.trim();
          })
      )
      .addButton((button) =>
        button
          .setButtonText(t('settings.modos.connection.pair'))
          .onClick(async () => {
            button
              .setDisabled(true)
              .setButtonText(t('settings.modos.connection.pairing'));
            try {
              try {
                const health = await fetch(`${baseUrl}/health`, {
                  signal: AbortSignal.timeout(2_000),
                });
                if (!health.ok) {
                  throw new Error(`HTTP ${health.status}`);
                }
              } catch {
                statusEl.setText(t('settings.modos.connection.appUnreachable', { url: baseUrl }));
                return;
              }

              const response = await fetch(`${baseUrl}/v1/devices/pair`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  code: codeInput,
                  deviceName: 'Claudian Obsidian',
                  platform: 'obsidian',
                }),
              });
              if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
              }
              const paired = (await response.json()) as { deviceId: string; token: string };
              await context.plugin.mutateSettings((settings) => {
                updateModosProviderSettings(settings, {
                  pairedDeviceId: paired.deviceId,
                  pairedDeviceToken: paired.token,
                });
              });
              rerender();
            } catch (error) {
              statusEl.setText(t('settings.modos.connection.pairFailed', {
                error: error instanceof Error ? error.message : String(error),
              }));
            } finally {
              button
                .setDisabled(false)
                .setButtonText(t('settings.modos.connection.pair'));
            }
          })
      );
}

function renderManagedSections(
  container: HTMLElement,
  context: Parameters<ProviderSettingsTabRenderer['render']>[1],
  modosSettings: ReturnType<typeof getModosProviderSettings>,
  hostnameKey: string,
  workspace: ReturnType<typeof maybeGetModosWorkspaceServices>,
): void {

    const cliPathsByHost = { ...modosSettings.cliPathsByHost };
    const persistCliPath = async (value: string): Promise<void> => {
      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateModosProviderSettings(settings, {
          cliPathsByHost: { ...cliPathsByHost },
        });
        workspace?.cliResolver?.reset();
      });
    };

    new Setting(container)
      .setName(t('settings.modos.cliPath.name'))
      .setDesc(t('settings.modos.cliPath.desc'))
      .addText((text) => {
        text
          .setPlaceholder(process.platform === 'win32'
            ? t('settings.modos.cliPath.placeholderWindows')
            : t('settings.modos.cliPath.placeholderUnix'))
          .setValue(modosSettings.cliPathsByHost[hostnameKey] || '')
          .onChange((value) => {
            void persistCliPath(value);
          });
      });

    new Setting(container)
      .setName(t('settings.modos.dataDir.name'))
      .setDesc(t('settings.modos.dataDir.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.modos.dataDir.placeholder'))
          .setValue(modosSettings.dataDir)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, { dataDir: value.trim() });
            });
          });
      });

    new Setting(container)
      .setName(t('settings.modos.approvalPolicy.name'))
      .setDesc(t('settings.modos.approvalPolicy.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            'on-request': t('settings.modos.approvalPolicy.options.on-request'),
            auto: t('settings.modos.approvalPolicy.options.auto'),
            untrusted: t('settings.modos.approvalPolicy.options.untrusted'),
            never: t('settings.modos.approvalPolicy.options.never'),
            always: t('settings.modos.approvalPolicy.options.always'),
            suggest: t('settings.modos.approvalPolicy.options.suggest'),
          })
          .setValue(modosSettings.approvalPolicy)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, {
                approvalPolicy: value as ModosApprovalPolicy,
              });
            });
          })
      );

    new Setting(container)
      .setName(t('settings.modos.sandboxMode.name'))
      .setDesc(t('settings.modos.sandboxMode.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            'workspace-write': t('settings.modos.sandboxMode.options.workspace-write'),
            'read-only': t('settings.modos.sandboxMode.options.read-only'),
            'danger-full-access': t('settings.modos.sandboxMode.options.danger-full-access'),
            'external-sandbox': t('settings.modos.sandboxMode.options.external-sandbox'),
          })
          .setValue(modosSettings.sandboxMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, {
                sandboxMode: value as ModosSandboxMode,
              });
            });
          })
      );

    new Setting(container).setName(t('settings.modos.runtime.heading')).setHeading();

    const statusEl = container.createDiv({ cls: 'claudian-modos-runtime-status' });
    const serveManager = workspace?.serveManager;
    statusEl.setText(
      serveManager?.isRunning()
        ? t('settings.modos.runtime.running', {
          url: serveManager.getConnection()?.baseUrl ?? 'loopback',
        })
        : t('settings.modos.runtime.notRunning'),
    );

    new Setting(container)
      .setName(t('settings.modos.runtime.restart'))
      .setDesc(t('settings.modos.runtime.restartDesc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.modos.runtime.restart'))
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await serveManager?.shutdown();
              statusEl.setText(t('settings.modos.runtime.stopped'));
            } finally {
              button.setDisabled(false);
            }
          })
      );
}

function renderSharedSections(
  container: HTMLElement,
  context: Parameters<ProviderSettingsTabRenderer['render']>[1],
  modosSettings: ReturnType<typeof getModosProviderSettings>,
  _workspace: ReturnType<typeof maybeGetModosWorkspaceServices>,
): void {
    new Setting(container).setName(t('settings.modos.models.heading')).setHeading();

    const statusEl = container.createDiv({ cls: 'claudian-modos-runtime-status' });
    const discovered = modosSettings.discoveredModels;
    new Setting(container)
      .setName(t('settings.modos.models.visible'))
      .setDesc(
        discovered.length > 0
          ? t('settings.modos.models.visibleSome', {
            models: discovered.map((model) => model.label).join(', '),
          })
          : t('settings.modos.models.visibleNone'),
      )
      .addButton((button) =>
        button
          .setButtonText(t('settings.modos.models.discover'))
          .onClick(async () => {
            button
              .setDisabled(true)
              .setButtonText(t('settings.modos.models.discovering'));
            try {
              const result = await new ModosModelDiscoveryService(context.plugin).discoverModels();
              statusEl.setText(
                result.kind === 'completed'
                  ? result.models.length > 0
                    ? t('settings.modos.models.discovered', {
                      models: result.models.map((model) => model.label).join(', '),
                    })
                    : t('settings.modos.models.noneFound')
                  : t('settings.modos.models.failed', {
                    error: result.diagnostics ?? 'unknown error',
                  }),
              );
              context.refreshModelSelectors();
            } finally {
              button
                .setDisabled(false)
                .setButtonText(t('settings.modos.models.discover'));
            }
          })
      );

    renderEnvironmentSettingsSection({
      container,
      desc: t('settings.modos.env.desc'),
      heading: t('settings.modos.env.heading'),
      name: t('settings.modos.env.name'),
      placeholder: t('settings.modos.env.placeholder'),
      plugin: context.plugin,
      scope: 'provider:modos',
    });
}
