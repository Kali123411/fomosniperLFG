import { createPublicClient, createWalletClient, http, webSocket, fallback, type Address, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { factoryAbi, curveGradAbi, LFG_FACTORY } from './abi/grad';

const CHAIN = {
  id: 202555,
  name: 'Kasplex Mainnet',
  nativeCurrency: { name: 'WKAS', symbol: 'WKAS', decimals: 18 },
  rpcUrls: { http: ['https://evmrpc.kasplex.org'], webSocket: ['wss://evmws.kasplex.org'] },
} as const;

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`Missing env ${k}`); })();

const PK  = env('PRIVATE_KEY');              // 0x + 64 hex
const TIP_BPS = Number(env('GAS_TIP_BPS', '2000'));      // +20% tip over base
const REPLACE_AFTER_MS = Number(env('REPLACE_AFTER_MS', '8000')); // 8s
const MAX_REPLACEMENTS = Number(env('MAX_REPLACEMENTS', '3'));

const account = privateKeyToAccount(PK as `0x${string}`);
const transport = fallback([
  webSocket(CHAIN.rpcUrls.webSocket[0], { retryCount: Infinity, retryDelay: 1000 }),
  http(CHAIN.rpcUrls.http[0]),
]);

const pub = createPublicClient({ chain: CHAIN, transport });
const wal = createWalletClient({ chain: CHAIN, account, transport: http(CHAIN.rpcUrls.http[0]) });

type CurveInfo = { curve: Address; token: Address; graduated?: boolean };

const active = new Map<Address, CurveInfo>();

async function discoverBackfill() {
  const latest = await pub.getBlockNumber();
  const from = latest - 10_000n;
  const logs = await pub.getLogs({ address: LFG_FACTORY as Address, fromBlock: from, toBlock: latest });
  for (const L of logs) {
    try {
      const { eventName, args } = decodeEventLog({ abi: factoryAbi, ...L });
      if (eventName === 'CurveCreated') {
        const curve = (args as any).curve as Address;
        const token = (args as any).token as Address;
        active.set(curve, { curve, token });
      }
    } catch {}
  }
  console.log(`[GradBot] Backfilled curves: ${active.size}`);
}

function startFactoryWatch() {
  return pub.watchEvent({
    address: LFG_FACTORY as Address,
    onLogs: (logs) => {
      for (const L of logs) {
        try {
          const { eventName, args } = decodeEventLog({ abi: factoryAbi, ...L });
          if (eventName === 'CurveCreated') {
            const curve = (args as any).curve as Address;
            const token = (args as any).token as Address;
            active.set(curve, { curve, token });
            console.log(`[GradBot] new curve=${curve} token=${token}`);
          }
        } catch (e) { /* ignore */ }
      }
    },
    onError: (e) => console.error('watchEvent error', e),
  });
}

async function isGraduated(curve: Address) {
  try {
    return await pub.readContract({ address: curve, abi: curveGradAbi, functionName:'graduated' });
  } catch { return false; }
}

async function canGraduate(curve: Address) {
  try {
    const ok = await pub.readContract({ address: curve, abi: curveGradAbi, functionName:'isGraduatable' });
    if (ok) return { ok, progress: 10000n };
  } catch {}
  try {
    const bps = await pub.readContract({ address: curve, abi: curveGradAbi, functionName:'progressBps' }) as bigint;
    return { ok: bps >= 10000n, progress: bps };
  } catch { /* last resort */ }
  return { ok: false, progress: 0n };
}

async function graduate(curve: Address) {
  // gas with tip bump
  const fees = await pub.estimateFeesPerGas();
  let mp = fees.maxPriorityFeePerGas!;
  let mf = fees.maxFeePerGas!;
  const bump = (x: bigint) => x + (x * BigInt(TIP_BPS)) / 10000n;
  mp = bump(mp); mf = bump(mf);

  // simulate first for determinism
  const sim = await pub.simulateContract({
    address: curve, abi: curveGradAbi, functionName: 'graduate', account,
  });

  let req = { ...sim.request, maxPriorityFeePerGas: mp, maxFeePerGas: mf };
  let hash = await wal.writeContract(req);
  console.log(`[GradBot] sent graduate tx=${hash}`);

  let tries = 0;
  const start = Date.now();
  while (tries < MAX_REPLACEMENTS) {
    try {
      const rec = await pub.waitForTransactionReceipt({ hash, timeout: REPLACE_AFTER_MS, confirmations: 1 });
      console.log(`[GradBot] CONFIRMED ${hash} in block ${rec.blockNumber}`);
      return true;
    } catch {
      // replace w/ higher tip
      tries++;
      mp = bump(mp); mf = bump(mf);
      req = { ...req, maxPriorityFeePerGas: mp, maxFeePerGas: mf, nonce: req.nonce }; // same nonce replacement
      hash = await wal.writeContract(req);
      console.log(`[GradBot] replaced (try ${tries}) tx=${hash}`);
    }
  }
  console.warn(`[GradBot] gave up after ${(Date.now()-start)/1000}s`);
  return false;
}

async function tick() {
  for (const [curve, info] of active) {
    if (info.graduated) continue;
    if (await isGraduated(curve)) { info.graduated = true; continue; }

    const g = await canGraduate(curve);
    if (!g.ok) continue;

    console.log(`[GradBot] curve=${curve} progress=${g.progress} -> attempting graduation`);
    // small random jitter (1-50ms) so we don't align all retries on block edges
    await new Promise(r => setTimeout(r, Math.floor(Math.random()*50)));
    try {
      const ok = await graduate(curve);
      if (ok) info.graduated = true;
    } catch (e) {
      console.error(`[GradBot] graduate failed`, e);
    }
  }
}

async function main() {
  console.table({
    PRIVATE: `${account.address.slice(0,6)}…`,
    TIP_BPS: TIP_BPS,
    REPLACE_AFTER_MS: REPLACE_AFTER_MS,
  });
  await discoverBackfill();
  const unwatch = startFactoryWatch();

  // block loop
  pub.watchBlocks({
    onBlock: async () => {
      try { await tick(); } catch (e) { console.error('tick error', e); }
    },
    onError: (e) => console.error('watchBlocks error', e),
    emitMissed: true,
    poll: false,
  });

  process.on('SIGINT', () => { unwatch?.(); process.exit(0); });
}
main().catch(err => { console.error(err); process.exit(1); });
