// scripts/market_narrative_live.ts
//
// A continuously-running, organic price simulation: instead of jumping between fixed
// target quotes (see market_narrative.ts), this submits a steady stream of small
// marketable (crossing) orders over real wall-clock time, weighted by a time-varying
// "who's favored" probability. Each tick is a genuine taker trade that consumes
// whatever's resting at the front of the book — the price moves because buying
// pressure actually eats the order book, the same way a real market moves, not because
// a script re-quotes a target price. Any quantity that can't be matched (thin book)
// rests at the aggressive price, which organically extends the ladder in the trend
// direction — no separate "replenish" step needed.
//
// Usage:
//   bun scripts/market_narrative_live.ts <marketPda> [--duration-sec 300] [--tick-ms 5000]

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const KEYS_DIR = path.join(import.meta.dir, ".keys");

const IX = { PlaceOrder: 3, CancelOrder: 4 };
const OrderType = { Limit: 0 };
const Side = { Buy: 0, Sell: 1 };

const ORDERBOOK_HEADER_SIZE = 44;
const PRICE_LEVEL_SIZE = 8;
const TRADER_SEAT_SIZE = 56;
const ORDER_NODE_SIZE = 24;
const TIER_SEATS = [128, 1024, 4096];

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
function directoryHead(buf: Buffer, side: number, price: number): number {
    return buf.readUInt32LE(ORDERBOOK_HEADER_SIZE + (side * 100 + price) * PRICE_LEVEL_SIZE);
}
function bestBidAsk(buf: Buffer): { bestBid: number | null; bestAsk: number | null } {
    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    for (let price = 1; price <= 99; price++) {
        if (directoryHead(buf, 0, price) !== 0) bestBid = price; // scanning ascending, so last hit = highest
    }
    for (let price = 99; price >= 1; price--) {
        if (directoryHead(buf, 1, price) !== 0) bestAsk = price; // scanning descending, so last hit = lowest
    }
    return { bestBid, bestAsk };
}
function findNodeIdxByOrderId(buf: Buffer, tier: number, side: number, price: number, orderId: bigint): number | null {
    let idx = directoryHead(buf, side, price);
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
        if (arg?.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) { options[key] = next; i++; } else options[key] = true;
        } else if (arg) positional.push(arg);
    }
    return { positional, options };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

interface Wallet {
    name: string;
    kp: Keypair;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    bumpMarketUser: number;
}

