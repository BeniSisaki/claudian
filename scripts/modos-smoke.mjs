// scripts/modos-smoke-prelude.ts
var globalRef = globalThis;
if (typeof globalRef.window === "undefined") {
  globalRef.window = {
    clearTimeout: globalRef.clearTimeout,
    crypto: globalRef.crypto,
    localStorage: null,
    setTimeout: globalRef.setTimeout
  };
}

// src/providers/modos/runtime/ModosHttpClient.ts
var SSE_RECONNECT_DELAY_MS = 500;
var ModosHttpError = class extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "ModosHttpError";
  }
};
var ModosSseOverflowError = class extends Error {
  constructor(message = "SSE replay overflow") {
    super(message);
    this.name = "ModosSseOverflowError";
  }
};
var ModosHttpClient = class {
  constructor(connection, fetchImpl = fetch) {
    this.connection = connection;
    this.fetchImpl = fetchImpl;
  }
  get baseUrl() {
    return this.connection.baseUrl;
  }
  get token() {
    return this.connection.token;
  }
  async get(path, signal) {
    return this.request("GET", path, void 0, signal);
  }
  async post(path, body, signal, headers) {
    return this.request("POST", path, body, signal, headers);
  }
  async patch(path, body, signal) {
    return this.request("PATCH", path, body, signal);
  }
  async delete(path, signal) {
    return this.request("DELETE", path, void 0, signal);
  }
  async request(method, path, body, signal, headers) {
    let response;
    try {
      response = await this.fetchImpl(`${this.connection.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          ...body !== void 0 ? { "content-type": "application/json" } : {},
          ...headers ?? {}
        },
        ...body !== void 0 ? { body: JSON.stringify(body) } : {},
        ...signal ? { signal } : {}
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ModosHttpError(
        `modos serve unreachable: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    }
    const text = await response.text();
    let parsed = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const errorBody = isRecord(parsed) ? parsed : {};
      throw new ModosHttpError(
        typeof errorBody.message === "string" ? errorBody.message : `modos serve responded with HTTP ${response.status}`,
        response.status,
        typeof errorBody.code === "string" ? errorBody.code : void 0,
        "details" in errorBody ? errorBody.details : void 0
      );
    }
    return parsed;
  }
  /**
   * Streams thread events, transparently reconnecting with the last cursor
   * when the server closes a replay page. Heartbeats are yielded like any
   * other event but never advance the cursor. Throws ModosSseOverflowError
   * when the server signals replay overflow, and ModosHttpError on
   * auth/not-found failures (both are terminal for the stream).
   *
   * Implemented as a single generator without `yield*` delegation on
   * purpose: the plugin ships with downleveled async generators (ES2018),
   * where delegation mishandles early consumer return().
   */
  async *streamEvents(threadId, sinceSeq, signal) {
    let cursor = Math.max(0, Math.floor(sinceSeq));
    for (; ; ) {
      if (signal.aborted) {
        return;
      }
      let response;
      try {
        response = await this.fetchImpl(
          `${this.connection.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=${cursor}`,
          {
            headers: { authorization: `Bearer ${this.connection.token}` },
            signal
          }
        );
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        throw new ModosHttpError(
          `modos SSE connect failed: ${error instanceof Error ? error.message : String(error)}`,
          0
        );
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ModosHttpError(
          `modos SSE responded with HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
          response.status
        );
      }
      if (!response.body) {
        throw new ModosHttpError("modos SSE response has no body", 0);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let outcome = "eof";
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseSseFrame(rawFrame);
            if (!frame) {
              continue;
            }
            if (frame.kind === "error" && frame.seq === null) {
              outcome = "overflow";
              break;
            }
            if (frame.kind !== "heartbeat" && frame.seq !== null) {
              cursor = Math.max(cursor, frame.seq);
            }
            yield frame;
          }
          if (outcome === "overflow") {
            break;
          }
          if (signal.aborted) {
            outcome = "aborted";
            break;
          }
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          outcome = "aborted";
        } else {
          throw error;
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
        }
        reader.releaseLock();
      }
      if (outcome === "aborted") {
        return;
      }
      if (outcome === "overflow") {
        throw new ModosSseOverflowError();
      }
      try {
        await delay(SSE_RECONNECT_DELAY_MS, signal);
      } catch {
        return;
      }
    }
  }
};
function parseSseFrame(rawFrame) {
  let kind = "message";
  let seq = null;
  const dataLines = [];
  for (const line of rawFrame.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "id") {
      const parsed = Number.parseInt(value, 10);
      seq = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } else if (field === "event") {
      kind = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  const rawData = dataLines.join("\n");
  let data = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
  }
  return { data, kind, seq };
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/providers/modos/runtime/ModosServeProcess.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// src/utils/env.ts
import * as os from "os";
var isWindows = process.platform === "win32";
var DEVICE_SETTINGS_STORAGE_KEY = "claudian.deviceSettingsKey";
var cachedDeviceSettingsKey = null;
function parseEnvironmentVariables(input) {
  const result = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eqIndex = normalized.indexOf("=");
    if (eqIndex > 0) {
      const key = normalized.substring(0, eqIndex).trim();
      let value = normalized.substring(eqIndex + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (key) {
        result[key] = value;
      }
    }
  }
  return result;
}
function getDeviceSettingsStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
function createOpaqueDeviceSettingsKey() {
  const cryptoApi = typeof window === "undefined" ? null : window.crypto;
  const randomUUID2 = cryptoApi?.randomUUID?.();
  if (randomUUID2) {
    return `device:${randomUUID2}`;
  }
  if (cryptoApi?.getRandomValues) {
    const randomBytes = new Uint8Array(16);
    cryptoApi.getRandomValues(randomBytes);
    const entropy2 = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `device:${Date.now().toString(36)}:${entropy2}`;
  }
  const entropy = Math.random().toString(36).slice(2);
  return `device:${Date.now().toString(36)}:${entropy}`;
}
function getHostnameKey() {
  if (cachedDeviceSettingsKey) {
    return cachedDeviceSettingsKey;
  }
  const storage = getDeviceSettingsStorage();
  const stored = storage?.getItem(DEVICE_SETTINGS_STORAGE_KEY)?.trim();
  if (stored) {
    cachedDeviceSettingsKey = stored;
    return cachedDeviceSettingsKey;
  }
  cachedDeviceSettingsKey = createOpaqueDeviceSettingsKey();
  try {
    storage?.setItem(DEVICE_SETTINGS_STORAGE_KEY, cachedDeviceSettingsKey);
  } catch {
  }
  return cachedDeviceSettingsKey;
}
function getLegacyHostnameKey() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}
function migrateLegacyHostnameKeyedMap(entries, currentKey, legacyHostnameKey) {
  if (!currentKey || !legacyHostnameKey || currentKey === legacyHostnameKey) {
    return entries;
  }
  const hasCurrentEntry = hasOwnEntry(entries, currentKey);
  const hasLegacyEntry = hasOwnEntry(entries, legacyHostnameKey);
  if (!hasLegacyEntry) {
    return entries;
  }
  const migrated = { ...entries };
  if (!hasCurrentEntry) {
    migrated[currentKey] = entries[legacyHostnameKey];
  }
  delete migrated[legacyHostnameKey];
  return migrated;
}
function hasOwnEntry(entries, key) {
  return Object.prototype.hasOwnProperty.call(entries, key) === true;
}

// src/core/providers/providerConfig.ts
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function getProviderConfig(settings, providerId) {
  const candidate = settings.providerConfigs;
  if (!isRecord2(candidate)) {
    return {};
  }
  const config = candidate[providerId];
  return isRecord2(config) ? { ...config } : {};
}

// src/core/providers/modelSelection.ts
var PROVIDER_MODEL_SELECTION_PREFIXES = {
  claude: "claude-code/",
  codex: "openai-codex/",
  modos: "modos/",
  opencode: "opencode/",
  pi: "pi/"
};
function decodeProviderModelSelectionId(value) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  for (const [providerId, prefix] of Object.entries(PROVIDER_MODEL_SELECTION_PREFIXES)) {
    if (!prefix || !normalized.startsWith(prefix)) {
      continue;
    }
    const modelId = normalized.slice(prefix.length).trim();
    if (!modelId) {
      return null;
    }
    return {
      providerId,
      modelId
    };
  }
  return null;
}

// src/core/providers/types.ts
var DEFAULT_CHAT_PROVIDER_ID = "claude";

// src/core/providers/ProviderRegistry.ts
var ProviderRegistry = class {
  static {
    this.registrations = {};
  }
  static register(providerId, registration) {
    this.registrations[providerId] = registration;
  }
  static getProviderRegistration(providerId) {
    const registration = this.registrations[providerId];
    if (!registration) {
      throw new Error(`Provider "${providerId}" is not registered.`);
    }
    return registration;
  }
  static createChatRuntime(options) {
    const providerId = options.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    return this.getProviderRegistration(providerId).createRuntime(options);
  }
  static createTitleGenerationService(plugin, providerId) {
    if (!providerId) {
      return new RoutedTitleGenerationService(plugin);
    }
    return this.getProviderRegistration(providerId).createTitleGenerationService(plugin);
  }
  static resolveTitleGenerationProviderId(settings) {
    const titleModel = typeof settings.titleGenerationModel === "string" ? settings.titleGenerationModel.trim() : "";
    if (!titleModel) {
      return DEFAULT_CHAT_PROVIDER_ID;
    }
    return this.resolveProviderForModel(titleModel, settings, {
      fallbackProviderId: DEFAULT_CHAT_PROVIDER_ID,
      onlyEnabledProviders: true
    });
  }
  static createInstructionRefineService(plugin, providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).createInstructionRefineService(plugin);
  }
  static createInlineEditService(plugin, providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).createInlineEditService(plugin);
  }
  static getConversationHistoryService(providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).historyService;
  }
  static getTaskResultInterpreter(providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).taskResultInterpreter;
  }
  static getSubagentLifecycleAdapter(providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).subagentLifecycleAdapter ?? null;
  }
  static getCapabilities(providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).capabilities;
  }
  static getEnvironmentKeyPatterns(providerId) {
    return this.getProviderRegistration(providerId).environmentKeyPatterns ?? [];
  }
  static getChatUIConfig(providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).chatUIConfig;
  }
  static getTitleGenerationModelOptions(settings) {
    const options = [];
    const seenValues = /* @__PURE__ */ new Set();
    for (const providerId of this.getRegisteredProviderIds()) {
      if (!this.isEnabled(providerId, settings)) {
        continue;
      }
      for (const option of this.getChatUIConfig(providerId).getModelOptions(settings)) {
        if (seenValues.has(option.value)) {
          continue;
        }
        seenValues.add(option.value);
        options.push(option);
      }
    }
    return options;
  }
  static getSettingsReconciler(providerId = DEFAULT_CHAT_PROVIDER_ID) {
    return this.getProviderRegistration(providerId).settingsReconciler;
  }
  static getSettingsStorageAdapter(providerId) {
    const registration = this.getProviderRegistration(providerId);
    if (!("settingsStorage" in registration)) {
      throw new Error(`Provider "${providerId}" does not own settings storage normalization.`);
    }
    return registration.settingsStorage;
  }
  static getRegisteredProviderIds() {
    return Object.keys(this.registrations);
  }
  static getEnabledProviderIds(settings) {
    return this.getRegisteredProviderIds().filter((providerId) => this.getProviderRegistration(providerId).isEnabled(settings)).sort((a, b) => this.getProviderRegistration(a).blankTabOrder - this.getProviderRegistration(b).blankTabOrder);
  }
  static getProviderDisplayName(providerId) {
    return this.getProviderRegistration(providerId).displayName;
  }
  static isEnabled(providerId, settings) {
    return this.getProviderRegistration(providerId).isEnabled(settings);
  }
  static setEnabled(providerId, settings, enabled) {
    const registration = this.getProviderRegistration(providerId);
    if (registration.setEnabled) {
      registration.setEnabled(settings, enabled);
      return;
    }
    if (registration.isEnabled(settings) !== enabled) {
      throw new Error(`Provider "${providerId}" enablement is not configurable.`);
    }
  }
  static resolveSettingsProviderId(settings) {
    const current = settings.settingsProvider;
    if (typeof current === "string") {
      const currentProvider = current;
      if (this.getRegisteredProviderIds().includes(currentProvider) && this.isEnabled(currentProvider, settings)) {
        return currentProvider;
      }
    }
    if (this.isEnabled(DEFAULT_CHAT_PROVIDER_ID, settings)) {
      return DEFAULT_CHAT_PROVIDER_ID;
    }
    return this.getEnabledProviderIds(settings)[0] ?? DEFAULT_CHAT_PROVIDER_ID;
  }
  static resolveProviderForModel(model, settings = {}, options = {}) {
    const providerIds = options.onlyEnabledProviders ? this.getEnabledProviderIds(settings) : this.getRegisteredProviderIds();
    const fallbackProviderId = options.fallbackProviderId && (!options.onlyEnabledProviders || this.isEnabled(options.fallbackProviderId, settings)) ? options.fallbackProviderId : options.onlyEnabledProviders ? this.resolveSettingsProviderId(settings) : DEFAULT_CHAT_PROVIDER_ID;
    const decodedSelection = decodeProviderModelSelectionId(model);
    if (decodedSelection && providerIds.includes(decodedSelection.providerId) && (!options.onlyEnabledProviders || this.isEnabled(decodedSelection.providerId, settings))) {
      return decodedSelection.providerId;
    }
    for (const providerId of providerIds) {
      if (providerId === fallbackProviderId) {
        continue;
      }
      if (this.getChatUIConfig(providerId).ownsModel(model, settings)) {
        return providerId;
      }
    }
    return fallbackProviderId;
  }
  static getCustomModelIds(envVars) {
    const ids = /* @__PURE__ */ new Set();
    for (const providerId of this.getRegisteredProviderIds()) {
      for (const modelId of this.getChatUIConfig(providerId).getCustomModelIds(envVars)) {
        ids.add(modelId);
      }
    }
    return ids;
  }
};
var RoutedTitleGenerationService = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.activeGenerations = /* @__PURE__ */ new Map();
  }
  async generateTitle(conversationId, userMessage, callback) {
    const providerId = ProviderRegistry.resolveTitleGenerationProviderId(
      this.plugin.settings
    );
    const service = ProviderRegistry.createTitleGenerationService(this.plugin, providerId);
    const generation = { service };
    const previous = this.activeGenerations.get(conversationId);
    this.activeGenerations.set(conversationId, generation);
    previous?.service.cancel();
    try {
      await service.generateTitle(conversationId, userMessage, async (convId, result) => {
        if (this.activeGenerations.get(conversationId) !== generation) {
          return;
        }
        await callback(convId, result);
      });
    } finally {
      if (this.activeGenerations.get(conversationId) === generation) {
        this.activeGenerations.delete(conversationId);
      }
    }
  }
  cancel() {
    const services = new Set(
      [...this.activeGenerations.values()].map((generation) => generation.service)
    );
    this.activeGenerations.clear();
    for (const service of services) {
      service.cancel();
    }
  }
};

// src/core/providers/providerEnvironment.ts
var SHARED_ENVIRONMENT_KEYS = /* @__PURE__ */ new Set([
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "TMPDIR",
  "TMP",
  "TEMP"
]);
function classifyEnvironmentKey(key) {
  const normalized = key.trim().toUpperCase();
  if (!normalized) {
    return { type: "shared-unknown" };
  }
  if (SHARED_ENVIRONMENT_KEYS.has(normalized)) {
    return { type: "shared-known" };
  }
  for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
    const patterns = ProviderRegistry.getEnvironmentKeyPatterns(providerId);
    if (patterns.some((pattern) => pattern.test(normalized))) {
      return { type: "provider", providerId };
    }
  }
  return { type: "shared-unknown" };
}
function extractEnvironmentKey(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const normalized = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
  const eqIndex = normalized.indexOf("=");
  if (eqIndex <= 0) {
    return null;
  }
  const key = normalized.slice(0, eqIndex).trim();
  return key || null;
}
function appendLines(target, pendingDecorators, line) {
  target.push(...pendingDecorators, line);
}
function createClassifiedEnvironmentLines() {
  return {
    shared: [],
    providers: {},
    reviewKeys: /* @__PURE__ */ new Set()
  };
}
function joinEnvironmentLines(lines) {
  return lines.join("\n");
}
function getLegacyEnvironmentClassification(settings) {
  const legacyEnvironmentVariables = settings.environmentVariables;
  if (typeof legacyEnvironmentVariables !== "string" || legacyEnvironmentVariables.length === 0) {
    return {
      shared: "",
      providers: {},
      reviewKeys: []
    };
  }
  return classifyEnvironmentVariablesByOwnership(legacyEnvironmentVariables);
}
function classifyEnvironmentVariablesByOwnership(input) {
  const result = createClassifiedEnvironmentLines();
  let pendingDecorators = [];
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      pendingDecorators.push(line);
      continue;
    }
    const key = extractEnvironmentKey(line);
    if (!key) {
      appendLines(result.shared, pendingDecorators, line);
      pendingDecorators = [];
      continue;
    }
    const ownership = classifyEnvironmentKey(key);
    if (ownership.type === "provider") {
      const target = result.providers[ownership.providerId] ?? [];
      appendLines(target, pendingDecorators, line);
      result.providers[ownership.providerId] = target;
    } else {
      appendLines(result.shared, pendingDecorators, line);
      if (ownership.type === "shared-unknown") {
        result.reviewKeys.add(key);
      }
    }
    pendingDecorators = [];
  }
  if (pendingDecorators.length > 0) {
    result.shared.push(...pendingDecorators);
  }
  return {
    shared: joinEnvironmentLines(result.shared),
    providers: Object.fromEntries(
      Object.entries(result.providers).map(([providerId, lines]) => [
        providerId,
        joinEnvironmentLines(lines ?? [])
      ])
    ),
    reviewKeys: Array.from(result.reviewKeys)
  };
}
function getSharedEnvironmentVariables(settings) {
  const sharedEnvironmentVariables = settings.sharedEnvironmentVariables;
  if (typeof sharedEnvironmentVariables === "string") {
    return sharedEnvironmentVariables;
  }
  return getLegacyEnvironmentClassification(settings).shared;
}
function getProviderEnvironmentVariables(settings, providerId) {
  const providerConfig = getProviderConfig(settings, providerId);
  if (typeof providerConfig.environmentVariables === "string") {
    return providerConfig.environmentVariables;
  }
  return getLegacyEnvironmentClassification(settings).providers[providerId] ?? "";
}
function joinEnvironmentTexts(...parts) {
  const filtered = parts.filter((part) => typeof part === "string" && part.length > 0);
  if (filtered.length === 0) {
    return "";
  }
  return filtered.reduce((combined, part) => {
    if (!combined) {
      return part;
    }
    return combined.endsWith("\n") ? `${combined}${part}` : `${combined}
${part}`;
  }, "");
}
function getRuntimeEnvironmentText(settings, providerId) {
  return joinEnvironmentTexts(
    getSharedEnvironmentVariables(settings),
    getProviderEnvironmentVariables(settings, providerId)
  );
}

// src/utils/windowsCmdShim.ts
var WINDOWS_CMD_ARGUMENT_CHARS = /[\s"&<>|{}^=;!'+,`~()%@]/u;
function resolveWindowsCmdShimSpawnSpec(spec) {
  const command = spec.command.trim();
  if (!command || process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return {
      args: spec.args,
      command: spec.command
    };
  }
  const shellCommand = [command, ...spec.args].map((value) => quoteWindowsShellArgument(value)).join(" ");
  return {
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    command: process.env.ComSpec || process.env.comspec || "cmd.exe",
    killProcessTree: true,
    windowsVerbatimArguments: true
  };
}
function terminateSpawnedProcess(proc, signal, spawnProcess, spawnSpec) {
  if (process.platform !== "win32" || !spawnSpec?.killProcessTree || typeof proc.pid !== "number") {
    return proc.kill(signal);
  }
  try {
    const taskkill = spawnProcess("taskkill.exe", ["/pid", String(proc.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (isErrorEmitterLike(taskkill)) {
      taskkill.on("error", () => {
      });
    }
    return true;
  } catch {
    return proc.kill(signal);
  }
}
function isErrorEmitterLike(value) {
  return value !== null && typeof value === "object" && typeof value.on === "function";
}
function requiresWindowsShellQuoting(value) {
  return WINDOWS_CMD_ARGUMENT_CHARS.test(value) || value.includes("[") || value.includes("]");
}
function quoteWindowsShellArgument(value) {
  if (!value.length) {
    return '""';
  }
  if (!requiresWindowsShellQuoting(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

// src/providers/modos/models.ts
var MODOS_MODEL_PREFIX = "modos/";
var MODOS_DEFAULT_PROVIDER_ID = "modos";
function encodeModosModelId(modelId, providerId) {
  const normalizedModel = modelId.trim();
  const normalizedProvider = providerId?.trim() ?? "";
  if (!normalizedModel) {
    return "";
  }
  return normalizedProvider && normalizedProvider !== MODOS_DEFAULT_PROVIDER_ID ? `${MODOS_MODEL_PREFIX}${normalizedProvider}/${normalizedModel}` : `${MODOS_MODEL_PREFIX}${normalizedModel}`;
}
function normalizeModosDiscoveredModels(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const provider = typeof record.provider === "string" && record.provider.trim() ? record.provider.trim() : MODOS_DEFAULT_PROVIDER_ID;
    if (!id) {
      continue;
    }
    const encodedId = encodeModosModelId(id, provider);
    if (seen.has(encodedId)) {
      continue;
    }
    seen.add(encodedId);
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : provider === MODOS_DEFAULT_PROVIDER_ID ? id : `${provider}/${id}`;
    const contextWindow = typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow) && record.contextWindow > 0 ? Math.floor(record.contextWindow) : void 0;
    normalized.push({
      ...contextWindow !== void 0 ? { contextWindow } : {},
      encodedId,
      id,
      label,
      provider
    });
  }
  return normalized;
}

// src/providers/modos/settings.ts
var DEFAULT_MODOS_PROVIDER_SETTINGS = Object.freeze({
  approvalPolicy: "on-request",
  cliPath: "",
  cliPathsByHost: {},
  contextWindowTokens: 0,
  dataDir: "",
  discoveredModels: [],
  enabled: false,
  environmentVariables: "",
  sandboxMode: "workspace-write",
  selectedModel: ""
});
var APPROVAL_POLICIES = /* @__PURE__ */ new Set([
  "always",
  "on-request",
  "untrusted",
  "never",
  "auto",
  "suggest"
]);
var SANDBOX_MODES = /* @__PURE__ */ new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
  "external-sandbox"
]);
function normalizeHostnameCliPaths(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}
function normalizeApprovalPolicy(value) {
  return typeof value === "string" && APPROVAL_POLICIES.has(value) ? value : DEFAULT_MODOS_PROVIDER_SETTINGS.approvalPolicy;
}
function normalizeSandboxMode(value) {
  return typeof value === "string" && SANDBOX_MODES.has(value) ? value : DEFAULT_MODOS_PROVIDER_SETTINGS.sandboxMode;
}
function getModosProviderSettings(settings) {
  const config = getProviderConfig(settings, "modos");
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0 ? migrateLegacyHostnameKeyedMap(
    normalizedCliPathsByHost,
    getHostnameKey(),
    getLegacyHostnameKey()
  ) : normalizedCliPathsByHost;
  return {
    approvalPolicy: normalizeApprovalPolicy(config.approvalPolicy),
    cliPath: config.cliPath ?? DEFAULT_MODOS_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    contextWindowTokens: typeof config.contextWindowTokens === "number" && Number.isFinite(config.contextWindowTokens) && config.contextWindowTokens > 0 ? Math.floor(config.contextWindowTokens) : DEFAULT_MODOS_PROVIDER_SETTINGS.contextWindowTokens,
    dataDir: typeof config.dataDir === "string" ? config.dataDir.trim() : "",
    discoveredModels: normalizeModosDiscoveredModels(config.discoveredModels),
    enabled: config.enabled ?? DEFAULT_MODOS_PROVIDER_SETTINGS.enabled,
    environmentVariables: config.environmentVariables ?? getProviderEnvironmentVariables(settings, "modos") ?? DEFAULT_MODOS_PROVIDER_SETTINGS.environmentVariables,
    sandboxMode: normalizeSandboxMode(config.sandboxMode),
    selectedModel: typeof config.selectedModel === "string" ? config.selectedModel.trim() : ""
  };
}

// src/providers/modos/runtime/ModosServeProcess.ts
var MODOS_READY_PREFIX = "MODOS_READY ";
var STARTUP_TIMEOUT_MS = 3e4;
var HEALTH_POLL_INTERVAL_MS = 250;
var SIGKILL_TIMEOUT_MS = 3e3;
var STDERR_BUFFER_LIMIT = 8e3;
var ModosServeManager = class {
  constructor(plugin, cliResolver) {
    this.plugin = plugin;
    this.cliResolver = cliResolver;
    this.connection = null;
    this.launchKey = null;
    this.proc = null;
    this.resolvedSpawnSpec = null;
    this.starting = null;
    this.stderrBuffer = "";
  }
  getConnection() {
    return this.connection;
  }
  isRunning() {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }
  getDiagnostics() {
    return this.stderrBuffer.trim();
  }
  async ensureReady() {
    const settings = this.plugin.settings;
    const modosSettings = getModosProviderSettings(settings);
    const command = await this.plugin.getResolvedProviderCliPath("modos") ?? await this.cliResolver?.resolveFromSettings(settings) ?? "modos";
    const envText = getRuntimeEnvironmentText(settings, "modos");
    const dataDir = modosSettings.dataDir || join(homedir(), ".modos", "data");
    const launchKey = JSON.stringify({
      approvalPolicy: modosSettings.approvalPolicy,
      command,
      dataDir,
      envText,
      sandboxMode: modosSettings.sandboxMode
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
      sandboxMode: modosSettings.sandboxMode
    });
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async shutdown() {
    this.connection = null;
    this.launchKey = null;
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) {
      return;
    }
    await new Promise((resolve) => {
      let killTimer = null;
      let finalTimer = null;
      const onClose = () => {
        if (killTimer) window.clearTimeout(killTimer);
        if (finalTimer) window.clearTimeout(finalTimer);
        resolve();
      };
      killTimer = window.setTimeout(() => {
        terminateSpawnedProcess(proc, "SIGKILL", spawn, this.resolvedSpawnSpec);
        finalTimer = window.setTimeout(onClose, SIGKILL_TIMEOUT_MS);
      }, SIGKILL_TIMEOUT_MS);
      proc.once("exit", onClose);
      terminateSpawnedProcess(proc, "SIGTERM", spawn, this.resolvedSpawnSpec);
    });
  }
  async restart(launch) {
    await this.shutdown();
    const port = await pickFreePort();
    const token = randomUUID();
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      launch.dataDir,
      "--approval-policy",
      launch.approvalPolicy,
      "--sandbox-mode",
      launch.sandboxMode
    ];
    const env = {
      ...process.env,
      ...parseEnvironmentVariables(launch.envText || ""),
      MODOS_RUNTIME_TOKEN: token
    };
    const spawnSpec = resolveWindowsCmdShimSpawnSpec({ args, command: launch.command });
    this.resolvedSpawnSpec = spawnSpec;
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}
    });
    this.proc = proc;
    this.stderrBuffer = "";
    proc.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-STDERR_BUFFER_LIMIT);
    });
    const connection = {
      baseUrl: `http://127.0.0.1:${port}`,
      host: "127.0.0.1",
      port,
      token
    };
    await this.waitForReady(proc, connection);
    this.connection = connection;
    this.launchKey = launch.launchKey;
    proc.on("exit", () => {
      if (this.proc === proc) {
        this.proc = null;
        this.connection = null;
        this.launchKey = null;
      }
    });
    return connection;
  }
  async waitForReady(proc, connection) {
    let stdoutBuffer = "";
    let sawReadyLine = false;
    proc.stdout.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      stdoutBuffer = `${stdoutBuffer}${text}`.slice(-STDERR_BUFFER_LIMIT);
      if (!sawReadyLine && stdoutBuffer.includes(MODOS_READY_PREFIX)) {
        sawReadyLine = true;
      }
    });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(
          `modos serve exited during startup (code ${proc.exitCode})${this.formatStderr()}`
        );
      }
      try {
        const response = await fetch(`${connection.baseUrl}/health`, {
          signal: AbortSignal.timeout(1e3)
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
      `modos serve did not become ready within ${STARTUP_TIMEOUT_MS}ms${sawReadyLine ? "" : " (no MODOS_READY line seen)"}${lastError instanceof Error ? `; last health probe: ${lastError.message}` : ""}` + this.formatStderr()
    );
  }
  formatStderr() {
    const stderr = this.getDiagnostics();
    return stderr ? `

modos stderr:
${stderr}` : "";
  }
};
async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port for modos serve"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

