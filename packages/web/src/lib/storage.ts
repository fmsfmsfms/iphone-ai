// localStorage wrapper that never throws (private mode, blocked storage, tests).

export const safeStorage: Pick<Storage, 'getItem' | 'setItem'> & { removeItem(key: string): void } = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

export function readJson<T>(key: string, fallback: T): T {
  const raw = safeStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  safeStorage.setItem(key, JSON.stringify(value));
}

export const STORAGE_KEYS = {
  sidebarCollapsed: 'iphone-ai.sidebar.collapsed',
  touchMode: 'iphone-ai.live.touchMode',
  language: 'iphone-ai.language',
  /** Name this browser gives itself when signing in to Remote Access. */
  remoteDeviceName: 'iphone-ai.remote.deviceName',
} as const;
