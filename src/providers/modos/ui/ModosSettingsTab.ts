import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
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

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName('Enable Modos')
      .setDesc('Launch `modos serve` and chat over its local HTTP + SSE runtime.')
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
      .setName('CLI path')
      .setDesc(
        'Optional absolute path to the Modos CLI for this computer. Leave empty to use `modos` from PATH.',
      )
      .addText((text) => {
        text
          .setPlaceholder(process.platform === 'win32'
            ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\modos.cmd'
            : '/usr/local/bin/modos')
          .setValue(modosSettings.cliPathsByHost[hostnameKey] || '')
          .onChange((value) => {
            void persistCliPath(value);
          });
      });

    new Setting(container)
      .setName('Data directory')
      .setDesc(
        'Optional MODOS data dir override (threads, sessions, usage). Leave empty for the default `~/.modos/data`.',
      )
      .addText((text) => {
        text
          .setPlaceholder('~/.modos/data')
          .setValue(modosSettings.dataDir)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateModosProviderSettings(settings, { dataDir: value.trim() });
            });
          });
      });

    new Setting(container)
      .setName('Approval policy')
      .setDesc('How tool approvals behave. `Ask before tools` surfaces approvals in chat.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            'on-request': 'Ask before tools',
            auto: 'Auto-approve',
            untrusted: 'Untrusted',
            never: 'Never ask',
            always: 'Always ask',
            suggest: 'Suggest',
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
      .setName('Sandbox mode')
      .setDesc('Filesystem sandbox applied to the Modos runtime.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            'workspace-write': 'Workspace write',
            'read-only': 'Read only',
            'danger-full-access': 'Full access',
            'external-sandbox': 'External sandbox',
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

    new Setting(container).setName('Models').setHeading();

    const statusEl = container.createDiv({ cls: 'claudian-modos-runtime-status' });
    const discovered = modosSettings.discoveredModels;
    new Setting(container)
      .setName('Visible models')
      .setDesc(
        discovered.length > 0
          ? `Discovered from the Modos runtime: ${discovered.map((model) => model.label).join(', ')}`
          : 'No models discovered yet. Click Discover to launch modos serve and read the configured model.',
      )
      .addButton((button) =>
        button
          .setButtonText('Discover')
          .onClick(async () => {
            button.setDisabled(true).setButtonText('Discovering…');
            try {
              const result = await new ModosModelDiscoveryService(context.plugin).discoverModels();
              statusEl.setText(
                result.kind === 'completed'
                  ? result.models.length > 0
                    ? `Discovered: ${result.models.map((model) => model.label).join(', ')}`
                    : 'Modos serve is running but reported no model.'
                  : `Discovery failed: ${result.diagnostics ?? 'unknown error'}`,
              );
              context.refreshModelSelectors();
            } finally {
              button.setDisabled(false).setButtonText('Discover');
            }
          })
      );

    new Setting(container).setName('Runtime').setHeading();

    const serveManager = workspace?.serveManager;
    statusEl.setText(
      serveManager?.isRunning()
        ? `modos serve is running on ${serveManager.getConnection()?.baseUrl ?? 'loopback'}.`
        : 'modos serve is not running yet. It starts on the first chat turn or Discover click.',
    );

    new Setting(container)
      .setName('Restart runtime')
      .setDesc('Stops the shared Modos serve process. It relaunches on the next chat turn.')
      .addButton((button) =>
        button
          .setButtonText('Restart')
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await serveManager?.shutdown();
              statusEl.setText('Modos serve stopped. It relaunches on the next chat turn.');
            } finally {
              button.setDisabled(false);
            }
          })
      );

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Modos (e.g. `DEEPSEEK_API_KEY`, `MODOS_MODEL`).',
      heading: 'Environment',
      name: 'Modos environment variables',
      placeholder: 'DEEPSEEK_API_KEY=sk-...',
      plugin: context.plugin,
      scope: 'provider:modos',
    });
  },
};
