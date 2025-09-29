import type { Address } from 'viem';
import { erc20Abi, curveSellAbi } from '../abi/sell';
import { allPositions, removePosition } from '../positions';

type Cfg = {
  slippageBps: number;    // e.g. 300 = 3%
  takeProfitBps: number;  // e.g. 6000 = +60%
  hardStopBps: number;    // 0 = disabled, or 1000 = -10%
  minHoldBlocks: number;  // e.g. 3
};

const DBG = process.env.SELL_DEBUG === '1';
const MAX_UINT256 = (1n << 256n) - 1n;
const bps = (n: bigint, d: bigint) => Number((n * 10000n) / (d || 1n));
const inFlight = new Set<string>(); // tokenLower

// Optional hard profit floor (e.g. 0.15 KAS): export MIN_PROFIT_KAS_WEI=150000000000000000
const MIN_PROFIT_WEI = BigInt(process.env.MIN_PROFIT_KAS_WEI ?? '0');

async function ensureAllowance(
  pub: any,
  wal: any,
  token: Address,
  spender: Address,
  required: bigint
) {
  const owner = wal.account.address as Address;
  const current: bigint = await pub.readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender],
  });
  if (current >= required) return;

  if (current > 0n) {
    if (DBG) console.log('[Seller] approve(0) first', { token, spender });
    const tx0 = await wal.writeContract({
      address: token, abi: erc20Abi, functionName: 'approve', args: [spender, 0n],
    });
    await pub.waitForTransactionReceipt({ hash: tx0 });
  }
  if (DBG) console.log('[Seller] approving MAX', { token, spender });
  const tx1 = await wal.writeContract({
    address: token, abi: erc20Abi, functionName: 'approve', args: [spender, MAX_UINT256],
  });
  await pub.waitForTransactionReceipt({ hash: tx1 });
}

export function startSellLoop(pub: any, wal: any, cfg: Cfg) {
  pub.watchBlocks({
    emitMissed: false,
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
          // 1) current balance
          const bal: bigint = await pub.readContract({
            address: pos.token, abi: erc20Abi, functionName: 'balanceOf',
            args: [wal.account.address as Address],
          });
          if (bal === 0n) { removePosition(pos.token as Address); continue; }

          // 2) min hold
          if (blockNumber - pos.firstSeenBlock < BigInt(cfg.minHoldBlocks)) continue;

          // 3) gross quote
          let kasOut: bigint;
          try {
            kasOut = await pub.readContract({
              address: pos.curve, abi: curveSellAbi, functionName: 'previewSellTokens', args: [bal],
            });
          } catch {
            if (DBG) console.warn('[Seller] previewSellTokens unavailable; skipping');
            continue;
          }
          if (kasOut === 0n) continue;

          // 4) estimate sell gas → NET proceeds
          let estGas: bigint;
          try {
            const sim = await pub.simulateContract({
              address: pos.curve, abi: curveSellAbi, functionName: 'sellTokens',
              args: [bal, 1n], account: wal.account,
            });
            estGas = sim?.request?.gas ?? 120_000n;
          } catch { estGas = 120_000n; }

          let maxFeePerGas: bigint;
          try { maxFeePerGas = (await pub.estimateFeesPerGas()).maxFeePerGas!; }
          catch { maxFeePerGas = await pub.getGasPrice(); }

          const sellGasWei = estGas * maxFeePerGas;
          const netKasWei  = kasOut - sellGasWei; // proceeds after sell gas

          // 5) P&L (buy cost already includes buy gas)
          const denom  = pos.totalCostWei === 0n ? 1n : pos.totalCostWei;
          const pnlBps = Number(((netKasWei - pos.totalCostWei) * 10000n) / denom);

          // Decision gate
          const useSL   = typeof cfg.hardStopBps === 'number' && cfg.hardStopBps > 0;
          // Optional fixed floor added to TP threshold:
          const needWei = ((pos.totalCostWei * BigInt(10000 + cfg.takeProfitBps)) / 10000n) + MIN_PROFIT_WEI;
          const shouldTP = netKasWei >= needWei;
          const shouldSL = useSL && pnlBps <= -cfg.hardStopBps;

          // Hard safety: if SL is OFF, never sell at a loss
          if (!shouldTP && !shouldSL) {
            if (DBG) console.log(`[Seller] skip: pnlBps=${pnlBps} TPbps=${cfg.takeProfitBps} SL=${useSL ? cfg.hardStopBps : 'OFF'}`);
            continue;
          }
          if (!useSL && pnlBps < 0) {
            if (DBG) console.warn(`[Seller] negative PnL sell blocked (SL OFF) pnlBps=${pnlBps}`);
            continue;
          }

          // 6) enter critical section
          inFlight.add(key);

          // 7) allowance (wait receipts)
          await ensureAllowance(pub, wal, pos.token as Address, pos.curve as Address, bal);

          // 8) re-check balance right before sell
          const bal2: bigint = await pub.readContract({
            address: pos.token, abi: erc20Abi, functionName: 'balanceOf',
            args: [wal.account.address as Address],
          });
          if (bal2 === 0n) { removePosition(pos.token as Address); inFlight.delete(key); continue; }

          // 9) recompute minOut from current quote & slippage
          const kasOut2: bigint = await pub.readContract({
            address: pos.curve, abi: curveSellAbi, functionName: 'previewSellTokens', args: [bal2],
          });
          if (kasOut2 === 0n) { inFlight.delete(key); continue; }

          const minOut = (kasOut2 * BigInt(10000 - cfg.slippageBps)) / 10000n;

          // 10) simulate then send, wait receipt, clear position
          await pub.simulateContract({
            address: pos.curve, abi: curveSellAbi, functionName: 'sellTokens',
            args: [bal2, minOut], account: wal.account,
          });

          const tx = await wal.writeContract({
            address: pos.curve, abi: curveSellAbi, functionName: 'sellTokens',
            args: [bal2, minOut],
          });

          console.log(`[Seller] token=${pos.token} curve=${pos.curve} sell-all tx=${tx} pnlBps=${pnlBps}`);

          const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
          if (rcpt.status === 'success') removePosition(pos.token as Address);

        } catch (e: any) {
          const msg = String(e?.shortMessage || e?.message || '');
          if (msg.includes('insufficient allowance')) {
            console.warn('[Seller] allowance race; will retry');
          } else if (msg.includes('transfer amount exceeds balance')) {
            console.warn('[Seller] balance changed / already sold; clearing position');
            removePosition(pos.token as Address);
          } else {
            console.error('[Seller] error', e);
          }
        } finally {
          inFlight.delete(key);
        }
      }
    },

    onError: (e: any) => {
      if (String(e?.shortMessage || '').includes('Block at number')) {
        if (DBG) console.warn('[SellLoop] transient BlockNotFound (ignored)');
        return;
      }
      console.error('[SellLoop] watchBlocks error', e);
    },
  });
}

