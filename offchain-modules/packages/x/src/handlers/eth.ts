import { BigNumber } from 'ethers';
import { ChainType, EthAsset } from '../ckb/model/asset';
import { forceBridgeRole } from '../config';
import { ForceBridgeCore } from '../core';
import { EthDb, KVDb, BridgeFeeDB } from '../db';
import { EthUnlockStatus } from '../db/entity/EthUnlock';
import { EthUnlock, IEthUnlock } from '../db/model';
import { asserts, nonNullable } from '../errors';
import { BridgeMetricSingleton, txTokenInfo } from '../metric/bridge-metric';
import { ethCollectSignaturesPayload } from '../multisig/multisig-mgr';
import { asyncSleep, foreverPromise, fromHexString, uint8ArrayToString } from '../utils';
import { logger } from '../utils/logger';
import { EthChain, WithdrawBridgeFeeTopic, Log, ParsedLog } from '../xchain/eth';
import { checkLock } from '../xchain/eth/check';

const MAX_RETRY_TIMES = 3;
const lastHandleEthBlockKey = 'lastHandleEthBlock';

export interface ParsedLockLog {
  txHash: string;
  sender: string;
  token: string;
  amount: string;
  recipient: string;
  sudtExtraData: string;
  blockNumber: number;
  blockHash: string;
  asset: EthAsset;
}

export class EthHandler {
  private lastHandledBlockHeight: number;
  private lastHandledBlockHash: string;

  constructor(
    private ethDb: EthDb,
    private feeDb: BridgeFeeDB,
    private kvDb: KVDb,
    private ethChain: EthChain,
    private role: forceBridgeRole,
  ) {}

  async getLastHandledBlock(): Promise<{ blockNumber: number; blockHash: string }> {
    const lastHandledBlock = await this.kvDb.get(lastHandleEthBlockKey);
    if (!lastHandledBlock) {
      return { blockNumber: 0, blockHash: '' };
    }
    const block = lastHandledBlock.split(',');
    return { blockNumber: parseInt(block[0]), blockHash: block[1] };
  }

  async setLastHandledBlock(blockNumber: number, blockHash: string): Promise<void> {
    this.lastHandledBlockHeight = blockNumber;
    this.lastHandledBlockHash = blockHash;
    await this.kvDb.set(lastHandleEthBlockKey, `${blockNumber},${blockHash}`);
  }

  getHandledBlock(): { height: number; hash: string } {
    return { height: this.lastHandledBlockHeight, hash: this.lastHandledBlockHash };
  }

  async getTipBlock(): Promise<{ height: number; hash: string }> {
    const tipHeight = await this.ethChain.getCurrentBlockNumber();
    const tipBlock = await this.ethChain.getBlock(tipHeight);
    return { height: tipHeight, hash: tipBlock.hash };
  }

  async init(): Promise<void> {
    const currentBlockHeight = await this.ethChain.getCurrentBlockNumber();
    const lastHandledBlock = await this.getLastHandledBlock();
    if (lastHandledBlock.blockNumber === 0) {
      let lastHandledBlockHeight = currentBlockHeight;
      if (ForceBridgeCore.config.eth.startBlockHeight > 0) {
        lastHandledBlockHeight = ForceBridgeCore.config.eth.startBlockHeight;
      }
      const currentBlock = await this.ethChain.getBlock(lastHandledBlockHeight);
      this.lastHandledBlockHash = currentBlock.hash;
      this.lastHandledBlockHeight = currentBlock.number;
    } else {
      this.lastHandledBlockHash = lastHandledBlock.blockHash;
      this.lastHandledBlockHeight = lastHandledBlock.blockNumber;
    }

    logger.info(
      `EthHandler init lastHandledBlock:${this.lastHandledBlockHeight} currentBlockHeight: ${currentBlockHeight}`,
    );
  }

