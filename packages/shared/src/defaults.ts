// Safe defaults. Observe-only, manual control off, sensitive apps blocked.

import type { ProviderConfig } from './agent.js';
import type { AppSettings, SensitiveRule } from './settings.js';

export const DEFAULT_MIRROIR_BINARY = '/opt/homebrew/bin/mirroir';

/** Default frame rate of the ScreenCaptureKit live capture helper. */
export const DEFAULT_LIVE_FPS = 10;
export const MIN_LIVE_FPS = 5;
/**
 * Highest live frame rate. The helper takes single window screenshots (the
 * capture Mirroir's own screenshot tool uses), capped at 15 per second; the
 * settings API still accepts up to 60 from older clients and stores at most this.
 */
export const MAX_LIVE_FPS = 15;

export const DEFAULT_BLOCKED_APPS: readonly string[] = [
  // Apple
  'Wallet',
  'Passwords',
  // Password managers & authenticators
  '1Password',
  'Bitwarden',
  'LastPass',
  'Dashlane',
  'Keeper',
  'Authenticator',
  'Google Authenticator',
  'Microsoft Authenticator',
  'Authy',
  'Okta Verify',
  'Duo Mobile',
  // Identity
  'Nafath',
  'Absher',
  // Payments & banking
  'PayPal',
  'Venmo',
  'Cash App',
  'Revolut',
  'Wise',
  'Coinbase',
  'Binance',
  'Robinhood',
  'STC Bank',
  'stc pay',
  'urpay',
  'Al Rajhi',
  'alrajhi',
  'SNB',
  'AlAhli',
  'Alinma',
  'Riyad Bank',
  'SAB',
  'Banque Saudi Fransi',
  'Bank',
];

export const DEFAULT_SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: 'auth',
    label: 'Passwords, passcodes and verification codes',
    keywords: [
      'password',
      'passcode',
      'verification code',
      'one-time',
      'one time code',
      'otp',
      'two-factor',
      '2fa',
      'security code',
      'authentication code',
      'enter pin',
      'face id',
      'touch id',
      'كلمة المرور',
      'رمز التحقق',
      'رمز المرور',
    ],
    effect: 'require_approval',
    enabled: true,
  },
  {
    id: 'payment',
    label: 'Payments, purchases and transfers',
    keywords: [
      'apple pay',
      'pay now',
      'buy',
      'purchase',
      'subscribe',
      'checkout',
      'place order',
      'confirm payment',
      'transfer',
      'send money',
      'card number',
      'cvv',
      'iban',
      'دفع',
      'شراء',
      'تحويل',
    ],
    effect: 'require_approval',
    enabled: true,
  },
  {
    id: 'messaging',
    label: 'Sending messages, emails and posts',
    keywords: ['send', 'post', 'reply', 'share', 'tweet', 'publish', 'إرسال', 'ارسال', 'نشر'],
    effect: 'require_approval',
    enabled: true,
  },
  {
    id: 'destructive',
    label: 'Deleting or erasing data',
    keywords: [
      'delete',
      'remove',
      'erase',
      'reset',
      'clear all',
      'clear history',
      'sign out',
      'log out',
      'unpair',
      'forget this device',
      'حذف',
      'مسح',
    ],
    effect: 'require_approval',
    enabled: true,
  },
  {
    id: 'security',
    label: 'Security and privacy changes',
    keywords: [
      'turn off',
      'disable',
      'allow',
      'trust',
      'install profile',
      'vpn',
      'privacy & security',
      'location services',
      'find my',
      'airdrop',
      'stolen device',
    ],
    effect: 'require_approval',
    enabled: true,
  },
];

/**
 * Mirroir tools the AI may use by default (navigation and input; no network
 * toggles, app resets or gestures). `open_url` is absent on purpose: Mirroir
 * always refuses it for the iPhone target.
 */
export const DEFAULT_AI_TOOLS: readonly string[] = [
  'tap',
  'double_tap',
  'long_press',
  'swipe',
  'type_text',
  'press_key',
  'press_home',
  'press_back',
  'press_app_switcher',
  'spotlight',
  'launch_app',
  'scroll_to',
];

