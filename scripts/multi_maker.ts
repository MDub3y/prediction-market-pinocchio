// scripts/multi_maker.ts
//
// Generates N fresh dummy maker wallets (keypairs saved under scripts/.keys/, gitignored),
// funds each with devnet SOL (airdrop) and a small slice of USDC (transferred from the
// operator wallet's own ATA — devnet USDC has no public faucet), deposits collateral,
// splits some into OT-A/OT-B inventory, then rests a handful of limit orders per maker
// on both outcome books. This exists so a market's orderbook/DB rows show multiple
// distinct market_user_state/wallets, not just one self-trading maker.
//
// Usage:
//   bun scripts/multi_maker.ts <marketPda> [options]
//
// Options:
//   --keypair <path>     Operator keypair to fund makers from (default: ~/.config/solana/id.json)
//   --url <url>          RPC URL (default: http://127.0.0.1:8899)
//   --devnet             Shorthand for --url https://api.devnet.solana.com
//   --count <n>          How many maker wallets to generate (default: 3)
//   --usdc-each <n>      USDC (UI units) to transfer to each maker (default: 3)
//   --sol-each <n>       SOL to airdrop to each maker (default: 0.05, devnet only)
//   --delay-ms <n>       Delay between transactions (default: 1500)

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from "@solana/web3.js";
import {
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEFAULT_PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const KEYS_DIR = path.join(import.meta.dir, ".keys");

const IX = { DepositCollateral: 2, PlaceOrder: 3 };
const OrderType = { Limit: 0, Split: 2 };
const Side = { Buy: 0, Sell: 1 };

const MarketStateOffsets = { collateralMint: 176, orderbookA: 208, orderbookB: 240, marketStatus: 293 };

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const options: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--devnet") options.devnet = true;
        else if (arg?.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) { options[key] = next; i++; } else options[key] = true;
        } else if (arg) positional.push(arg);
    }
    return { positional, options };
}

function collateralAuthorityPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("collateral_authority")], programId)[0];
}

function buildPlaceOrderIx(params: {
    programId: PublicKey; user: PublicKey; marketPda: PublicKey; platformUserState: PublicKey;
    marketUserState: PublicKey; orderbookA: PublicKey; orderbookB: PublicKey; outcome: number;
    side: number; orderType: number; price: number; quantity: bigint; orderId: bigint; bumpMarketUser: number;
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 21);
    data.writeUInt8(IX.PlaceOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(params.orderType, 3);
    data.writeUInt8(params.price, 4);
    data.writeBigUInt64LE(params.quantity, 5);
    data.writeBigUInt64LE(params.orderId, 13);
    data.writeUInt8(params.bumpMarketUser, 21);
    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: true },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.marketUserState, isSigner: false, isWritable: true },
        { pubkey: params.orderbookA, isSigner: false, isWritable: true },
        { pubkey: params.orderbookB, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId: params.programId, data });
}

