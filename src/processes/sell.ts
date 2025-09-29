import type { Address } from 'viem';
import { erc20Abi, curveSellAbi } from '../abi/sell';
import { allPositions } from '../positions';

type Cfg = {
  slippageBps: number;    // e.g. 300 = 3%
  takeProfitBps: number;  // e.g. 6000 = +60%
  hardStopBps: number;    // e.g. 0 (no forced loss sell) or 1000 = -10%
  minHoldBlocks: number;  // e.g. 3 blocks
};

const DBG = process.env.SELL_DEBUG === '1';
const MAX_UINT256 = (1n << 256n) - 1n;
const bps = (n: bigint, d: bigint) => Number((n * 10000n) / (d || 1n));

// Prevent re-entrancy/double processing per token while approvals/txs are pending
const inFlight = new Set<string>(); // key = token lowercase

async function ensureAllowance(
  pub: any,
  wal: any,
  token: Address,
  spender: Address,
  required: bigint
) {
  const owner = wal.account.address as Address;

  const current: bigint = await pub.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });

  if (current >= required) return;

  // Some ERC20s require zeroing first (USDT-style).
  if (current > 0n) {
    if (DBG) console.log('[Seller] approve(0) first', { token, spender });
    const tx0 = await wal.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, 0n],
    });
    await pub.waitForTransactionReceipt({ hash: tx0 });
  }

  // Approve max to avoid re-approving on every sell
  if (DBG) console.log('[Seller] approving MAX', { token, spender });
  const tx1 = await wal.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
  });
  await pub.waitForTransactionReceipt({ hash: tx1 });
}

export function startSellLoop(pub: any, wal: any, cfg: Cfg) {
  // IMPORTANT: pass the WS client as `pub` from index.ts
  pub.watchBlocks({
    emitMissed: false,          // don't backfill with HTTP; avoids BlockNotFound races
    includeTransactions: false,
    poll: false,

    onBlock: async (block: any) => {
      const blockNumber: bigint | undefined = block?.number;
      if (!blockNumber) return;
      const positions = allPositions();
      if (DBG) console.log(`[SellLoop] block=${blockNumber.toString()} positions=${positions.length}`);

      for (const pos of positions) {
        const key = String(pos.token).toLowerCase();
        if (inFlight.has(key)) continue;

        try {
          // 1) Balance
          const bal: bigint = await pub.readContract({
            address: pos.token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wal.account.address as Address],
          });
          if (bal === 0n) continue;

          // 2) Min hold
          if (blockNumber - pos.firstSeenBlock < BigInt(cfg.minHoldBlocks)) continue;

          // 3) Quote gross sell value (KAS out)
          let kasOut: bigint;
          try {
            kasOut = await pub.readContract({
              address: pos.curve,
              abi: curveSellAbi,
              functionName: 'previewSellTokens',
              args: [bal],
            });
          } catch {
            if (DBG) console.warn('[Seller] previewSellTokens unavailable; skipping');
            continue;
          }
          if (kasOut === 0n) continue;

          // 4) Estimate sell gas to compute NET P&L
          let estGas: bigint;
          try {
            const sim = await pub.simulateContract({
              address: pos.curve,
              abi: curveSellAbi,
              functionName: 'sellTokens',
              args: [bal, 1n],   // loose minOut to estimate gas
              account: wal.account,
            });
            estGas = sim?.request?.gas ?? 120_000n;
          } catch {
            estGas = 120_000n;   // conservative fallback
          }

          // Fee: prefer estimateFeesPerGas, fallback to getGasPrice
          let maxFeePerGas: bigint;
          try {
            const f = await pub.estimateFeesPerGas();
            maxFeePerGas = f.maxFeePerGas!;
          } catch {
            maxFeePerGas = await pub.getGasPrice();
          }

          const sellGasWei = estGas * maxFeePerGas;
          const netKasWei = kasOut - sellGasWei; // proceeds after paying sell gas

          // 5) PnL vs cost basis (which already includes buy gas from onBuy)
          const denom = pos.totalCostWei === 0n ? 1n : pos.totalCostWei;
          const pnlBps = Number(((netKasWei - pos.totalCostWei) * 10000n) / denom);

          const shouldTP = pnlBps >= cfg.takeProfitBps;
          const shouldSL = pnlBps <= -cfg.hardStopBps;
          if (!shouldTP && !shouldSL) continue;

          // 6) Guard against concurrent processing
          inFlight.add(key);

          // 7) Ensure allowance (and wait for receipts)
          await ensureAllowance(pub, wal, pos.token as Address, pos.curve as Address, bal);

          // 8) Compute minOut using slippage
          const minOut = (kasOut * BigInt(10000 - cfg.slippageBps)) / 10000n;

          // 9) Simulate THEN send
          await pub.simulateContract({
            address: pos.curve,
            abi: curveSellAbi,
            functionName: 'sellTokens',
            args: [bal, minOut],
            account: wal.account,
          });

          const tx = await wal.writeContract({
            address: pos.curve,
            abi: curveSellAbi,
            functionName: 'sellTokens',
            args: [bal, minOut],
          });

          console.log(
            `[Seller] token=${pos.token} curve=${pos.curve} sell-all tx=${tx} pnlBps=${pnlBps}`
          );
        } catch (e: any) {
          if (String(e?.shortMessage || e?.message || '').includes('insufficient allowance')) {
            console.warn('[Seller] allowance race; will retry next block');
          } else {
            console.error('[Seller] error', e);
          }
        } finally {
          inFlight.delete(key);
        }
      }
    },

    onError: (e: any) => {
      if (
        e?.name === 'BlockNotFoundError' ||
        String(e?.shortMessage || '').includes('Block at number')
      ) {
        if (DBG) console.warn('[SellLoop] transient BlockNotFound (ignored)');
        return;
      }
      console.error('[SellLoop] watchBlocks error', e);
    },
  });
}

