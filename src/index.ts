import { Keyring } from "@polkadot/keyring";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { BlockHash } from "@polkadot/types/interfaces";

function seedFromNum(seed: number): string {
    return '//user//' + ("0000" + seed).slice(-4);
}

async function getBlockStats(api: ApiPromise, hash?: BlockHash | undefined): Promise<any> {
    const signedBlock = hash ? await api.rpc.chain.getBlock(hash) : await api.rpc.chain.getBlock();

    // the hash for each extrinsic in the block
    let timestamp = signedBlock.block.extrinsics.find(
        ({ method: { method, section } }) => section === 'timestamp' && method === 'set'
    )!.method.args[0].toString();

    let date = new Date(+timestamp);

    return {
        date,
        transactions: signedBlock.block.extrinsics.length,
        parent: signedBlock.block.header.parentHash,
        blockNumber: signedBlock.block.header.number,
    }
}

function createPayloadBuilder(
    api: ApiPromise,
    tokensToSend: number,
    nonces: number[],
    totalThreads: number,
    totalBatches: number,
    usersPerThread: number,
    keyPairs: Map<number, KeyringPair>,
    rootKeyPair: KeyringPair): () => Promise<any[][][]> {

    return async function(): Promise<any[][][]> {
        let threadPayloads: any[][][] = [];
        let sanityCounter = 0;
        for (let thread = 0; thread < totalThreads; thread++) {
            let batches = [];
            for (let batchNo = 0; batchNo < totalBatches; batchNo++) {
                let batch = [];
                for (let userNo = thread * usersPerThread; userNo < (thread + 1) * usersPerThread; userNo++) {
                    let nonce = nonces[userNo];
                    nonces[userNo]++;
                    let senderKeyPair = keyPairs.get(userNo)!;

                    let transfer = api.tx.balances.transfer(rootKeyPair.address, tokensToSend);
                    let signedTransaction = transfer.sign(senderKeyPair, { nonce });

                    batch.push(signedTransaction);

                    sanityCounter++;

                    let noop = async function() {};
                    await noop();
                }
                batches.push(batch);
            }
            threadPayloads.push(batches);
        }
        console.log(`Done pregenerating transactions (${sanityCounter}).`);
        return threadPayloads;
    };
}

async function executeBatches(
    initialTime: Date,
    threadPayloads: any[][][],
    totalThreads: number,
    totalBatches: number,
    transactionPerBatch: number,
    finalisationTime: Uint32Array,
    finalisedTxs: Uint16Array,
    measureFinalisation: boolean,
) {
    let nextTime = new Date().getTime();
    finalisationTime[0] = 0;
    finalisedTxs[0] = 0;
    const submittedTxs = new Uint32Array(new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT));

    for (let batchNo = 0; batchNo < totalBatches; batchNo++) {

        while (new Date().getTime() < nextTime) {
            await new Promise(r => setTimeout(r, 5));
        }

        nextTime = nextTime + 1000;

        console.log(`Starting batch #${batchNo}`);
        let batchPromises = new Array<Promise<any[]>>();
        for (let threadNo = 0; threadNo < totalThreads; threadNo++) {
            batchPromises.push(
                new Promise<any[]>(async resolve => {
                    let errors = [];
                    for (let transactionNo = 0; transactionNo < transactionPerBatch; transactionNo++) {
                        let transaction = threadPayloads[threadNo][batchNo][transactionNo];
                        if (measureFinalisation) {
                            let thisResult = 0;
                            await transaction.send(({ status }) => {
                                if (status.isFinalized) {
                                    Atomics.add(finalisedTxs, 0, 1);
                                    let finalisationTimeCurrent = new Date().getTime() - initialTime.getTime();
                                    if (finalisationTimeCurrent > Atomics.load(finalisationTime, 0)) {
                                        Atomics.store(finalisationTime, 0, finalisationTimeCurrent);
                                    }
                                }
                            }).catch((err: any) => {
                                errors.push(err);
                                thisResult = -1;
                            });
                            if (thisResult == 0) {
                                Atomics.add(submittedTxs, 0, 1);
                            }
                        } else {
                            let thisResult = 0;
                            await transaction.send().catch((err: any) => {
                                errors.push(err);
                                thisResult = -1;
                            });
                            if (thisResult == 0) {
                                Atomics.add(submittedTxs, 0, 1);
                            }
                        }
                    }
                    resolve(errors);
                })
            );
        }
        let allErrors = await Promise.all(batchPromises);
        let errors = allErrors.reduce((res, val) => res.concat(val), []);

        if (errors.length > 0) {
            console.log(`${errors.length}/${transactionPerBatch * totalThreads} errors sending transactions`);
        }
    }
    let submitted = Atomics.load(submittedTxs, 0)
    console.log(`submitted ${submitted} txn(s)`);
}

