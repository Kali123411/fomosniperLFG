// src/positions.ts
import type { Address } from 'viem';

export type Position = {
  token: Address;
  curve: Address;
  /** Total WKAS spent on this token (includes buy gas; see onBuy) */
  totalCostWei: bigint;
  /** First block the position was opened (min-hold logic) */
  firstSeenBlock: bigint;
};

const map = new Map<string, Position>(); // key = token (lowercased)

const keyOf = (addr: Address) => (addr as string).toLowerCase();

/** Insert or replace a full position object. */
export function upsertPosition(p: Position) {
  map.set(keyOf(p.token), p);
}

/** Read by token address. */
export function getPosition(token: Address) {
  return map.get(keyOf(token));
}

/** All open positions (copy). */
export function allPositions(): Position[] {
  return Array.from(map.values());
}

/** Remove a position (after a full sell, or if balance is 0). */
export function removePosition(token: Address) {
  map.delete(keyOf(token));
}

/**
 * Record a buy fill.
 * - `costWei` should include **purchase amount + buy gas** (the refactor does this).
 * - If called repeatedly for the same token, cost is accumulated and
 *   firstSeenBlock is kept from the earliest buy (useful for min-hold).
 */
export function onBuy(token: Address, curve: Address, costWei: bigint, blockNumber: bigint) {
  const k = keyOf(token);
  const existing = map.get(k);
  if (existing) {
    existing.totalCostWei += costWei;
    // keep earliest firstSeenBlock; update curve in case of migration
    if (blockNumber < existing.firstSeenBlock) existing.firstSeenBlock = blockNumber;
    existing.curve = curve;
  } else {
    map.set(k, {
      token,
      curve,
      totalCostWei: costWei,
      firstSeenBlock: blockNumber,
    });
  }
}

/** (Optional) Clear everything; handy in tests or on restart. */
export function clearPositions() {
  map.clear();
}

