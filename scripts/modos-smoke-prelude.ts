/**
 * The provider code targets Obsidian's renderer (Electron) where `window`
 * exists. Running the transport under plain Node for smoke tests needs a
 * minimal shim; keep it to exactly what the transport touches.
 */
const globalRef = globalThis as Record<string, unknown>;
if (typeof globalRef.window === 'undefined') {
  globalRef.window = {
    clearTimeout: globalRef.clearTimeout,
    crypto: globalRef.crypto,
    localStorage: null,
    setTimeout: globalRef.setTimeout,
  };
}

export {};