async function collectStats(
    api: ApiPromise,
    initialTime: Date,
    measureFinalisation: boolean,
    finalisationTimeout: number,
    totalTransactions: number,
    finalisationAttempts: number,
    finalisedTxs: Uint16Array,
    finalisationTime: Uint32Array
) {
    let finalTime = new Date();
    let diff = finalTime.getTime() - initialTime.getTime();

    let total_transactions = 0;
    let total_blocks = 0;
    let latest_block = await getBlockStats(api);
    console.log(`latest block: ${latest_block.date}`);
    console.log(`initial time: ${initialTime}`);
    let prunedFlag = false;
    while (latest_block.date > initialTime) {
        try {
            latest_block = await getBlockStats(api, latest_block.parent);
        } catch (err) {
            console.log("Cannot retrieve block info with error: " + err.toString());
            console.log("Most probably the state is pruned already, stopping");
            prunedFlag = true;
            break;
        }
        if (latest_block.date < finalTime) {
            console.log(`block number ${latest_block.blockNumber}: ${latest_block.transactions} transactions`);
            total_transactions += latest_block.transactions;
            total_blocks++;
        }
    }

    let tps = (total_transactions * 1000) / diff;

    console.log(`* # of transactions from ${total_blocks} blocks: ${total_transactions}`);
    console.log(`* TPS from ${total_blocks} blocks: ${tps}`);

    if (measureFinalisation && !prunedFlag) {
        let attempt = 0;
        while (true) {
            console.log(`Wait ${finalisationTimeout} ms for transactions finalisation, attempt ${attempt} out of ${finalisationAttempts}`);
            let finalized = Atomics.load(finalisedTxs, 0)
            console.log(`Finalized ${finalized} out of ${totalTransactions}`);
            await new Promise(r => setTimeout(r, finalisationTimeout));

            if (Atomics.load(finalisedTxs, 0) < totalTransactions) {
                if (attempt == finalisationAttempts) {
                    // time limit reached
                    break;
                } else {
                    attempt++;
                }
            } else {
                break;
            }
        }
        console.log(`Finalized ${Atomics.load(finalisedTxs, 0)} out of ${totalTransactions} transactions, finalization time was ${Atomics.load(finalisationTime, 0)}`);
    }
}

async function retrieveTransactionsCount(initialTime: Date, finalTime: Date, api: ApiPromise): Promise<[number, number]> {
    let total_transactions = 0;
    let total_blocks = 0;
    let latest_block = await getBlockStats(api);
    while (latest_block.date > initialTime) {
        try {
            latest_block = await getBlockStats(api, latest_block.parent);
        } catch (err) {
            console.log("Cannot retrieve block info with error: " + err.toString());
            console.log("Most probably the state is pruned already, stopping");
            break;
        }
        if (latest_block.date < finalTime) {
            console.log(`block number ${latest_block.blockNumber}: ${latest_block.transactions} transactions`);
            total_transactions += latest_block.transactions;
            total_blocks++;
        }
    }
    return new Promise(resolve => resolve([total_transactions, total_blocks]));
}