// scripts/modos-smoke.ts
var cliPath = process.argv[2];
if (!cliPath) {
  console.error("usage: node modos-smoke.mjs <path-to-modos-cli> [dataDir]");
  process.exit(64);
}
var fakePlugin = {
  settings: {
    providerConfigs: {
      modos: {
        approvalPolicy: "never",
        enabled: true,
        ...process.argv[3] ? { dataDir: process.argv[3] } : {},
        sandboxMode: "read-only"
      }
    }
  },
  async getResolvedProviderCliPath() {
    return cliPath;
  }
};
var manager = new ModosServeManager(fakePlugin, null);
async function main() {
  console.log("[smoke] starting modos serve...");
  const connection = await manager.ensureReady();
  console.log(`[smoke] serve ready at ${connection.baseUrl}`);
  const client = new ModosHttpClient(connection);
  const info = await client.get("/v1/runtime/info");
  console.log(`[smoke] runtime info: model=${info.model ?? "unknown"}`);
  if (!info.model) {
    throw new Error("runtime reported no model");
  }
  const thread = await client.post("/v1/threads", {
    mode: "agent",
    model: info.model,
    title: "claudian-modos smoke",
    workspace: process.cwd()
  });
  console.log(`[smoke] thread created: ${thread.id} latestSeq=${thread.latestSeq ?? 0}`);
  const started = await client.post(
    `/v1/threads/${encodeURIComponent(thread.id)}/turns`,
    { mode: "agent", prompt: "Say hello in one word." }
  );
  console.log(`[smoke] turn started: ${started.turnId}`);
  const abort = new AbortController();
  const terminal = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error("timed out waiting for the terminal turn event"));
    }, 12e4);
    void (async () => {
      let lastSeq = thread.latestSeq ?? 0;
      for await (const frame of client.streamEvents(thread.id, lastSeq, abort.signal)) {
        const event = frame.data;
        if (typeof event?.seq === "number") {
          lastSeq = event.seq;
        }
        if (!event?.kind || event.kind === "heartbeat") {
          continue;
        }
        console.log(`[smoke] event: ${event.kind}${event.turnId ? ` turn=${event.turnId}` : ""}`);
        if (event.turnId === started.turnId && (event.kind === "turn_completed" || event.kind === "turn_failed" || event.kind === "turn_aborted")) {
          clearTimeout(timer);
          resolve({ kind: event.kind, message: event.message });
          return;
        }
      }
    })().catch(reject);
  });
  console.log(`[smoke] terminal event: ${terminal.kind}${terminal.message ? ` (${terminal.message})` : ""}`);
  const snapshot = await client.get(`/v1/threads/${encodeURIComponent(thread.id)}`);
  console.log(`[smoke] thread snapshot: turns=${snapshot.turns?.length ?? 0} latestSeq=${snapshot.latestSeq ?? 0}`);
  await manager.shutdown();
  console.log("[smoke] serve stopped. PASS");
  process.exit(0);
}
main().catch(async (error) => {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  const diagnostics = manager.getDiagnostics();
  if (diagnostics) {
    console.error(`[smoke] modos stderr:
${diagnostics}`);
  }
  await manager.shutdown().catch(() => void 0);
  process.exit(70);
});
