// scripts/market_narrative.ts
//
// Scripts a realistic price narrative onto a market by actually placing (and cancelling/
// replacing) real limit orders over real wall-clock time from multiple wallets — this is
// what makes alley-indexer's price_history table (and therefore the frontend's price
// chart) show a genuine story instead of a flat line or fabricated data.
//
// Story: Sabalenka takes an early lead, the match narrows to even, several genuine
// swings back and forth (a "deuce"), then Swiatek pulls ahead and wins. Each phase
// moves BOTH outcome books' best bid/ask to a new target level (by cancelling the prior
// phase's resting quotes and placing fresh ones), so the displayed midpoint price for
// each outcome tracks the story. One phase additionally demonstrates a genuine
// cross-orderbook combo-mint match (see limit.rs) — the actual mechanism by which real
// arbitrage keeps Yes/No prices summing near $1, not just resting quotes sitting near
// each other by construction.
//
// Usage:
//   bun scripts/market_narrative.ts <marketPda> [options]
//
// Options:
//   --devnet               (default: on) — this script assumes devnet
//   --phase-delay-ms <n>   real-time gap between phases (default: 10000)
//   --tx-delay-ms <n>      gap between individual transactions (default: 1600)

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const KEYS_DIR = path.join(import.meta.dir, ".keys");

const IX = { PlaceOrder: 3, CancelOrder: 4 };
const OrderType = { Limit: 0, Split: 2 };
const Side = { Buy: 0, Sell: 1 };

// ---- Orderbook binary layout (mirrors alley/tests/helpers.ts) ----
const ORDERBOOK_HEADER_SIZE = 44;
const PRICE_LEVEL_SIZE = 8;
const TRADER_SEAT_SIZE = 56;
const ORDER_NODE_SIZE = 24;
const TIER_SEATS = [128, 1024, 4096];
const TIER_ORDERS = [512, 4096, 16384];