async function sendAndConfirm(connection: Connection, tx: Transaction, signers: Keypair[], label: string) {
    tx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
    const status = await connection.getSignatureStatus(sig);
    if (status.value?.err) {
        const txDetails = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        throw new Error(`${label} failed: ${JSON.stringify(status.value.err)}\n${txDetails?.meta?.logMessages?.join("\n")}`);
    }
    console.log(`  ${label}: ${sig}`);
    return sig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [marketPdaArg] = positional;
    if (!marketPdaArg) {
        console.error("Usage: bun scripts/multi_maker.ts <marketPda> [--devnet] [--count 3] [--usdc-each 3] [--sol-each 0.05]");
        process.exit(1);
    }

    const marketPda = new PublicKey(marketPdaArg);
    const rpcUrl = options.devnet ? "https://api.devnet.solana.com" : ((options.url as string) ?? "http://127.0.0.1:8899");
    const programId = options["program-id"] ? new PublicKey(options["program-id"] as string) : DEFAULT_PROGRAM_ID;
    const operatorKeypairPath = (options.keypair as string) ?? path.join(os.homedir(), ".config/solana/id.json");
    const count = options.count ? Number(options.count) : 3;
    const startMaker = options["start-maker"] ? Number(options["start-maker"]) : 0;
    const usdcEach = options["usdc-each"] ? Number(options["usdc-each"]) : 3;
    const solEach = options["sol-each"] ? Number(options["sol-each"]) : 0.05;
    const delayMs = options["delay-ms"] ? Number(options["delay-ms"]) : 1500;

    const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(operatorKeypairPath, "utf-8"))));
    const connection = new Connection(rpcUrl, "confirmed");

    console.log("RPC:", rpcUrl);
    console.log("Operator (funder):", operator.publicKey.toBase58());
    console.log("Market:", marketPda.toBase58());

    const marketAccount = await connection.getAccountInfo(marketPda);
    if (!marketAccount) throw new Error(`No market account at ${marketPda.toBase58()}`);
    const o = MarketStateOffsets;
    const collateralMint = new PublicKey(marketAccount.data.subarray(o.collateralMint, o.collateralMint + 32));
    const orderbookA = new PublicKey(marketAccount.data.subarray(o.orderbookA, o.orderbookA + 32));
    const orderbookB = new PublicKey(marketAccount.data.subarray(o.orderbookB, o.orderbookB + 32));
    if (marketAccount.data.readUInt8(o.marketStatus) !== 1) throw new Error("Market not tradeable (market_status != 1)");

    fs.mkdirSync(KEYS_DIR, { recursive: true });

    const operatorAta = getAssociatedTokenAddressSync(collateralMint, operator.publicKey, false, TOKEN_PROGRAM_ID);
    const authority = collateralAuthorityPda(programId);
    const collateralVault = PublicKey.findProgramAddressSync(
        [authority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), collateralMint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];

    // Per-maker price offsets so each wallet's resting orders sit at distinct price
    // points (visibly separate depth, not stacked on the exact same level) while
    // staying inside the same non-crossing "A-buys < A-sells, B-buys < B-sells,
    // A-buy+B-buy < 100" envelope the earlier single-maker seeding used.
    const offsets = [0, 3, 6, 9, 12, 15];

    for (let m = startMaker; m < count; m++) {
        const keyPath = path.join(KEYS_DIR, `maker${m}.json`);
        let maker: Keypair;
        if (fs.existsSync(keyPath)) {
            maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))));
            console.log(`\n=== Maker ${m} (reused): ${maker.publicKey.toBase58()} ===`);
        } else {
            maker = Keypair.generate();
            fs.writeFileSync(keyPath, JSON.stringify(Array.from(maker.secretKey)));
            console.log(`\n=== Maker ${m} (new): ${maker.publicKey.toBase58()} ===`);
        }

        // Fund with SOL directly from the operator wallet (101+ SOL on hand) rather than
        // the devnet airdrop faucet — the public faucet has a tight daily per-IP limit
        // that's easy to exhaust, while a same-cluster transfer always works.
        const balance = await connection.getBalance(maker.publicKey);
        if (balance < solEach * 1e9 * 0.5) {
            const transferSolTx = new Transaction().add(
                SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: maker.publicKey, lamports: Math.round(solEach * 1e9) })
            );
            await sendAndConfirm(connection, transferSolTx, [operator], `funded ${solEach} SOL`);
        }
        await sleep(delayMs);

        // Fund with USDC from the operator's own ATA (create maker's ATA if needed) —
        // but only top up if this maker doesn't already hold enough (idempotent re-runs
        // shouldn't keep draining the operator wallet on every retry).
        const makerAta = getAssociatedTokenAddressSync(collateralMint, maker.publicKey, false, TOKEN_PROGRAM_ID);
        const makerAtaInfo = await connection.getAccountInfo(makerAta);
        const existingMakerUsdc = makerAtaInfo ? (await connection.getTokenAccountBalance(makerAta)).value.uiAmount ?? 0 : 0;
        if (existingMakerUsdc < usdcEach) {
            const transferTx = new Transaction();
            if (!makerAtaInfo) {
                transferTx.add(createAssociatedTokenAccountInstruction(operator.publicKey, makerAta, maker.publicKey, collateralMint, TOKEN_PROGRAM_ID));
            }
            transferTx.add(createTransferInstruction(operatorAta, makerAta, operator.publicKey, BigInt(Math.round((usdcEach - existingMakerUsdc) * 1_000_000)), [], TOKEN_PROGRAM_ID));
            await sendAndConfirm(connection, transferTx, [operator], `funded ${(usdcEach - existingMakerUsdc).toFixed(2)} USDC`);
            await sleep(delayMs);
        } else {
            console.log(`  already has ${existingMakerUsdc} USDC, skipping top-up`);
        }

        // Deposit into platform collateral.
        const [platformUserState, bumpPlatform] = PublicKey.findProgramAddressSync([Buffer.from("user_state"), maker.publicKey.toBuffer()], programId);
        const [marketUserState, bumpMarketUser] = PublicKey.findProgramAddressSync([Buffer.from("market_user"), marketPda.toBuffer(), maker.publicKey.toBuffer()], programId);
        // NOTE: platform_user_state is created on-demand by deposit_collateral.rs's own
        // CreateAccount CPI (funded directly from `maker`) if it doesn't exist yet — do
        // NOT pre-fund the PDA with a separate SystemProgram.transfer first. Solana's
        // create_account requires the target to start at exactly 0 lamports; a real
        // cluster rejects it with "already in use" if lamports were sent there first
        // (litesvm's simplified runtime tolerates this, which is why this bug never
        // surfaced in the test suite).
        const depositAmount = BigInt(Math.round(usdcEach * 1_000_000));
        const depositData = Buffer.alloc(1 + 9);
        depositData.writeUInt8(IX.DepositCollateral, 0);
        depositData.writeBigUInt64LE(depositAmount, 1);
        depositData.writeUInt8(bumpPlatform, 9);
        const depositTx = new Transaction();
        depositTx.add(new TransactionInstruction({
            keys: [
                { pubkey: maker.publicKey, isSigner: true, isWritable: true },
                { pubkey: platformUserState, isSigner: false, isWritable: true },
                { pubkey: makerAta, isSigner: false, isWritable: true },
                { pubkey: collateralVault, isSigner: false, isWritable: true },
                { pubkey: collateralMint, isSigner: false, isWritable: false },
                { pubkey: authority, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            programId,
            data: depositData,
        }));
        await sendAndConfirm(connection, depositTx, [maker], `deposit_collateral (${usdcEach} USDC)`);
        await sleep(delayMs);

        let orderIdCounter = BigInt(Date.now()) + BigInt(m) * 1_000_000n;
        const nextOrderId = () => orderIdCounter++;

        // Split roughly 60% of the deposit into equal OT-A + OT-B inventory for sells.
        const splitQty = (depositAmount * 60n) / 100n;
        const splitTx = new Transaction().add(buildPlaceOrderIx({
            programId, user: maker.publicKey, marketPda, platformUserState, marketUserState,
            orderbookA, orderbookB, outcome: 0, side: 0, orderType: OrderType.Split,
            price: 0, quantity: splitQty, orderId: nextOrderId(), bumpMarketUser,
        }));
        await sendAndConfirm(connection, splitTx, [maker], `split (${Number(splitQty) / 1_000_000} USDC -> OT-A + OT-B)`);
        await sleep(delayMs);

        const offset = offsets[m % offsets.length]!;
        const qty = 500_000n; // 0.5 units per order, keeps per-maker collateral usage small
        const orders = [
            { outcome: 0, side: Side.Buy, price: 20 + offset },
            { outcome: 0, side: Side.Sell, price: 70 - offset },
            { outcome: 1, side: Side.Buy, price: 18 + offset },
            { outcome: 1, side: Side.Sell, price: 72 - offset },
        ];

        for (const order of orders) {
            const tx = new Transaction().add(buildPlaceOrderIx({
                programId, user: maker.publicKey, marketPda, platformUserState, marketUserState,
                orderbookA, orderbookB, outcome: order.outcome, side: order.side, orderType: OrderType.Limit,
                price: order.price, quantity: qty, orderId: nextOrderId(), bumpMarketUser,
            }));
            const label = `LIMIT ${order.side === Side.Buy ? "BUY" : "SELL"} outcome ${order.outcome === 0 ? "A" : "B"} @ ${order.price}c x 0.5`;
            await sendAndConfirm(connection, tx, [maker], label);
            await sleep(delayMs);
        }
    }

    console.log("\n✅ Multi-maker seeding complete.");
}

main().catch((err) => {
    console.error("multi_maker script crashed:", err);
    process.exit(1);
});
