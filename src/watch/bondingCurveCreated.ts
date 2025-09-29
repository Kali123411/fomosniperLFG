import { formatUnits, getContract, type Address } from "viem";
import { appConfig } from "../appConfig";
import { Logger } from "../logger/logger";
import { rpcClient, wsClient } from "../network/clients";
import kaspacomLfgFactory from "../types/abis/kaspacom-lfg-factory";
import printTokenDetailsTable from "../util/printTokenDetailsTable";
import { walletClient } from "../network/wallet";
import kaspacomLfgBondingCurve from "../types/abis/kaspacom-lfg-bonding-curve";
import printPurchaseEstimationTable from "../util/printPurchaseEstimationTable";
import printTransactionRequest from "../util/printTransactionRequest";
import { randomizeAmount } from "../util/randomizeAmount";
import { onBuy } from "../positions";

const logger = new Logger("LFGWatcher");

export async function watchBondingSystemCreated() {
  logger.info("Listening to BondingSystemCreated events... ");

  wsClient.watchContractEvent({
    address: appConfig.lfg.factoryAddress as Address,
    abi: kaspacomLfgFactory,
    onError: (e) => {
      logger.error(
        `watchContractEvent error: ${e instanceof Error ? e.message : String(e)}`
      );
    },
    onLogs: async (logs) => {
      for (const eventLog of logs) {
        // Some providers don’t always surface eventName reliably; guard & continue (do not return).
        if (eventLog.eventName !== "BondingSystemCreated") continue;

        try {
          const {
            token,
            bondingCurve: bondingCurveAddress,
            tokenDetails: tokenDetailsString,
            totalSupply,
            devPurchaseETH,
            isHypedLaunch,
          } = eventLog.args as {
            token: Address;
            bondingCurve: Address;
            tokenDetails: string;
            totalSupply: bigint;
            devPurchaseETH: bigint;
            isHypedLaunch: boolean;
          };

          if (
            !token ||
            !bondingCurveAddress ||
            !tokenDetailsString ||
            totalSupply === undefined ||
            devPurchaseETH === undefined ||
            isHypedLaunch === undefined
          ) {
            logger.warn("Invalid event log, did LFG change?");
            continue;
          }

          const tokenDetails = JSON.parse(tokenDetailsString) as {
            symbol: string;
            name: string;
          };

          // randomized buy size (keeps your original behavior)
          const purchaseAmount = randomizeAmount(
            BigInt(appConfig.bot.purchaseAmount)
          );

          logger.info(
            `New bonding curve created! Token: <c_bold>${token}</c_bold>, Bonding Curve: <c_bold>${bondingCurveAddress}</c_bold>`
          );

          printTokenDetailsTable({
            symbol: tokenDetails.symbol,
            name: tokenDetails.name,
            devPurchaseKAS: devPurchaseETH,
            isHypedLaunch: isHypedLaunch,
            totalSupply: formatUnits(totalSupply, 18),
          });

          const bondingCurve = getContract({
            address: bondingCurveAddress,
            abi: kaspacomLfgBondingCurve,
            client: { public: rpcClient, wallet: walletClient },
          });

          // Quote expected tokens from purchaseAmount for minOut
          const estimation = await bondingCurve.read.previewBuyTokens([
            purchaseAmount,
          ]);

          printPurchaseEstimationTable(
            estimation,
            purchaseAmount,
            tokenDetails.symbol,
            bondingCurveAddress
          );

          // ----- Gas (EIP-1559-ish using your existing approach) -----
          const baseGasFee = await rpcClient.getGasPrice(); // wei
          const gasBribeBps = BigInt(appConfig.bot.gasBribeBps); // e.g., 1500 = +15%
          const maxPriorityFeePerGas = (baseGasFee * gasBribeBps) / 10_000n;
          const maxFeePerGas = baseGasFee + maxPriorityFeePerGas;

          const minOut =
            (estimation * (10_000n - BigInt(appConfig.bot.slippageBps))) /
            10_000n;

          // ---- LFG simulate-until-allowed bypass ----
          let sim:
            | {
                request: {
                  to: Address;
                  data: `0x${string}`;
                  value?: bigint;
                  maxPriorityFeePerGas?: bigint;
                  maxFeePerGas?: bigint;
                  account?: Address;
                  gas?: bigint; // sometimes present
                };
              }
            | null = null;

          while (true) {
            sim = await rpcClient
              .simulateContract({
                account: walletClient.account,
                address: bondingCurveAddress,
                abi: kaspacomLfgBondingCurve,
                functionName: "buyTokens",
                args: [minOut],
                value: purchaseAmount,
                maxPriorityFeePerGas,
                maxFeePerGas,
              })
              .catch(() => {
                logger.warn("Cannot send tx yet.");
                return null;
              });

            if (sim) break;
          }

          // ---------- ROUND-TRIP GAS GUARD ----------
          // Estimate buy gas (prefer simulate gas hint; fallback to estimateGas)
          let estBuyGas =
            sim.request.gas ??
            (await rpcClient
              .estimateGas({
                account: walletClient.account,
                address: bondingCurveAddress,
                abi: kaspacomLfgBondingCurve,
                functionName: "buyTokens",
                args: [minOut],
                value: purchaseAmount,
                maxPriorityFeePerGas,
                maxFeePerGas,
              })
              .catch(() => 110_000n)); // conservative fallback

          const buyGasWei = estBuyGas * maxFeePerGas;
          const buyGasKas = Number(buyGasWei) / 1e18;

          const approveSellKas = Number(
            process.env.APPROVE_SELL_KAS ?? "0.22"
          ); // tweak after observing a few sells
          const purchaseKas = Number(purchaseAmount) / 1e18;
          const rtShare = (buyGasKas + approveSellKas) / purchaseKas;
          const maxRtShare = Number(
            process.env.MAX_RT_GAS_SHARE ?? "0.35"
          ); // 35% guard by default

          if (rtShare > maxRtShare) {
            logger.warn(
              `[Guard] Skip buy: round-trip gas ${(rtShare * 100).toFixed(
                1
              )}% > ${(maxRtShare * 100).toFixed(0)}%`
            );
            continue;
          }

          // ---------- Send the buy ----------
          const tx = await walletClient.writeContract(sim.request);
          logger.info(`Purchase transaction sent: <c_bold>${tx}</c_bold>`);

          const receipt = await rpcClient
            .waitForTransactionReceipt({ hash: tx })
            .catch((e) => {
              logger.error(e);
              return { status: "error" } as const;
            });

          if (receipt.status === "error") {
            logger.error("Transaction failed!");
            continue;
          }

          if (receipt.status === "success") {
            printTransactionRequest(receipt);
            logger.info(
              `Purchase transaction confirmed! At hash <c_bold>${tx}</c_bold>`
            );
            logger.success(
              "<c_green><c_bold>Purchase complete!</c_bold></c_green>"
            );

            // *** Include BUY GAS in cost basis ***
            const gasWei = receipt.effectiveGasPrice! * receipt.gasUsed!;
            const spentWei = purchaseAmount + gasWei;

            onBuy(
              token as Address,
              bondingCurveAddress as Address,
              spentWei,
              receipt.blockNumber!
            );
            logger.info(
              `[Buyer] position recorded token=${token} curve=${bondingCurveAddress} spentWei=${spentWei.toString()} block=${receipt.blockNumber!.toString()}`
            );
          } else {
            logger.error(`Purchase transaction failed!`);
          }
        } catch (err) {
          logger.error(
            `Watcher loop error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
  });

  // keep alive
  await new Promise<void>(() => {});
}