  async watchNewBlock(): Promise<void> {
    // set lastHandledBlock
    await this.init();
    const maxBatchSize = 5000;
    let currentHeight: number | null = null;
    foreverPromise(
      async () => {
        let block = await this.ethChain.getBlock('latest');
        currentHeight = block.number;
        logger.info(`currentHeight: ${currentHeight}, lastHandledBlock: ${this.lastHandledBlockHeight}`);
        if (currentHeight - this.lastHandledBlockHeight < 1) {
          // already handled, wait for new block
          await asyncSleep(15000);
          return;
        }
        const confirmBlockNumber = this.lastHandledBlockHeight - ForceBridgeCore.config.eth.confirmNumber;
        const startBlockNumber = (confirmBlockNumber < 0 ? 0 : confirmBlockNumber) + 1;

        let endBlockNumber = currentHeight;
        if (currentHeight - this.lastHandledBlockHeight > maxBatchSize) {
          endBlockNumber = this.lastHandledBlockHeight + maxBatchSize;
          block = await this.ethChain.getBlock(endBlockNumber);
        }
        asserts(startBlockNumber <= endBlockNumber);
        const logs = await this.ethChain.getLogs(startBlockNumber, endBlockNumber);
        logger.info(
          `EthHandler onBlock handle logs from ${startBlockNumber} to ${endBlockNumber}, logs: ${JSON.stringify(logs)}`,
        );
        for (const log of logs) {
          await this.handleLog(log, currentHeight);
        }
        await this.setLastHandledBlock(block.number, block.hash);
        BridgeMetricSingleton.getInstance(this.role).setBlockHeightMetrics('eth', endBlockNumber, block.number);
        logger.info(`EthHandler onBlock blockHeight:${block.number} blockHash:${block.hash}`);
      },
      {
        onRejectedInterval: 15000,
        onResolvedInterval: 0,
        onRejected: (e: Error) => {
          logger.warn(`Eth watchNewBlock blockHeight:${currentHeight} error:${e.stack}`);
        },
      },
    );
  }

  async handleLog(log: Log, currentHeight: number): Promise<void> {
    const parsedLog = await this.ethChain.iface.parseLog(log);
    if (parsedLog.name === 'Locked') {
      await this.onLockLogs(log, parsedLog, currentHeight);
    } else if (parsedLog.name === 'Unlocked') {
      await this.onUnlockLogs(log, parsedLog);
    } else {
      logger.info(`not handled log type ${parsedLog.name}, log: ${JSON.stringify(log)}`);
    }
  }

