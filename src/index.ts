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
    aliceKeyPair: KeyringPair): () => any[][][] {

    return function(): any[][][] {
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

                    let transfer = api.tx.balances.transfer(aliceKeyPair.address, tokensToSend);
                    let signedTransaction = transfer.sign(senderKeyPair, { nonce });

                    batch.push(signedTransaction);

                    sanityCounter++;
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
    measureFinalisation: boolean
) {
    let nextTime = new Date().getTime();
    finalisationTime[0] = 0;
    finalisedTxs[0] = 0;

    for (let batchNo = 0; batchNo < totalBatches; batchNo++) {

        while (new Date().getTime() < nextTime) {
            await new Promise(r => setTimeout(r, 5));
        }

        nextTime = nextTime + 1000;

        let errors = [];

        console.log(`Starting batch #${batchNo}`);
        let batchPromises = new Array<Promise<number>>();
        for (let threadNo = 0; threadNo < totalThreads; threadNo++) {
            batchPromises.push(
                new Promise<number>(async resolve => {
                    let result = 0;
                    for (let transactionNo = 0; transactionNo < transactionPerBatch; transactionNo++) {
                        let transaction = threadPayloads[threadNo][batchNo][transactionNo];
                        await transaction.send(({ status }) => {
                            if (measureFinalisation && status.isFinalized) {
                                let finalisationTimeCurrent = new Date().getTime() - initialTime.getTime();
                                while (true) {
                                    let stored = Atomics.load(finalisationTime, 0);
                                    if (finalisationTimeCurrent <= stored) {
                                        break;
                                    }
                                    if (stored == Atomics.compareExchange(finalisationTime, 0, stored, finalisationTimeCurrent)) {
                                        break;
                                    }
                                }
                                Atomics.add(finalisedTxs, 0, 1);
                            }
                        }).catch((err: any) => {
                            errors.push(err);
                            result = -1;
                            return -1;
                        });
                        console.log(`transaction sent ${transactionNo}-thread #${threadNo}`);
                    }
                    if (result == -1) {
                        resolve(-1);
                    } else {
                        resolve(0);
                    }
                })
            );
        }
        await Promise.all(batchPromises);

        if (errors.length > 0) {
            console.log(`${errors.length}/${transactionPerBatch} errors sending transactions`);
        }
    }
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

    console.log(`TPS from ${total_blocks} blocks: ${tps}`);

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
    for (let i = 0; i < TOTAL_USERS; i++) {
        let stringSeed = seedFromNum(i);
        let keys = keyring.addFromUri(stringSeed);
        let nonce = (await api.query.system.account(keys.address)).nonce.toNumber();
        nonces.push(nonce)
    }
    console.log("All nonces fetched!");

    console.log("Endowing all users from ROOT account...");
    let aliceKeyPair = keyring.addFromUri(ROOT_ACCOUNT_URI);
    let aliceNonce = (await api.query.system.account(aliceKeyPair.address)).nonce.toNumber();
    let keyPairs = new Map<number, KeyringPair>()
    console.log("Alice nonce is " + aliceNonce);

    let finalized_transactions = 0;

    const aliceFunds = (await api.query.system.account(aliceKeyPair.address)).data.free;
    console.log(`ROOT's funds: ${aliceFunds.toBigInt()}`);
    const allAvailableAliceFunds = aliceFunds.toBigInt() - api.consts.balances.existentialDeposit.toBigInt();
    const partialFeeUpperBound = (await api.tx.balances.transfer(aliceKeyPair.address, allAvailableAliceFunds).paymentInfo(aliceKeyPair)).partialFee.toBigInt();
    const initialBalance = (allAvailableAliceFunds / BigInt(TOTAL_USERS)) - partialFeeUpperBound;

    for (let seed = 0; seed < TOTAL_USERS; seed++) {
        let keypair = keyring.addFromUri(seedFromNum(seed));
        keyPairs.set(seed, keypair);

        let transfer = api.tx.balances.transfer(keypair.address, initialBalance);

        let receiverSeed = seedFromNum(seed);
        console.log(
            `Alice -> ${receiverSeed} (${keypair.address}) ${initialBalance}`
        );
        await transfer.signAndSend(aliceKeyPair, { nonce: aliceNonce }, ({ status }) => {
            if (status.isFinalized) {
                finalized_transactions++;
            }
        });
        aliceNonce++;
    }
    console.log("All users endowed from the ROOT account!");

    console.log("Wait for transactions finalisation");
    await new Promise(r => setTimeout(r, FINALISATION_TIMEOUT));
    console.log(`Finalized transactions ${finalized_transactions}`);

    if (finalized_transactions != TOTAL_USERS) {
        throw Error(`Not all transactions finalized`);
    }

    let payloadBuilder = createPayloadBuilder(api, TOKENS_TO_SEND, nonces, TOTAL_THREADS, TOTAL_BATCHES, USERS_PER_THREAD, keyPairs, aliceKeyPair);
    let submitPromise: Promise<void> = new Promise(resolve => resolve());

    while (true) {

        console.log(`Pregenerating ${TOTAL_TRANSACTIONS} transactions across ${TOTAL_THREADS} threads...`);
        let threadPayloads = payloadBuilder();

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
}

run().then(function() {
    console.log("Done");
    process.exit(0);
}).catch(function(err) {
    console.log("Error: " + err.toString());
    process.exit(1);
});
