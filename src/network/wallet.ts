// src/network/wallet.ts
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { appConfig } from '../appConfig';

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment (.env): ${name}`);
  return v.trim();
}

const pk = requireEnv('PRIVATE_KEY');
if (!/^0x[0-9a-fA-F]{64}$/.test(pk))
  throw new Error('PRIVATE_KEY must be 0x + 64 hex chars');

export const walletClient = createWalletClient({
  account: privateKeyToAccount(pk as `0x${string}`),
  chain: {
    id: appConfig.connection.network.chainId,
    name: appConfig.connection.network.name,
    nativeCurrency: appConfig.connection.network.nativeCurrency,
    rpcUrls: { default: { http: [appConfig.connection.rpc.url] } },
  },
  transport: http(appConfig.connection.rpc.url),
});

