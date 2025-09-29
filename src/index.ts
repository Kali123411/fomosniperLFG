// src/index.ts
import { rpcClient, wsClient } from "./network/clients";
import { walletClient } from "./network/wallet"; // <-- adjust if your export name differs
import { Logger } from "./logger/logger";
import { BigMath } from "./util/bigMath";
import { watchBondingSystemCreated } from "./watch/bondingCurveCreated";
import { appConfig } from "./appConfig";
import { formatUnits } from "viem/utils";
import { startSellLoop } from "./processes/sell";
import { wsClient } from "./network/clients";

const log = new Logger("Main");

async function main() {
  log.info("Starting up...");

  console.table({
    purchaseAmount: formatUnits(BigInt(appConfig.bot.purchaseAmount), 18),
    slippagePercent: `${Number(appConfig.bot.slippageBps) / 100} %`,
    gasBribePercent: `${Number(appConfig.bot.gasBribeBps) / 100} %`,
    lfgFactory: appConfig.lfg.factoryAddress,
    rpcUrl: appConfig.connection.rpc.url,
    wsUrl: appConfig.connection.ws.url,
    network: `${appConfig.connection.network.name} (chainId: ${appConfig.connection.network.chainId})`,
  });

  // Sanity check: RPC/WS height
  const rpcBlockNumber = await rpcClient.getBlockNumber();
  const wsBlockNumber = await wsClient.getBlockNumber();

  if (BigMath.abs(rpcBlockNumber - wsBlockNumber) > 2) {
    log.warn(
      "Block number discrepancy possible! Bigger differences could result in increased latency"
    );
    log.info(`RPC Block Number: ${rpcBlockNumber}`);
    log.info(`WS Block Number: ${wsBlockNumber}`);
  } else {
    log.success("<c_green>OK</c_green>: RPC/WS in sync with each other");
  }

  // ---- SELL LOOP: start only after clients exist ----
  if (appConfig.sell?.enabled) {
    startSellLoop(wsClient, walletClient, {
      slippageBps:   appConfig.bot?.slippageBps ?? 300,
      takeProfitBps: appConfig.sell?.takeProfitBps ?? 400,
      hardStopBps:   appConfig.sell?.hardStopBps ?? 500,
      minHoldBlocks: appConfig.sell?.minHoldBlocks ?? 2,
    });
    log.info("[Seller] loop started");
  }

  // ---- BUY WATCHER ----
  await watchBondingSystemCreated();
}

main().catch((e) => {
  log.error(`Fatal error: ${e?.stack || e}`);
  process.exit(1);
});

