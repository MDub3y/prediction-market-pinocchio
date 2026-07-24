// scripts/market_maker.ts
//
// Dummy market maker: seeds a liquid, non-crossing spread of resting limit orders on
// both outcome orderbooks of a given market, using the operator's own wallet. This is
// for demo/testing only — it deposits collateral, splits some of it into equal OT-A +
// OT-B inventory (order_type=2, see src/instructions/place_order/split.rs), then rests
// BUY orders (locks collateral) and SELL orders (locks OT-A/OT-B inventory) at prices
// chosen so nothing here crosses itself:
//   - all outcome-A buys stay below all outcome-A sells (and same for B)
//   - A-buy-price + B-buy-price always stays under 100 (avoids the combo-mint
//     cross-orderbook match — see limit.rs's "Cross-Orderbook Matching" section)
//
// Usage:
//   bun scripts/market_maker.ts <marketPda> [options]
//
// Options:
//   --keypair <path>   Path to maker keypair (default: ~/.config/solana/id.json)
//   --url <url>        RPC URL (default: http://127.0.0.1:8899)
//   --devnet           Shorthand for --url https://api.devnet.solana.com
//   --deposit <usdc>   How much USDC (UI units) to deposit from the wallet's ATA before
//                       trading (default: 20). Skipped if the wallet has no USDC ATA.
//   --split <usdc>     How much of the platform collateral balance to convert into
//                       equal OT-A + OT-B inventory via a Split order (default: 15).

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEFAULT_PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const IX = { CreateMarket: 0, InitializeOrderbooks: 1, DepositCollateral: 2, PlaceOrder: 3 };
const OrderType = { Limit: 0, Split: 2 };
const Side = { Buy: 0, Sell: 1 };

const MarketStateOffsets = {
    outcomeAMint: 144,
    orderbookA: 208,
    orderbookB: 240,
    tier: 290,
    marketStatus: 293,
};

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const options: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--devnet") {
            options.devnet = true;
        } else if (arg?.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                options[key] = next;
                i++;
            } else {
                options[key] = true;
            }
        } else if (arg) {
            positional.push(arg);
        }
    }
    return { positional, options };
}

function collateralAuthorityPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("collateral_authority")], programId)[0];
}