function buildPlaceOrderIx(w: Wallet, marketPda: PublicKey, orderbookA: PublicKey, orderbookB: PublicKey, params: {
    outcome: number; side: number; price: number; quantity: bigint; orderId: bigint; makerAccounts?: PublicKey[];
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 21);
    data.writeUInt8(IX.PlaceOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(OrderType.Limit, 3);
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

async function sendAndConfirm(connection: Connection, tx: Transaction, signer: Keypair, label: string, quiet = false) {
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
    if (!quiet) console.log(`  ${label}: ${sig.slice(0, 20)}...`);
    return sig;
}

// Time-varying probability that a tick favors Sabalenka (outcome A). Traces: strong
// early lead -> narrows -> dead even (with a real combo-mint cross) -> several deuce
// swings -> Swiatek pulls ahead -> Swiatek wins.
function sabalenkaWeight(elapsedSec: number, durationSec: number): number {
    const t = elapsedSec / durationSec; // 0..1
    if (t < 0.15) return 0.85;
    if (t < 0.30) return 0.65;
    if (t < 0.40) return 0.50;
    if (t < 0.50) return 0.35;
    if (t < 0.60) return 0.60;
    if (t < 0.70) return 0.30;
    if (t < 0.85) return 0.15;
    return 0.05;
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const marketPda = new PublicKey(positional[0] ?? "8m7M5x5vKkYDJn9GPDpKa98VYwWbtwtBZw9x3g9WxS1J");
    const durationSec = options["duration-sec"] ? Number(options["duration-sec"]) : 300;
    const tickMs = options["tick-ms"] ? Number(options["tick-ms"]) : 5000;
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");

    console.log("Market:", marketPda.toBase58(), " duration:", durationSec, "s  tick:", tickMs, "ms");

    const marketAccount = await connection.getAccountInfo(marketPda);
    if (!marketAccount) throw new Error("market not found");
    const orderbookA = new PublicKey(marketAccount.data.subarray(208, 240));
    const orderbookB = new PublicKey(marketAccount.data.subarray(240, 272));
    const tier = marketAccount.data.readUInt8(290);

    const operatorKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
    const makerKps = [0, 1, 2].map((i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `maker${i}.json`), "utf-8")))));
    const wallets: Wallet[] = [operatorKp, ...makerKps].map((kp, i) => {
        const [platformUserState] = PublicKey.findProgramAddressSync([Buffer.from("user_state"), kp.publicKey.toBuffer()], PROGRAM_ID);
        const [marketUserState, bumpMarketUser] = PublicKey.findProgramAddressSync([Buffer.from("market_user"), marketPda.toBuffer(), kp.publicKey.toBuffer()], PROGRAM_ID);
        return { name: i === 0 ? "operator" : `maker${i - 1}`, kp, platformUserState, marketUserState, bumpMarketUser };
    });
    const walletByPubkey = new Map(wallets.map((w) => [w.marketUserState.toBase58(), w]));

    let orderIdCounter = BigInt(Date.now());
    const nextOrderId = () => orderIdCounter++;

    // Any order that crosses resting liquidity needs that resting order's owner's
    // market_user_state passed as a "maker account" (find_maker_account in mod.rs) or
    // the program rejects it with NotEnoughAccountKeys — including for a SAME-BOOK cross
    // that happens incidentally (e.g. a "just resting" order landing past the current
    // best price because the book moved since it was priced), for the cross-book
    // combo-mint path, and for a self-cross (a wallet happens to cross its own resting
    // order — plausible since taker/seller/maker are all picked randomly from a small
    // pool). With only 4 wallets total in this simulation, the simplest fully correct
    // fix is to always include every wallet's market_user_state (including the taker's
    // own, referenced a second time — Solana handles duplicate account references
    // within one instruction natively) — unused entries are just skipped by the scan.
    const allMakerAccounts = (): PublicKey[] => wallets.map((x) => x.marketUserState);

    // ---- Clean up stale resting orders left on this market from any prior run, so the
    // book starts fresh (a stale extreme bid/ask would otherwise corrupt best-bid/ask). ----
    console.log("\n=== Clearing stale resting orders ===");
    const staleOrders: { outcome: number; side: number; price: number; orderId: bigint; nodeIdx: number; ownerMarketUserState: string; orderbook: PublicKey }[] = [];
    for (const [outcome, orderbook] of [[0, orderbookA], [1, orderbookB]] as [number, PublicKey][]) {
        const buf = (await connection.getAccountInfo(orderbook))!.data;
        for (let side = 0; side <= 1; side++) {
            for (let price = 1; price <= 99; price++) {
                let idx = directoryHead(buf, side, price);
                while (idx !== 0) {
                    const node = readNode(buf, tier, idx);
                    const seatOff = ORDERBOOK_HEADER_SIZE + PRICE_LEVEL_SIZE * 200 + node.userSeatIdx * TRADER_SEAT_SIZE;
                    const ownerMarketUserState = new PublicKey(buf.subarray(seatOff, seatOff + 32)).toBase58();
                    staleOrders.push({ outcome, side, price, orderId: node.orderId, nodeIdx: idx, ownerMarketUserState, orderbook });
                    idx = node.nextIdx;
                }
            }
        }
    }
    for (const o of staleOrders) {
        const owner = walletByPubkey.get(o.ownerMarketUserState);
        if (!owner) continue;
        try {
            const tx = new Transaction().add(buildCancelOrderIx(owner, marketPda, o.orderbook, {
                outcome: o.outcome, side: o.side, price: o.price, orderNodeIdx: o.nodeIdx, orderId: o.orderId,
            }));
            await sendAndConfirm(connection, tx, owner.kp, `[${owner.name}] cleared stale ${o.outcome === 0 ? "Sabalenka" : "Swiatek"} ${o.side === 0 ? "bid" : "ask"} @ ${o.price}c`);
            await sleep(1200);
        } catch (err) {
            console.warn("  (stale cancel skipped)", err instanceof Error ? err.message.split("\n")[0] : String(err));
        }
    }

    // ---- Seed a starting ladder reflecting Sabalenka's early lead (~68c/32c) ----
    console.log("\n=== Seeding initial ladder ===");
    const seedOrders: { outcome: number; side: number; price: number }[] = [
        { outcome: 0, side: Side.Buy, price: 66 }, { outcome: 0, side: Side.Buy, price: 64 }, { outcome: 0, side: Side.Buy, price: 62 },
        { outcome: 0, side: Side.Sell, price: 70 }, { outcome: 0, side: Side.Sell, price: 72 }, { outcome: 0, side: Side.Sell, price: 74 },
        { outcome: 1, side: Side.Buy, price: 30 }, { outcome: 1, side: Side.Buy, price: 28 }, { outcome: 1, side: Side.Buy, price: 26 },
        { outcome: 1, side: Side.Sell, price: 34 }, { outcome: 1, side: Side.Sell, price: 36 }, { outcome: 1, side: Side.Sell, price: 38 },
    ];
    for (let i = 0; i < seedOrders.length; i++) {
        const o = seedOrders[i]!;
        const w = wallets[i % wallets.length]!;
        const tx = new Transaction().add(buildPlaceOrderIx(w, marketPda, orderbookA, orderbookB, {
            outcome: o.outcome, side: o.side, price: o.price, quantity: 25_000n, orderId: nextOrderId(), makerAccounts: allMakerAccounts(),
        }));
        await sendAndConfirm(connection, tx, w.kp, `[${w.name}] seed ${o.outcome === 0 ? "Sabalenka" : "Swiatek"} ${o.side === 0 ? "bid" : "ask"} @ ${o.price}c`);
        await sleep(1200);
    }

    // ---- Continuous organic ticking: real crossing trades, weighted by who's favored ----
    console.log(`\n=== Live for ${durationSec}s: organic buying/selling pressure driving the price ===`);
    const startTime = Date.now();
    let comboDemoFired = false;
    let tickNum = 0;

    while (Date.now() - startTime < durationSec * 1000) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const weight = sabalenkaWeight(elapsedSec, durationSec);
        const sabalenkaBullish = Math.random() < weight;
        tickNum++;

        // One genuine combo-mint demonstration during the "dead even" window (Polymarket
        // doc's own example: complementary buys summing >= 100 mint real token pairs).
        if (!comboDemoFired && elapsedSec / durationSec >= 0.32 && elapsedSec / durationSec < 0.40) {
            comboDemoFired = true;
            const maker = wallets[(tickNum) % wallets.length]!;
            const taker = wallets[(tickNum + 1) % wallets.length]!;
            const restTx = new Transaction().add(buildPlaceOrderIx(maker, marketPda, orderbookA, orderbookB, {
                outcome: 1, side: Side.Buy, price: 49, quantity: 40_000n, orderId: nextOrderId(), makerAccounts: allMakerAccounts(),
            }));
            await sendAndConfirm(connection, restTx, maker.kp, `[${maker.name}] rests Buy-Swiatek @49c (arb setup)`);
            await sleep(1200);
            const crossTx = new Transaction().add(buildPlaceOrderIx(taker, marketPda, orderbookA, orderbookB, {
                outcome: 0, side: Side.Buy, price: 52, quantity: 40_000n, orderId: nextOrderId(),
                makerAccounts: allMakerAccounts(),
            }));
            await sendAndConfirm(connection, crossTx, taker.kp, `[${taker.name}] Buy-Sabalenka @52c -> genuine combo-mint cross (52+49>=100)`);
            await sleep(1200);
            console.log("  *** real on-chain arbitrage match executed — this is how prices actually stay near $1 together ***");
            continue;
        }

        try {
            const takerOutcome = sabalenkaBullish ? 0 : 1; // buying pressure on the favored side
            const fadeOutcome = sabalenkaBullish ? 1 : 0; // selling pressure on the other side
            const buyBook = takerOutcome === 0 ? orderbookA : orderbookB;
            const sellBook = fadeOutcome === 0 ? orderbookA : orderbookB;

            const [buyBuf, sellBuf] = await Promise.all([connection.getAccountInfo(buyBook), connection.getAccountInfo(sellBook)]);
            const { bestAsk } = bestBidAsk(buyBuf!.data);
            const { bestBid } = bestBidAsk(sellBuf!.data);

            const buyer = wallets[randInt(0, wallets.length - 1)]!;
            const seller = wallets[randInt(0, wallets.length - 1)]!;
            const qty = BigInt(randInt(12_000, 25_000));

            const buyPrice = clamp((bestAsk ?? 50) + randInt(1, 3), 1, 98);
            const buyTx = new Transaction().add(buildPlaceOrderIx(buyer, marketPda, orderbookA, orderbookB, {
                outcome: takerOutcome, side: Side.Buy, price: buyPrice, quantity: qty, orderId: nextOrderId(), makerAccounts: allMakerAccounts(),
            }));
            await sendAndConfirm(connection, buyTx, buyer.kp, `[${buyer.name}] BUY ${takerOutcome === 0 ? "Sabalenka" : "Swiatek"} up to ${buyPrice}c x${Number(qty) / 1_000_000}`, true);
            await sleep(700);

            const sellPrice = clamp((bestBid ?? 50) - randInt(1, 3), 2, 99);
            const sellTx = new Transaction().add(buildPlaceOrderIx(seller, marketPda, orderbookA, orderbookB, {
                outcome: fadeOutcome, side: Side.Sell, price: sellPrice, quantity: qty, orderId: nextOrderId(), makerAccounts: allMakerAccounts(),
            }));
            await sendAndConfirm(connection, sellTx, seller.kp, `[${seller.name}] SELL ${fadeOutcome === 0 ? "Sabalenka" : "Swiatek"} down to ${sellPrice}c x${Number(qty) / 1_000_000}`, true);

            const tag = sabalenkaBullish ? "Sabalenka buying pressure" : "Swiatek buying pressure";
            console.log(`[${elapsedSec.toFixed(0)}s] tick ${tickNum} (weight=${weight.toFixed(2)}, ${tag}): A best~${takerOutcome === 0 ? buyPrice : sellPrice}c / B best~${takerOutcome === 1 ? buyPrice : sellPrice}c`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`  tick ${tickNum} skipped:`, msg.split("\n")[0]);
        }

        await sleep(Math.max(500, tickMs - 1400));
    }

    console.log("\n✅ Live session complete.");
    console.log(`View: https://explorer.solana.com/address/${marketPda.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
    console.error("market_narrative_live script crashed:", err);
    process.exit(1);
});
