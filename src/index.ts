import {Keyring} from "@polkadot/keyring";
import {ApiPromise, WsProvider} from "@polkadot/api";
import {KeyringPair} from "@polkadot/keyring/types";
import { SignedBlock, BlockHash, BlockAttestations } from "@polkadot/types/interfaces";


function seedFromNum(seed: number): string {
    return '//user/' + seed.toString()
}

async function getBlockStats(api: ApiPromise, hash?: BlockHash | undefined): Promise<any> {
    const signedBlock = hash ? await api.rpc.chain.getBlock(hash) : await api.rpc.chain.getBlock();

    // the hash for each extrinsic in the block
    let timestamp = signedBlock.block.extrinsics.find(
        ({ method: { methodName, sectionName } }) => sectionName === 'timestamp' && methodName === 'set'
    )!.method.args[0].toString();

    let date = new Date(+timestamp);

    return {
        date,
        transactions: signedBlock.block.extrinsics.length,
        parent: signedBlock.block.header.parentHash,
    }
}

async function run() {

    let TOTAL_TRANSACTIONS = 15000;
    let TPS = 1500;
    let TOTAL_THREADS = 10;
    let TRANSACTIONS_PER_THREAD = TOTAL_TRANSACTIONS/TOTAL_THREADS;
    let TOTAL_BATCHES = TOTAL_TRANSACTIONS/TPS;
    let TRANSACTION_PER_BATCH = TPS / TOTAL_THREADS;
    let WS_URL = "ws://localhost:9944";
    let TOTAL_USERS = TOTAL_TRANSACTIONS;
    let USERS_PER_THREAD = TOTAL_USERS / TOTAL_THREADS;
    let TOKENS_TO_SEND = 1;

    let provider = new WsProvider(WS_URL);

    let api = await ApiPromise.create({provider});

    let keyring = new Keyring({type: 'sr25519'});

    let nonces = [];

    let keyPairs = new Map<number, KeyringPair>()

    console.log("Fetching nonces for accounts...");
    for (let i = 0; i <= TOTAL_USERS; i++) {
        if ((i+1) % 1000 == 0) {
            console.log(`${i+1} done..`);
        }
        let stringSeed = seedFromNum(i);
        let newKey = keyring.addFromUri(stringSeed);
        let nonce = (await api.query.system.account(newKey.address)).nonce.toNumber();
        keyPairs.set(i, newKey);
        nonces.push(nonce)
    }
    console.log("All nonces fetched!");

    let aliceKeyPair = keyring.addFromUri("//Alice");

    console.log(`Pregenerating ${TOTAL_TRANSACTIONS} transactions across ${TOTAL_THREADS} threads...`);
    var thread_payloads: any[][][] = [];
    var sanityCounter = 0;
    var nextUser = 0;
    for (let thread = 0; thread < TOTAL_THREADS; thread++) {
        let batches = [];
        for (var batchNo = 0; batchNo < TOTAL_BATCHES; batchNo ++) {
            let batch = [];
            for (var txNo = 0; txNo < TRANSACTION_PER_BATCH; txNo++) {
                let nonce = nonces[nextUser];
                nonces[nextUser] ++;
                let senderKeyPair = keyPairs.get(nextUser)!;

                let transfer = api.tx.balances.transfer(aliceKeyPair.address, TOKENS_TO_SEND);
                let signedTransaction = transfer.sign(senderKeyPair, {nonce});

                batch.push(signedTransaction);

                sanityCounter++;
                nextUser++;
            }
            batches.push(batch);
        }
        thread_payloads.push(batches);
    }
    console.log(`Done pregenerating transactions (${sanityCounter}).`);

    let nextTime = new Date().getTime();
    let initialTime = new Date();

    for (var batchNo = 0; batchNo < TOTAL_BATCHES; batchNo++) {

        while (new Date().getTime() < nextTime) {
            await new Promise(r => setTimeout(r, 5));
        }

        nextTime = nextTime + 1000;

        var errors = [];

        console.log(`Staring batch #${batchNo}`);
        let batchPromises = new Array<Promise<number>>();
        for (let threadNo = 0; threadNo < TOTAL_THREADS; threadNo++) {
            for (let transactionNo = 0; transactionNo < TRANSACTION_PER_BATCH; transactionNo++) {
                batchPromises.push(
                    new Promise<number>(async resolve => {
                        let transaction = thread_payloads[threadNo][batchNo][transactionNo];
                        resolve(await transaction.send().catch((err: any) => {
                            errors.push(err);
                            return -1;
                        }));
                    })
                );
            }
        }
        await Promise.all(batchPromises);

        if (errors.length > 0) {
            console.log(`${errors.length}/${TRANSACTION_PER_BATCH} errors sending transactions`);
        }
    }

    let finalTime = new Date();
    let diff = finalTime.getTime() - initialTime.getTime();

    var total_transactions = 0;
    var total_blocks = 0;
    var latest_block = await getBlockStats(api);
    console.log(`latest block: ${latest_block.date}`);
    console.log(`initial time: ${initialTime}`);
    for (; latest_block.date > initialTime; latest_block = await getBlockStats(api, latest_block.parent)) {
        if (latest_block.date < finalTime) {
            console.log(`block at ${latest_block.date}: ${latest_block.transactions} transactions`);
            total_transactions  += latest_block.transactions;
            total_blocks ++;
        }
    }

    let tps = (total_transactions * 1000) / diff;

    console.log(`TPS from ${total_blocks} blocks: ${tps}`)
}

run().then(function() {
    console.log("Done");
    process.exit(0);
}).catch(function(err) {
    console.log("Error: ", err);
    process.exit(1);
});