async function keepCollectingStats(delay: number, api: ApiPromise) {
    let initialTime = new Date();
    let totalDiff = 0;
    let totalTransactions = 0;
    let totalBlocks = 0;
    while(true) {
        await new Promise(r => setTimeout(r, delay));
        let finalTime = new Date();

        let [transactions, blocks] = await retrieveTransactionsCount(initialTime, finalTime, api);

        let diff = finalTime.getTime() - initialTime.getTime();
        let tps = (transactions * 1000) / diff;
        console.log(`TPS from ${blocks} blocks: ${tps}`);

        totalTransactions += transactions;
        totalBlocks += blocks;
        totalDiff += diff;
        tps = (totalTransactions * 1000) / totalDiff;
        console.log(`TPS from total ${totalBlocks} blocks: ${tps}`);

        initialTime = finalTime;
    }
}

async function run() {
    let argv = require('minimist')(process.argv.slice(2));

    let TOTAL_TRANSACTIONS = argv.total_transactions ? argv.total_transactions : 25000;
    let TPS = argv.scale ? argv.scale : 100;
    let TOTAL_THREADS = argv.total_threads ? argv.total_threads : 10;
    let TOTAL_BATCHES = TOTAL_TRANSACTIONS / TPS;
    let TRANSACTION_PER_BATCH = TPS / TOTAL_THREADS;
    let WS_URL = argv.url ? argv.url : "ws://localhost:9944";
    let TOTAL_USERS = TPS;
    let USERS_PER_THREAD = TOTAL_USERS / TOTAL_THREADS;
    let TOKENS_TO_SEND = 1;
    let MEASURE_FINALIZATION = argv.finalization ? argv.finalization : false;
    let FINALISATION_TIMEOUT = argv.finalization_timeout ? argv.finalization_timeout : 20000; // 20 seconds
    let FINALISATION_ATTEMPTS = argv.finalization_attempts ? argv.finalization_attempts : 5;
    let ONLY_FLOODING = argv.only_flooding ? argv.only_flooding : false;
    let ROOT_ACCOUNT_URI = argv.root_account_uri ? argv.root_account_uri : "//Alice";
    let KEEP_COLLECTING_STATS = argv.keep_collecting_stats ? argv.keep_collecting_stats : false;
    let STATS_DELAY = argv.stats_delay ? argv.stats_delay : 40000;
    let LOOPS_COUNT = argv.loops_count ? argv.loops_count : 1;

    let provider = new WsProvider(WS_URL);

    let apiRequest = await Promise.race([
        ApiPromise.create({ provider }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]).catch(function(err) {
        throw Error(`Timeout error: ` + err.toString());
    });
    let api = apiRequest as ApiPromise;

    let keyring = new Keyring({ type: 'sr25519' });

    let nonces = [];

    console.log("Fetching nonces for accounts...");
    let nonZeroBalance = false;
    for (let i = 0; i < TOTAL_USERS; i++) {
        let stringSeed = seedFromNum(i);
        let keys = keyring.addFromUri(stringSeed);
        let accountInfo = await api.query.system.account(keys.address);
        let nonce = accountInfo.nonce.toNumber();
        if (!accountInfo.data.free.isZero()) {
            nonZeroBalance = true;
        }
        nonces.push(nonce)
    }
    console.log("All nonces fetched!");

    let rootKeyPair = keyring.addFromUri(ROOT_ACCOUNT_URI);
    let rootNonce = (await api.query.system.account(rootKeyPair.address)).nonce.toNumber();
    console.log("ROOT nonce is " + rootNonce);
    let keyPairs = new Map<number, KeyringPair>()

    for (let seed = 0; seed < TOTAL_USERS; seed++) {
        let keypair = keyring.addFromUri(seedFromNum(seed));
        keyPairs.set(seed, keypair);
    }

    if (!nonZeroBalance) {
        console.log("Endowing all users from ROOT account...");

        let finalized_transactions = 0;

        const rootFunds = (await api.query.system.account(rootKeyPair.address)).data.free;
        console.log(`ROOT's funds: ${rootFunds.toBigInt()}`);
        const allAvailableRootFunds = rootFunds.toBigInt() - api.consts.balances.existentialDeposit.toBigInt();
        const partialFeeUpperBound = (await api.tx.balances.transfer(rootKeyPair.address, allAvailableRootFunds).paymentInfo(rootKeyPair)).partialFee.toBigInt();
        const initialBalance = (allAvailableRootFunds / BigInt(TOTAL_USERS)) - partialFeeUpperBound;

        for (let seed = 0; seed < TOTAL_USERS; seed++) {
            let keypair = keyPairs.get(seed);

            let transfer = api.tx.balances.transfer(keypair.address, initialBalance);

            let receiverSeed = seedFromNum(seed);
            console.log(
                `ROOT -> ${receiverSeed} (${keypair.address}) ${initialBalance}`
            );
            await transfer.signAndSend(rootKeyPair, { nonce: rootNonce }, ({ status }) => {
                if (status.isFinalized) {
                    finalized_transactions++;
                }
            });
            rootNonce++;
        }
        console.log("All users endowed from the ROOT account!");

        console.log("Wait for transactions finalisation");
        await new Promise(r => setTimeout(r, FINALISATION_TIMEOUT));
        console.log(`Finalized transactions ${finalized_transactions}`);

        if (finalized_transactions != TOTAL_USERS) {
            throw Error(`Not all transactions finalized`);
        }
    }

    let payloadBuilder = createPayloadBuilder(api, TOKENS_TO_SEND, nonces, TOTAL_THREADS, TOTAL_BATCHES, USERS_PER_THREAD, keyPairs, rootKeyPair);
    let submitPromise: Promise<void> = new Promise(resolve => resolve());

    let statsPromise: Promise<void> = new Promise(resolve => resolve());
    if (KEEP_COLLECTING_STATS) {
        statsPromise = new Promise(resolve => {
            keepCollectingStats(STATS_DELAY, api);
            resolve();
        });
    }

    let loopsExecuted = 0;
    while (loopsExecuted < LOOPS_COUNT) {
        loopsExecuted += 1;

        console.log(`Pregenerating ${TOTAL_TRANSACTIONS} transactions across ${TOTAL_THREADS} threads...`);
        let threadPayloads = await payloadBuilder();

        // wait for the previous batch before you start a new one
        console.log("Awaiting previous batch to finish...");
        await submitPromise;
        console.log("Previous batch finished");

        submitPromise = new Promise(async resolve => {
            let initialTime = new Date();
            const finalisationTime = new Uint32Array(new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT));
            const finalisedTxs = new Uint16Array(new SharedArrayBuffer(Uint16Array.BYTES_PER_ELEMENT));

            await executeBatches(initialTime, threadPayloads, TOTAL_THREADS, TOTAL_BATCHES, TRANSACTION_PER_BATCH, finalisationTime, finalisedTxs, MEASURE_FINALIZATION);
            if (ONLY_FLOODING) {
                return resolve();
            }
            await collectStats(api, initialTime, MEASURE_FINALIZATION, FINALISATION_TIMEOUT, TOTAL_TRANSACTIONS, FINALISATION_ATTEMPTS, finalisedTxs, finalisationTime);
            return resolve();
        });

    }
    console.log("Awaiting previous batch to finish (disposing)...");
    await submitPromise;
    console.log("Previous batch finished (disposed)");

    await statsPromise;
}

run().then(function() {
    console.log("Done");
    process.exit(0);
}).catch(function(err) {
    console.log("Error: " + err.toString());
    process.exit(1);
});