function ordersOffset(tier: number): number {
    return ORDERBOOK_HEADER_SIZE + PRICE_LEVEL_SIZE * 200 + TRADER_SEAT_SIZE * TIER_SEATS[tier]!;
}
function readNode(buf: Buffer, tier: number, idx: number) {
    const off = ordersOffset(tier) + idx * ORDER_NODE_SIZE;
    return {
        userSeatIdx: buf.readUInt32LE(off),
        quantity: buf.readBigUInt64LE(off + 4),
        nextIdx: buf.readUInt32LE(off + 12),
        orderId: buf.readBigUInt64LE(off + 16),
    };
}
function findNodeIdxByOrderId(buf: Buffer, tier: number, side: number, price: number, orderId: bigint): number | null {
    const levelOff = ORDERBOOK_HEADER_SIZE + (side * 100 + price) * PRICE_LEVEL_SIZE;
    let idx = buf.readUInt32LE(levelOff);
    while (idx !== 0) {
        const node = readNode(buf, tier, idx);
        if (node.orderId === orderId) return idx;
        idx = node.nextIdx;
    }
    return null;
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface Wallet {
    name: string;
    kp: Keypair;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    bumpMarketUser: number;
}

function buildPlaceOrderIx(w: Wallet, marketPda: PublicKey, orderbookA: PublicKey, orderbookB: PublicKey, params: {
    outcome: number; side: number; orderType: number; price: number; quantity: bigint; orderId: bigint;
    makerAccounts?: PublicKey[]; // resolved by pubkey-scan on-chain (find_maker_account) — see mod.rs
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 21);
    data.writeUInt8(IX.PlaceOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(params.orderType, 3);
    data.writeUInt8(params.price, 4);
    data.writeBigUInt64LE(params.quantity, 5);
    data.writeBigUInt64LE(params.orderId, 13);
    data.writeUInt8(w.bumpMarketUser, 21);
    const keys = [
        { pubkey: w.kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: w.platformUserState, isSigner: false, isWritable: true },
        { pubkey: w.marketUserState, isSigner: false, isWritable: true },
        { pubkey: orderbookA, isSigner: false, isWritable: true },
        { pubkey: orderbookB, isSigner: false, isWritable: true },
        ...(params.makerAccounts ?? []).map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

function buildCancelOrderIx(w: Wallet, marketPda: PublicKey, orderbook: PublicKey, params: {
    outcome: number; side: number; price: number; orderNodeIdx: number; orderId: bigint;
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 15);
    data.writeUInt8(IX.CancelOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(params.price, 3);
    data.writeUInt32LE(params.orderNodeIdx, 4);
    data.writeBigUInt64LE(params.orderId, 8);
    const keys = [
        { pubkey: w.kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: w.platformUserState, isSigner: false, isWritable: true },
        { pubkey: w.marketUserState, isSigner: false, isWritable: true },
        { pubkey: orderbook, isSigner: false, isWritable: true },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
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
    console.log(`  ${label}: ${sig}`);
    return sig;
}

interface RestingOrder {
    wallet: Wallet;
    outcome: number;
    side: number;
    price: number;
    orderId: bigint;
    orderbook: PublicKey;
    nodeIdx: number;
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const marketPda = new PublicKey(positional[0] ?? "8m7M5x5vKkYDJn9GPDpKa98VYwWbtwtBZw9x3g9WxS1J");
    const rpcUrl = options.devnet !== false ? "https://api.devnet.solana.com" : ((options.url as string) ?? "http://127.0.0.1:8899");
    const phaseDelayMs = options["phase-delay-ms"] ? Number(options["phase-delay-ms"]) : 10000;
    const txDelayMs = options["tx-delay-ms"] ? Number(options["tx-delay-ms"]) : 1600;
    const connection = new Connection(rpcUrl, "confirmed");

    console.log("RPC:", rpcUrl);
    console.log("Market:", marketPda.toBase58());

    const marketAccount = await connection.getAccountInfo(marketPda);
    if (!marketAccount) throw new Error("market not found");
    const orderbookA = new PublicKey(marketAccount.data.subarray(208, 240));
    const orderbookB = new PublicKey(marketAccount.data.subarray(240, 272));
    const tier = marketAccount.data.readUInt8(290);
    console.log("Orderbook A:", orderbookA.toBase58(), "Orderbook B:", orderbookB.toBase58(), "tier:", tier);

    const operatorKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
    const makerKps = [0, 1, 2].map((i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `maker${i}.json`), "utf-8")))));
    const allKps = [operatorKp, ...makerKps];

    const wallets: Wallet[] = allKps.map((kp, i) => {
        const [platformUserState] = PublicKey.findProgramAddressSync([Buffer.from("user_state"), kp.publicKey.toBuffer()], PROGRAM_ID);
        const [marketUserState, bumpMarketUser] = PublicKey.findProgramAddressSync([Buffer.from("market_user"), marketPda.toBuffer(), kp.publicKey.toBuffer()], PROGRAM_ID);
        return { name: i === 0 ? "operator" : `maker${i - 1}`, kp, platformUserState, marketUserState, bumpMarketUser };
    });

    let orderIdCounter = BigInt(Date.now());
    const nextOrderId = () => orderIdCounter++;

    async function placeLimit(w: Wallet, outcome: number, side: number, price: number, qty: bigint): Promise<RestingOrder> {
        const orderId = nextOrderId();
        const tx = new Transaction().add(buildPlaceOrderIx(w, marketPda, orderbookA, orderbookB, {
            outcome, side, orderType: OrderType.Limit, price, quantity: qty, orderId,
        }));
        const label = `[${w.name}] LIMIT ${side === Side.Buy ? "BUY" : "SELL"} ${outcome === 0 ? "Sabalenka" : "Swiatek"} @ ${price}c`;
        await sendAndConfirm(connection, tx, w.kp, label);
        await sleep(txDelayMs);

        const orderbook = outcome === 0 ? orderbookA : orderbookB;
        const obAcc = await connection.getAccountInfo(orderbook);
        const nodeIdx = findNodeIdxByOrderId(obAcc!.data, tier, side, price, orderId);
        if (nodeIdx === null) throw new Error(`could not locate node_idx for order ${orderId} (side ${side} price ${price}) — order may have crossed instead of resting`);
        return { wallet: w, outcome, side, price, orderId, orderbook, nodeIdx };
    }

    async function cancelResting(o: RestingOrder | null) {
        if (!o) return;
        try {
            const tx = new Transaction().add(buildCancelOrderIx(o.wallet, marketPda, o.orderbook, {
                outcome: o.outcome, side: o.side, price: o.price, orderNodeIdx: o.nodeIdx, orderId: o.orderId,
            }));
            await sendAndConfirm(connection, tx, o.wallet.kp, `[${o.wallet.name}] cancel ${o.outcome === 0 ? "Sabalenka" : "Swiatek"} ${o.side === Side.Buy ? "bid" : "ask"} @ ${o.price}c`);
            await sleep(txDelayMs);
        } catch (err) {
            console.warn(`  (cancel skipped, likely already consumed by a match: ${(err as Error).message.split("\n")[0]})`);
        }
    }

    // ---- Setup: give every wallet OT-A + OT-B inventory on THIS market via Split ----
    console.log("\n=== Setup: splitting collateral into OT-A/OT-B inventory for each wallet ===");
    for (const w of wallets) {
        const tx = new Transaction().add(buildPlaceOrderIx(w, marketPda, orderbookA, orderbookB, {
            outcome: 0, side: 0, orderType: OrderType.Split, price: 0, quantity: 500_000n, orderId: nextOrderId(),
        }));
        await sendAndConfirm(connection, tx, w.kp, `[${w.name}] split 0.5 USDC -> OT-A + OT-B`);
        await sleep(txDelayMs);
    }

    // ---- Narrative phases: Sabalenka's price (Swiatek = 100 - Sabalenka) ----
    const phases = [
        { label: "Sabalenka takes an early lead", target: 68 },
        { label: "Lead narrows", target: 58 },
        { label: "The match is dead even", target: 50 },
        { label: "Deuce: Swiatek edges ahead", target: 45 },
        { label: "Deuce: Sabalenka claws back", target: 53 },
        { label: "Deuce: Swiatek ahead again, momentum building", target: 42 },
        { label: "Swiatek pulls decisively ahead", target: 30 },
        { label: "Swiatek wins", target: 16 },
    ];

    const QTY = 150_000n; // 0.15 units per resting order
    let resting: Record<"bidA" | "askA" | "bidB" | "askB", RestingOrder | null> = { bidA: null, askA: null, bidB: null, askB: null };

    for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
        const { label, target } = phases[phaseIdx]!;
        const targetB = 100 - target;
        console.log(`\n=== Phase ${phaseIdx + 1}/${phases.length}: "${label}" (Sabalenka ${target}c / Swiatek ${targetB}c) ===`);

        // Cancel prior phase's resting quotes before requoting at the new levels — best
        // bid/ask can only move down-in-price (bid) or up-in-price (ask) by adding fresh
        // orders; moving the OTHER direction requires removing the stale extreme first.
        await cancelResting(resting.bidA);
        await cancelResting(resting.askA);
        await cancelResting(resting.bidB);
        await cancelResting(resting.askB);

        // ---- The one deliberate demonstration of a real combo-mint cross: at the
        // "dead even" phase, an actual arbitrage-style match happens instead of just two
        // independent resting quotes — mirroring the Polymarket doc's own example
        // (buy Yes @ 0.60 + buy No @ 0.40 => matched, $1 minted into 1 Yes + 1 No). ----
        if (phaseIdx === 2) {
            const arbMaker = wallets[1]!;
            const arbTaker = wallets[2]!;
            const restB = await placeLimit(arbMaker, 1, Side.Buy, 49, 100_000n);
            console.log(`  (${arbMaker.name} rests a Buy-Swiatek @ 49c — about to be crossed)`);
            const crossTx = new Transaction().add(buildPlaceOrderIx(arbTaker, marketPda, orderbookA, orderbookB, {
                outcome: 0, side: Side.Buy, orderType: OrderType.Limit, price: 52, quantity: 100_000n, orderId: nextOrderId(),
                makerAccounts: [arbMaker.marketUserState],
            }));
            await sendAndConfirm(connection, crossTx, arbTaker.kp, `[${arbTaker.name}] LIMIT BUY Sabalenka @ 52c (crosses combo-mint vs the resting Swiatek buy: 52+49=101 >= 100)`);
            await sleep(txDelayMs);
            console.log("  -> genuine on-chain combo-mint match executed (both sides minted real OT-A + OT-B, not just resting quotes)");
        }

        const bidAPrice = clamp(target - 2, 1, 99);
        const askAPrice = clamp(target + 2, 1, 99);
        const bidBPrice = clamp(targetB - 2, 1, 99);
        const askBPrice = clamp(targetB + 2, 1, 99);

        // Rotate which wallet quotes which side each phase, for realistic varied
        // participation rather than one wallet always playing the same role.
        const roleWallets = [0, 1, 2, 3].map((i) => wallets[(i + phaseIdx) % wallets.length]!);

        resting.bidA = await placeLimit(roleWallets[0]!, 0, Side.Buy, bidAPrice, QTY);
        resting.askA = await placeLimit(roleWallets[1]!, 0, Side.Sell, askAPrice, QTY);
        resting.bidB = await placeLimit(roleWallets[2]!, 1, Side.Buy, bidBPrice, QTY);
        resting.askB = await placeLimit(roleWallets[3]!, 1, Side.Sell, askBPrice, QTY);

        console.log(`  Sabalenka book: bid ${bidAPrice}c / ask ${askAPrice}c (midpoint ${Math.round((bidAPrice + askAPrice) / 2)}c)`);
        console.log(`  Swiatek book:   bid ${bidBPrice}c / ask ${askBPrice}c (midpoint ${Math.round((bidBPrice + askBPrice) / 2)}c)`);

        if (phaseIdx < phases.length - 1) {
            console.log(`  (waiting ${phaseDelayMs / 1000}s before next phase...)`);
            await sleep(phaseDelayMs);
        }
    }

    console.log("\n✅ Narrative complete. Final resting quotes left on the book reflect Swiatek's win.");
    console.log(`View: https://explorer.solana.com/address/${marketPda.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
    console.error("market_narrative script crashed:", err);
    process.exit(1);
});