/** Tools iPhone AI never exposes, even if a user edits the permission file. */
export const ALWAYS_DENIED_TOOLS: readonly string[] = [
  'set_network',
  'reset_app',
  'shake',
  'generate_skill',
  'hold_keys',
  'measure',
  'switch_target',
];

export const DEFAULT_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'claude-api',
    kind: 'anthropic',
    label: 'Claude (Anthropic API)',
    baseUrl: null,
    model: 'claude-opus-5-5',
    vision: true,
    maxOutputTokens: 16000,
    contextTokens: null,
    timeoutMs: 120000,
    effort: 'medium',
    enabled: true,
    hasApiKey: false,
    cloud: true,
  },
  {
    id: 'claude-code',
    kind: 'claude-agent-sdk',
    label: 'Claude (Claude Code login)',
    baseUrl: null,
    model: 'claude-opus-5-5',
    vision: true,
    maxOutputTokens: 16000,
    contextTokens: null,
    timeoutMs: 180000,
    effort: null,
    enabled: true,
    hasApiKey: false,
    cloud: true,
  },
  {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: null,
    model: 'gpt-5.5',
    vision: true,
    maxOutputTokens: 8000,
    contextTokens: null,
    timeoutMs: 120000,
    effort: null,
    enabled: true,
    hasApiKey: false,
    cloud: true,
  },
  {
    id: 'lmstudio',
    kind: 'openai-compatible',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    vision: false,
    maxOutputTokens: 4096,
    contextTokens: 32768,
    timeoutMs: 180000,
    effort: null,
    enabled: true,
    hasApiKey: false,
    cloud: false,
  },
  {
    id: 'ollama',
    kind: 'openai-compatible',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    vision: false,
    maxOutputTokens: 4096,
    contextTokens: 32768,
    timeoutMs: 180000,
    effort: null,
    enabled: true,
    hasApiKey: false,
    cloud: false,
  },
];

export function createDefaultSettings(): AppSettings {
  return {
    version: 1,
    general: {
      theme: 'dark',
      language: 'en',
      notifications: true,
      openMirroringOnLaunch: false,
      refocusAfterManualAction: true,
      onboardingCompleted: false,
    },
    connection: {
      mirroirBinaryPath: DEFAULT_MIRROIR_BINARY,
      target: 'iphone',
      requestTimeoutMs: 30000,
      screenshot: {
        activeFps: 2,
        idleFps: 0.2,
        idleAfterMs: 30000,
        pauseWhenHidden: true,
        liveCapture: true,
        liveFps: DEFAULT_LIVE_FPS,
      },
    },
    ai: {
      activeProviderId: 'claude-api',
      visionProviderId: null,
      maxActionsPerTask: 25,
      maxTaskDurationSec: 300,
      settleDelayMs: 450,
      providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })),
    },
    permissions: {
      controlMode: 'observe',
      manualControlEnabled: false,
      aiAllowedTools: [...DEFAULT_AI_TOOLS],
      blockedApps: [...DEFAULT_BLOCKED_APPS],
      sensitiveRules: DEFAULT_SENSITIVE_RULES.map((r) => ({ ...r, keywords: [...r.keywords] })),
      blockTypingOnAuthScreens: true,
      approvalTimeoutSec: 120,
      auditManualActions: true,
    },
    automation: {
      maxStepsPerRun: 50,
      maxRunDurationSec: 600,
      defaultWaitTimeoutMs: 15000,
      unattendedRunsEnabled: false,
    },
    privacy: {
      storeScreenshots: false,
      screenshotRetentionDays: 7,
      logTypedText: false,
      historyRetentionDays: 90,
      cloudDisclosureAcknowledged: false,
    },
    advanced: {
      debugLogging: false,
      mcpTrace: false,
    },
    remote: {
      enabled: false,
      bindAddress: '',
      port: 47824,
      passcodeSet: false,
      allowRemoteControl: false,
      sessionTtlHours: 12,
    },
  };
}