  async onLockLogs(log: Log, parsedLog: ParsedLog, currentHeight: number): Promise<void> {
    const parsedLockLog = parseLockLog(log, parsedLog);
    const { amount, asset, token, sudtExtraData, sender, txHash, recipient, blockNumber, blockHash } = parsedLockLog;
    const bridgeFee = this.role === 'collector' ? asset.getBridgeFee('in') : '0';
    const records = await this.ethDb.getEthLocksByTxHashes([txHash]);
    if (records.length > 1) {
      logger.error('unexpected db find error', records);
      throw new Error(`unexpected db find error, records.length = ${records.length}`);
    }
    const confirmedNumber = currentHeight - log.blockNumber;
    const confirmed = confirmedNumber >= ForceBridgeCore.config.eth.confirmNumber;
    // create new EthLock record
    if (records.length === 0) {
      logger.info(
        `EthHandler watchLockEvents receiveLog blockHeight:${blockNumber} blockHash:${log.blockHash} txHash:${
          log.transactionHash
        } amount:${parsedLog.args.lockedAmount.toString()} asset:${parsedLog.args.token} recipientLockscript:${
          parsedLog.args.recipientLockscript
        } sudtExtraData:${parsedLog.args.sudtExtraData} sender:${
          parsedLog.args.sender
        }, confirmedNumber: ${confirmedNumber}, confirmed: ${confirmed}`,
      );
      logger.debug('EthHandler watchLockEvents eth lockEvtLog:', { log, parsedLog });
      const filterReason = checkLock(
        parsedLockLog.amount,
        parsedLockLog.token,
        parsedLockLog.recipient,
        parsedLockLog.sudtExtraData,
      );
      if (filterReason !== '') {
        logger.warn(`skip record ${JSON.stringify(parsedLog)}, reason: ${filterReason}`);
        return;
      }
      await this.ethDb.createEthLock([
        {
          txHash,
          amount,
          bridgeFee,
          token,
          recipient,
          sudtExtraData,
          blockNumber,
          blockHash,
          sender,
          confirmNumber: confirmedNumber,
          confirmStatus: confirmed ? 'confirmed' : 'unconfirmed',
        },
      ]);
      BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('eth_lock', 'success');
      BridgeMetricSingleton.getInstance(this.role).addBridgeTokenMetrics('eth_lock', [
        {
          amount: Number(amount),
          token: token,
        },
      ]);
      logger.info(`EthHandler watchLockEvents save EthLock successful for eth tx ${log.transactionHash}.`);
      if (this.role !== 'collector') {
        await this.ethDb.updateBridgeInRecord(txHash, amount, token, recipient, sudtExtraData);
        logger.info(
          `Watcher update bridge in record successful while handle lock log for eth tx ${log.transactionHash}.`,
        );
      }
    }
    if (records.length === 1) {
      await this.ethDb.updateLockConfirmNumber([{ txHash, confirmedNumber }]);
      if (confirmed) {
        await this.ethDb.updateLockConfirmStatus([txHash]);
      }
      logger.info(`update lock record ${txHash} status, confirmed number: ${confirmedNumber}, status: ${confirmed}`);
    }
    if (confirmed && this.role === 'collector') {
      if (BigInt(amount) <= BigInt(bridgeFee)) throw new Error('Unexpected error: lock amount less than bridge fee');
      const mintRecords = {
        id: txHash,
        lockBlockHeight: blockNumber,
        chain: ChainType.ETH,
        amount: (BigInt(amount) - BigInt(bridgeFee)).toString(),
        asset: token,
        recipientLockscript: recipient,
        sudtExtraData,
      };
      await this.ethDb.createCkbMint([mintRecords]);
      logger.info(`save CkbMint successful for eth tx ${txHash}`);
    }
  }

  async onUnlockLogs(log: Log, parsedLog: ParsedLog): Promise<void> {
    for (let i = 1; i <= MAX_RETRY_TIMES; i++) {
      try {
        const amount = parsedLog.args.receivedAmount.toString();
        const { ckbTxHash, recipient, token } = parsedLog.args;
        const unlockTxHash = log.transactionHash;
        logger.info(
          `EthHandler watchUnlockEvents receiveLog blockHeight:${log.blockNumber} blockHash:${log.blockHash} txHash:${unlockTxHash} amount:${amount} asset:${parsedLog.args.token} recipient:${parsedLog.args.recipient} ckbTxHash:${ckbTxHash} sender:${parsedLog.args.sender}`,
        );
        logger.debug('EthHandler watchUnlockEvents eth unlockLog:', { log, parsedLog });
        if (ckbTxHash === WithdrawBridgeFeeTopic) {
          await this.feeDb.createWithdrawedBridgeFee([
            {
              txHash: unlockTxHash,
              blockNumber: log.blockNumber,
              recipient: recipient,
              chain: ChainType.ETH,
              asset: token,
              amount: amount,
            },
          ]);
          return;
        }
        if (this.role === 'collector') {
          await this.ethDb.updateUnlockStatus(log.blockNumber, unlockTxHash, 'success');
        } else {
          await this.ethDb.createEthUnlock([
            {
              ckbTxHash: ckbTxHash,
              amount: amount,
              asset: token,
              recipientAddress: recipient,
              blockNumber: log.blockNumber,
              ethTxHash: unlockTxHash,
              status: 'success',
            },
          ]);
          await this.ethDb.updateBurnBridgeFee(ckbTxHash, amount);
        }
        BridgeMetricSingleton.getInstance(this.role).addBridgeTokenMetrics('eth_unlock', [
          {
            amount: Number(amount),
            token: parsedLog.args.token,
          },
        ]);
        break;
      } catch (e) {
        logger.error(`EthHandler watchUnlockEvents error: ${e}`);
        if (i == MAX_RETRY_TIMES) {
          throw e;
        }
        await asyncSleep(3000);
      }
    }
  }

