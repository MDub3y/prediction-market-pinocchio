// scripts/close_out_match.ts
//
// A short, decisive closing sequence appended after market_narrative_live.ts: real
// crossing trades that walk the price to a clear final outcome — the same way a live
// sports win-probability chart snaps sharply to 0/100 at match point, rather than
// drifting there gradually. Reuses the same wallets/PDAs/instruction encoding.
//
// Usage: bun scripts/close_out_match.ts <marketPda> <winnerOutcome: 0|1>

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const KEYS_DIR = path.join(import.meta.dir, ".keys");
const IX = { PlaceOrder: 3 };
const Side = { Buy: 0, Sell: 1 };

const ORDERBOOK_HEADER_SIZE = 44;
const PRICE_LEVEL_SIZE = 8;

function directoryHead(buf: Buffer, side: number, price: number): number {
    return buf.readUInt32LE(ORDERBOOK_HEADER_SIZE + (side * 100 + price) * PRICE_LEVEL_SIZE);
}
function bestBidAsk(buf: Buffer): { bestBid: number | null; bestAsk: number | null } {
    let bestBid: number | null = null, bestAsk: number | null = null;
    for (let price = 1; price <= 99; price++) if (directoryHead(buf, 0, price) !== 0) bestBid = price;
    for (let price = 99; price >= 1; price--) if (directoryHead(buf, 1, price) !== 0) bestAsk = price;
    return { bestBid, bestAsk };
}

interface Wallet { name: string; kp: Keypair; platformUserState: PublicKey; marketUserState: PublicKey; bumpMarketUser: number; }

function buildPlaceOrderIx(w: Wallet, marketPda: PublicKey, orderbookA: PublicKey, orderbookB: PublicKey, params: {
    outcome: number; side: number; price: number; quantity: bigint; orderId: bigint; makerAccounts: PublicKey[];
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 21);
    data.writeUInt8(IX.PlaceOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(0, 3); // Limit
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
        ...params.makerAccounts.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
    console.log(`  ${label}: ${sig.slice(0, 20)}...`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const [marketPdaArg, winnerArg] = process.argv.slice(2);
    const marketPda = new PublicKey(marketPdaArg!);
    const winner = Number(winnerArg); // 0 = Sabalenka, 1 = Swiatek
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");

    const marketAccount = await connection.getAccountInfo(marketPda);
    const orderbookA = new PublicKey(marketAccount!.data.subarray(208, 240));
    const orderbookB = new PublicKey(marketAccount!.data.subarray(240, 272));

    const operatorKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
    const makerKps = [0, 1, 2].map((i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `maker${i}.json`), "utf-8")))));
    const wallets: Wallet[] = [operatorKp, ...makerKps].map((kp, i) => {
        const [platformUserState] = PublicKey.findProgramAddressSync([Buffer.from("user_state"), kp.publicKey.toBuffer()], PROGRAM_ID);
        const [marketUserState, bumpMarketUser] = PublicKey.findProgramAddressSync([Buffer.from("market_user"), marketPda.toBuffer(), kp.publicKey.toBuffer()], PROGRAM_ID);
        return { name: i === 0 ? "operator" : `maker${i - 1}`, kp, platformUserState, marketUserState, bumpMarketUser };
    });
    const allMakerAccounts = wallets.map((w) => w.marketUserState);

    const winnerBook = winner === 0 ? orderbookA : orderbookB;
    const loserBook = winner === 0 ? orderbookB : orderbookA;
    let orderId = BigInt(Date.now());

    console.log(`\n=== Match point: ${winner === 0 ? "Sabalenka" : "Swiatek"} wins ===`);

    // A handful of decisive, larger real crossing trades — buying pressure on the
    // winner's book, selling pressure fading the loser's book — walking both toward a
    // clear final outcome, the way a live win-probability graph snaps at match point.
    for (let i = 0; i < 8; i++) {
        const [winBuf, loseBuf] = await Promise.all([connection.getAccountInfo(winnerBook), connection.getAccountInfo(loserBook)]);
        const { bestBid: winBid, bestAsk: winAsk } = bestBidAsk(winBuf!.data);
        const { bestBid: loseBid, bestAsk: loseAsk } = bestBidAsk(loseBuf!.data);

        const buyer = wallets[i % wallets.length]!;
        const seller = wallets[(i + 1) % wallets.length]!;
        const qty = 60_000n;

        // Reference off whichever side actually has resting depth (bid or ask) — a
        // one-sided book (common after a long organic run has consumed one side
        // entirely) shouldn't stall the walk just because the "expected" side is empty.
        const winRef = Math.max(winBid ?? 0, winAsk ?? 0);
        const buyPrice = Math.min(96, winRef + 4);
        const buyTx = new Transaction().add(buildPlaceOrderIx(buyer, marketPda, orderbookA, orderbookB, {
            outcome: winner, side: Side.Buy, price: buyPrice, quantity: qty, orderId: orderId++, makerAccounts: allMakerAccounts,
        }));
        await sendAndConfirm(connection, buyTx, buyer.kp, `[${buyer.name}] BUY winner up to ${buyPrice}c x0.06`);
        await sleep(1200);

        const loseRef = Math.min(loseBid ?? 100, loseAsk ?? 100);
        const sellPrice = Math.max(4, loseRef - 4);
        const sellTx = new Transaction().add(buildPlaceOrderIx(seller, marketPda, orderbookA, orderbookB, {
            outcome: winner === 0 ? 1 : 0, side: Side.Sell, price: sellPrice, quantity: qty, orderId: orderId++, makerAccounts: allMakerAccounts,
        }));
        await sendAndConfirm(connection, sellTx, seller.kp, `[${seller.name}] SELL loser down to ${sellPrice}c x0.06`);
        await sleep(1200);
    }

    console.log("\n✅ Match closed out.");
}

main().catch((err) => {
    console.error("close_out_match crashed:", err);
    process.exit(1);
});
