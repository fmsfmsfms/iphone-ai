// Network interface discovery for the optional remote-access listener.

import { networkInterfaces } from 'node:os';

import type { NetworkAddress } from '../core/services.js';

/** 100.64.0.0/10 — the CGNAT range Tailscale assigns addresses from. */
export function isTailscaleAddress(address: string): boolean {
  const octets = address.split('.').map((o) => Number(o));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

/** IPv4, non-internal addresses currently assigned to this Mac. */
export function listNetworkAddresses(): NetworkAddress[] {
  const out: NetworkAddress[] = [];
  for (const [iface, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if ((family !== 'IPv4' && family !== 4) || entry.internal) continue;
      out.push({ iface, address: entry.address, tailscale: isTailscaleAddress(entry.address) });
    }
  }
  // Tailscale first: it is the recommended way to reach the Mac remotely.
  return out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale) || a.iface.localeCompare(b.iface));
}

/** Returns a human-readable reason when the address must not be bound, or null when it is acceptable. */
export function bindAddressProblem(address: string, available: readonly NetworkAddress[]): string | null {
  const value = address.trim();
  if (!value) return 'Choose the network address remote devices should connect to.';
  if (value === '0.0.0.0' || value === '::' || value === '[::]') {
    return 'Listening on every network interface is not allowed. Choose one address (for example your Tailscale address).';
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `"${value}" is not an IPv4 address.`;
  if (value.startsWith('127.')) return 'Loopback addresses are already served locally; choose a network address.';
  if (!available.some((a) => a.address === value)) {
    return `${value} is not assigned to any network interface on this Mac right now.`;
  }
  return null;
}