  async getUnlockRecords(status: EthUnlockStatus): Promise<EthUnlock[]> {
    return this.ethDb.getEthUnlockRecordsToUnlock(status);
  }

  // watch the eth_unlock table and handle the new unlock events
  // send tx according to the data
  handleUnlockRecords(): void {
    if (this.role !== 'collector') {
      return;
    }

    this.handlePendingUnlockRecords().then(
      () => {
        this.handleTodoUnlockRecords();
      },
      (err) => {
        logger.error(`handlePendingUnlockRecords error:${err.stack}`);
      },
    );
  }

  async handlePendingUnlockRecords(): Promise<void> {
    for (;;) {
      try {
        const records = await this.getUnlockRecords('pending');
        const pendingTx = await this.ethChain.getMultiSigMgr().getPendingTx({ chain: 'eth' });
        if (pendingTx === undefined && records.length !== 0) {
          //pendingTx has already completed
          records.map((record) => {
            record.status = 'success';
          });
          const unlockTxHashes = records.map((record) => {
            return record.ckbTxHash;
          });
          await this.ethDb.saveEthUnlock(records);
          logger.info(`EthHandler handlePendingUnlockRecords set Record to complete ckbTxHashes:${unlockTxHashes}`);
          break;
        }
        if (records.length !== 0) {
          await this.doHandleUnlockRecords(records);
          break;
        }
        if (pendingTx !== undefined) {
          logger.info(`EthHandler handlePendingUnlockRecords pendingTx:${JSON.stringify(pendingTx, undefined, 2)}`);
          await this.doHandleUnlockRecords(
            (pendingTx.payload as ethCollectSignaturesPayload).unlockRecords.map((ethUnlock) => {
              return {
                ckbTxHash: ethUnlock.ckbTxHash,
                asset: ethUnlock.token,
                recipientAddress: ethUnlock.recipient,
                amount: BigNumber.from(ethUnlock.amount).toString(),
                ethTxHash: '',
                status: 'pending',
                message: '',
              };
            }),
          );
        }
        break;
      } catch (e) {
        logger.error(`doHandlePendingUnlockRecords error:${e.message} stack:${e.stack}`);
        await asyncSleep(3000);
      }
    }
  }

  handleTodoUnlockRecords(): void {
    foreverPromise(
      async () => {
        await asyncSleep(15000);
        logger.debug('EthHandler watchUnlockEvents get new unlock events and send tx');
        const records = await this.getUnlockRecords('todo');
        if (records.length === 0 || this.waitForBatch(records)) {
          logger.info('wait for batch');
          return;
        }
        logger.info(`EthHandler watchUnlockEvents unlock records: ${JSON.stringify(records)}`);
        await this.doHandleUnlockRecords(records);
      },
      {
        onRejectedInterval: 0,
        onResolvedInterval: 0,
        onRejected: (e: Error) => {
          logger.error(`ETH handleTodoUnlockRecords error:${e.message}`);
        },
      },
    );
  }

