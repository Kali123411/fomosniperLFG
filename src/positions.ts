import type { Address } from 'viem';

export type Position = {
  token: Address;
  curve: Address;
  totalCostWei: bigint;    // sum of KAS spent on this token
  firstSeenBlock: bigint;  // for min-hold logic
};

const map = new Map<string, Position>(); // key = token

export function upsertPosition(p: Position) { map.set(p.token.toLowerCase(), p); }
export function getPosition(token: Address) { return map.get(token.toLowerCase()); }
export function allPositions() { return Array.from(map.values()); }

// Call this right after a confirmed buy
export function onBuy(token: Address, curve: Address, costWei: bigint, block: bigint) {
  const k = token.toLowerCase();
  const existing = map.get(k);
  if (existing) {
    existing.totalCostWei += costWei;
  } else {
    map.set(k, { token, curve, totalCostWei: costWei, firstSeenBlock: block });
  }
}
