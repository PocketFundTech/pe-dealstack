import type { IntegrationProvider, ProviderId } from './types.js';

const providers = new Map<ProviderId, IntegrationProvider>();

export function registerProvider(provider: IntegrationProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: ProviderId): IntegrationProvider {
  const p = providers.get(id);
  if (!p) throw new Error(`Provider not registered: ${id}`);
  return p;
}

export function listProviders(): IntegrationProvider[] {
  return Array.from(providers.values());
}

export function isProviderRegistered(id: ProviderId): boolean {
  return providers.has(id);
}

export function _resetRegistryForTests(): void {
  providers.clear();
}