  async doHandleUnlockRecords(records: IEthUnlock[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const unlockTxHashes = records
      .map((unlockRecord) => {
        return unlockRecord.ckbTxHash;
      })
      .join(', ');
    logger.info(
      `EthHandler doHandleUnlockRecords start process unlock Record, ckbTxHashes:${unlockTxHashes} num:${records.length}`,
    );

    for (;;) {
      try {
        // check gas price
        const gasPrice = await this.ethChain.getGasPrice();
        const gasPriceLimit = BigNumber.from(nonNullable(ForceBridgeCore.config.collector).gasPriceGweiLimit * 10 ** 9);
        logger.debug(`gasPrice ${gasPrice}, gasPriceLimit ${gasPriceLimit}`);
        if (gasPrice.gt(gasPriceLimit)) {
          const waitSeconds = 30;
          logger.warn(`gasPrice ${gasPrice} exceeds limit ${gasPriceLimit}, waiting for ${waitSeconds}s`);
          await asyncSleep(waitSeconds * 1000);
          continue;
        }
        // write db first, avoid send tx success and fail to write db
        records.map((r) => {
          r.status = 'pending';
        });
        await this.ethDb.saveEthUnlock(records);
        const txRes = await this.ethChain.sendUnlockTxs(records, gasPrice);
        if (typeof txRes === 'boolean') {
          records.map((r) => {
            r.status = 'success';
          });
          break;
        }
        if (txRes instanceof Error) {
          if (records.length > 1) {
            logger.warn(`split batch unlock into separate ones for records: ${JSON.stringify(records)}`);
            for (const r of records) {
              await this.doHandleUnlockRecords([r]);
            }
            return;
          }
          records.map((r) => {
            r.status = 'error';
            r.message = (txRes as Error).message;
          });
          BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('eth_unlock', 'failed');
          logger.error(
            `EthHandler doHandleUnlockRecords ckbTxHashes:${unlockTxHashes}  sendUnlockTxs error:${txRes as Error}`,
          );
          break;
        }

        records.map((r) => {
          r.status = 'pending';
          r.ethTxHash = txRes.hash;
        });
        await this.ethDb.saveEthUnlock(records);
        logger.debug('sendUnlockTxs res', txRes);
        try {
          // wait() will reject if the tx fails
          // https://docs.ethers.io/v5/api/providers/types/#providers-TransactionResponse
          const receipt = await txRes.wait();
          logger.info(`EthHandler doHandleUnlockRecords sendUnlockTxs receipt:${JSON.stringify(receipt.logs)}`);
          records.map((r) => {
            r.status = 'success';
          });
          const unlockTokens = records.map((r) => {
            const tokenInfo: txTokenInfo = {
              amount: Number(r.amount),
              token: r.asset,
            };
            return tokenInfo;
          });
          BridgeMetricSingleton.getInstance(this.role).addBridgeTokenMetrics('eth_unlock', unlockTokens);
          BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('eth_unlock', 'success');
        } catch (error) {
          records.map((r) => {
            r.status = 'error';
            r.message = error.toString();
          });
          BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('eth_unlock', 'failed');
          logger.error(
            `EthHandler doHandleUnlockRecords ckbTxHashes:${unlockTxHashes} unlock execute failed:${error.stack}`,
          );
        }
        break;
      } catch (e) {
        logger.error(`EthHandler doHandleUnlockRecords ckbTxHashes:${unlockTxHashes} error:${e.stack}`);
        await asyncSleep(5000);
      }
    }
    for (;;) {
      try {
        await this.ethDb.saveEthUnlock(records);
        logger.info(`EthHandler doHandleUnlockRecords process unlock Record completed ckbTxHashes:${unlockTxHashes}`);
        break;
      } catch (e) {
        logger.error(
          `EthHandler doHandleUnlockRecords db.saveEthUnlock ckbTxHashes:${unlockTxHashes} error:${e.stack}`,
        );
        await asyncSleep(3000);
      }
    }
  }

  waitForBatch(records: EthUnlock[]): boolean {
    if (ForceBridgeCore.config.common.network === 'testnet') return false;
    const now = new Date();
    const maxWaitTime = ForceBridgeCore.config.eth.batchUnlock.maxWaitTime;
    if (
      records.find((record) => {
        return new Date(record.createdAt).getMilliseconds() + maxWaitTime <= now.getMilliseconds();
      })
    )
      return false;
    return records.length < ForceBridgeCore.config.eth.batchUnlock.batchNumber;
  }

  start(): void {
    void this.watchNewBlock();

    this.handleUnlockRecords();
    logger.info('eth handler started  🚀');
  }
}

export function parseLockLog(log: Log, parsedLog: ParsedLog): ParsedLockLog {
  const txHash = log.transactionHash;
  const { token, sudtExtraData, sender } = parsedLog.args;
  const amount = parsedLog.args.lockedAmount.toString();
  const asset = new EthAsset(parsedLog.args.token);
  const recipient = uint8ArrayToString(fromHexString(parsedLog.args.recipientLockscript));
  return {
    txHash: txHash,
    amount: amount,
    token: token,
    recipient: recipient,
    sudtExtraData: sudtExtraData,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    sender: sender,
    asset,
  };
}
