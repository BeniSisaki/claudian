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

    new Setting(container).setName(t('settings.modos.runtime.heading')).setHeading();

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

    renderEnvironmentSettingsSection({
      container,
      desc: t('settings.modos.env.desc'),
      heading: t('settings.modos.env.heading'),
      name: t('settings.modos.env.name'),
      placeholder: t('settings.modos.env.placeholder'),
      plugin: context.plugin,
      scope: 'provider:modos',
    });
  },
};