function buildPlaceOrderIx(params: {
    programId: PublicKey;
    user: PublicKey;
    marketPda: PublicKey;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    orderbookA: PublicKey;
    orderbookB: PublicKey;
    outcome: number;
    side: number;
    orderType: number;
    price: number;
    quantity: bigint;
    orderId: bigint;
    bumpMarketUser: number;
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

async function sendAndConfirm(connection: Connection, tx: Transaction, signer: Keypair, label: string) {
    tx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    tx.feePayer = signer.publicKey;
    tx.sign(signer);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
    const status = await connection.getSignatureStatus(sig);
    if (status.value?.err) {
        const txDetails = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        throw new Error(`${label} failed: ${JSON.stringify(status.value.err)}\n${txDetails?.meta?.logMessages?.join("\n")}`);
    }
    console.log(`${label}: ${sig}`);
    return sig;
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [marketPdaArg] = positional;
    if (!marketPdaArg) {
        console.error("Usage: bun scripts/market_maker.ts <marketPda> [--devnet] [--keypair <path>] [--deposit <usdc>] [--split <usdc>]");
        process.exit(1);
    }

    const marketPda = new PublicKey(marketPdaArg);
    const rpcUrl = options.devnet ? "https://api.devnet.solana.com" : ((options.url as string) ?? "http://127.0.0.1:8899");
    const programId = options["program-id"] ? new PublicKey(options["program-id"] as string) : DEFAULT_PROGRAM_ID;
    const keypairPath = (options.keypair as string) ?? path.join(os.homedir(), ".config/solana/id.json");
    const depositUsdc = options.deposit ? Number(options.deposit) : 20;
    const splitUsdc = options.split ? Number(options.split) : 15;
    const startIndex = options["start-index"] ? Number(options["start-index"]) : 0;
    const delayMs = options["delay-ms"] ? Number(options["delay-ms"]) : 1500;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
    const maker = Keypair.fromSecretKey(secretKey);
    const connection = new Connection(rpcUrl, "confirmed");

    console.log("RPC:", rpcUrl);
    console.log("Maker:", maker.publicKey.toBase58());
    console.log("Market:", marketPda.toBase58());

    const marketAccount = await connection.getAccountInfo(marketPda);
    if (!marketAccount) throw new Error(`No market account at ${marketPda.toBase58()}`);
    const o = MarketStateOffsets;
    const outcomeAMint = new PublicKey(marketAccount.data.subarray(o.outcomeAMint, o.outcomeAMint + 32));
    const orderbookA = new PublicKey(marketAccount.data.subarray(o.orderbookA, o.orderbookA + 32));
    const orderbookB = new PublicKey(marketAccount.data.subarray(o.orderbookB, o.orderbookB + 32));
    const marketStatus = marketAccount.data.readUInt8(o.marketStatus);
    if (marketStatus !== 1) throw new Error(`Market status is ${marketStatus}, expected 1 (tradeable)`);

    console.log("Orderbook A:", orderbookA.toBase58());
    console.log("Orderbook B:", orderbookB.toBase58());

    // We only need outcomeAMint to find the collateral mint indirectly — actually the
    // collateral mint isn't derivable from outcome mints, so read it straight from the
    // market account (offset 176, see tests/helpers.ts MarketStateOffsets).
    const collateralMint = new PublicKey(marketAccount.data.subarray(176, 176 + 32));
    console.log("Collateral mint:", collateralMint.toBase58());

    const [platformUserState, bumpPlatform] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_state"), maker.publicKey.toBuffer()],
        programId
    );
    const [marketUserState, bumpMarketUser] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_user"), marketPda.toBuffer(), maker.publicKey.toBuffer()],
        programId
    );

    // ---- Step 1: deposit collateral (if the wallet holds any of this mint) ----
    const userTokenAccount = getAssociatedTokenAddressSync(collateralMint, maker.publicKey, false, TOKEN_PROGRAM_ID);
    const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
    if (userTokenAccountInfo && depositUsdc > 0) {
        const authority = collateralAuthorityPda(programId);
        const collateralVault = PublicKey.findProgramAddressSync(
            [authority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), collateralMint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        )[0];

        const depositAmount = BigInt(Math.round(depositUsdc * 1_000_000));
        const data = Buffer.alloc(1 + 9);
        data.writeUInt8(IX.DepositCollateral, 0);
        data.writeBigUInt64LE(depositAmount, 1);
        data.writeUInt8(bumpPlatform, 9);

        // NOTE: platform_user_state is created on-demand by deposit_collateral.rs's own
        // CreateAccount CPI (funded directly from `maker`) — do not pre-fund the PDA with
        // a separate transfer first; real create_account requires 0 lamports at the
        // target or it fails "already in use" (litesvm tolerates this, a real cluster
        // doesn't).
        const tx = new Transaction();
        tx.add(new TransactionInstruction({
            keys: [
                { pubkey: maker.publicKey, isSigner: true, isWritable: true },
                { pubkey: platformUserState, isSigner: false, isWritable: true },
                { pubkey: userTokenAccount, isSigner: false, isWritable: true },
                { pubkey: collateralVault, isSigner: false, isWritable: true },
                { pubkey: collateralMint, isSigner: false, isWritable: false },
                { pubkey: authority, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            programId,
            data,
        }));
        await sendAndConfirm(connection, tx, maker, `deposit_collateral (${depositUsdc} USDC)`);
    } else {
        console.log("Skipping deposit (no USDC ATA found or --deposit 0).");
    }

    let orderIdCounter = BigInt(Date.now());
    const nextOrderId = () => orderIdCounter++;

    // ---- Step 2: split collateral into equal OT-A + OT-B inventory for resting sells ----
    if (splitUsdc > 0) {
        const splitQty = BigInt(Math.round(splitUsdc * 1_000_000));
        const tx = new Transaction().add(buildPlaceOrderIx({
            programId,
            user: maker.publicKey,
            marketPda,
            platformUserState,
            marketUserState,
            orderbookA,
            orderbookB,
            outcome: 0,
            side: 0,
            orderType: OrderType.Split,
            price: 0,
            quantity: splitQty,
            orderId: nextOrderId(),
            bumpMarketUser,
        }));
        await sendAndConfirm(connection, tx, maker, `split (${splitUsdc} USDC -> OT-A + OT-B)`);
    }

    // ---- Step 3: rest a non-crossing spread of limit orders on both books ----
    // Chosen so: A-buys < A-sells, B-buys < B-sells, and (A-buy price + B-buy price) < 100
    // everywhere, so nothing here matches anything else here (see file header comment).
    type Order = { outcome: number; side: number; price: number; qty: bigint };
    const orders: Order[] = [
        { outcome: 0, side: Side.Buy, price: 30, qty: 1_000_000n },
        { outcome: 0, side: Side.Buy, price: 35, qty: 1_500_000n },
        { outcome: 0, side: Side.Buy, price: 40, qty: 2_000_000n },
        { outcome: 0, side: Side.Sell, price: 55, qty: 1_000_000n },
        { outcome: 0, side: Side.Sell, price: 60, qty: 1_500_000n },
        { outcome: 0, side: Side.Sell, price: 65, qty: 2_000_000n },
        { outcome: 1, side: Side.Buy, price: 25, qty: 1_000_000n },
        { outcome: 1, side: Side.Buy, price: 30, qty: 1_500_000n },
        { outcome: 1, side: Side.Buy, price: 35, qty: 2_000_000n },
        { outcome: 1, side: Side.Sell, price: 60, qty: 1_000_000n },
        { outcome: 1, side: Side.Sell, price: 65, qty: 1_500_000n },
        { outcome: 1, side: Side.Sell, price: 70, qty: 2_000_000n },
    ];

    for (let i = startIndex; i < orders.length; i++) {
        const order = orders[i]!;
        await sleep(delayMs);
        const tx = new Transaction().add(buildPlaceOrderIx({
            programId,
            user: maker.publicKey,
            marketPda,
            platformUserState,
            marketUserState,
            orderbookA,
            orderbookB,
            outcome: order.outcome,
            side: order.side,
            orderType: OrderType.Limit,
            price: order.price,
            quantity: order.qty,
            orderId: nextOrderId(),
            bumpMarketUser,
        }));
        const label = `LIMIT ${order.side === Side.Buy ? "BUY" : "SELL"} outcome ${order.outcome === 0 ? "A" : "B"} @ ${order.price}c x ${Number(order.qty) / 1_000_000}`;
        await sendAndConfirm(connection, tx, maker, label);
    }

    console.log("\n✅ Market maker seeding complete.");
    console.log(`View on Explorer: https://explorer.solana.com/address/${marketPda.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
    console.error("market_maker script crashed:", err);
    process.exit(1);
});
