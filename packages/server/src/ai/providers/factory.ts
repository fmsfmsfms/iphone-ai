// Builds provider instances from settings + Keychain secrets. Instances are
// cached by (config, key fingerprint), so editing a provider or switching the
// active provider takes effect on the next task without restarting the app.

import { createHash } from 'node:crypto';

import type { ProviderConfig } from '@iphone-ai/shared';

import type { AppPaths } from '../../core/paths.js';
import type { Logger } from '../../core/logger.js';
import { providerSecretAccount, type SecretStore } from '../../security/secrets.js';
import { ProviderError, type AiProvider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { ClaudeAgentSdkProvider, claudeCodeWorkDir, resolveClaudeCodeBinary } from './claude-agent-sdk.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';

export class ProviderFactory {
  private readonly cache = new Map<string, { fingerprint: string; provider: AiProvider }>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly paths: AppPaths,
    private readonly log: Logger,
  ) {}

  async apiKey(config: ProviderConfig): Promise<string | null> {
    try {
      return await this.secrets.get(providerSecretAccount(config.id));
    } catch {
      return null;
    }
  }

  /** Returns a provider, or throws a ProviderError explaining what is missing. */
  async build(config: ProviderConfig): Promise<AiProvider> {
    if (!config.enabled) throw new ProviderError(`${config.label} is disabled in Settings → AI Providers.`, false, 'config');
    const key = await this.apiKey(config);
    if (config.kind === 'openai' && !key) {
      throw new ProviderError('Add an OpenAI API key in Settings → AI Providers. (A ChatGPT subscription does not include API access.)', false, 'config');
    }
    if (config.kind === 'openai-compatible') {
      if (!config.baseUrl) throw new ProviderError(`Set the server URL for ${config.label} in Settings → AI Providers.`, false, 'config');
      if (!config.model) throw new ProviderError(`Choose a model for ${config.label} in Settings → AI Providers.`, false, 'config');
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...config, hasApiKey: undefined }))
      .update(key ?? '')
      .digest('hex');
    const cached = this.cache.get(config.id);
    if (cached && cached.fingerprint === fingerprint) return cached.provider;

    let provider: AiProvider;
    switch (config.kind) {
      case 'anthropic':
        provider = new AnthropicProvider(config, key);
        break;
      case 'openai':
      case 'openai-compatible':
        provider = new OpenAiCompatibleProvider(config, key);
        break;
      case 'claude-agent-sdk':
        provider = new ClaudeAgentSdkProvider(config, {
          binaryPath: resolveClaudeCodeBinary(),
          apiKey: key,
          workDir: claudeCodeWorkDir(this.paths.dataDir),
          onStderr: (line) => this.log.debug('claude-code stderr', { line: line.slice(0, 500) }),
        });
        break;
    }
    this.cache.set(config.id, { fingerprint, provider });
    return provider;
  }

  invalidate(providerId?: string): void {
    if (providerId) this.cache.delete(providerId);
    else this.cache.clear();
  }
}
