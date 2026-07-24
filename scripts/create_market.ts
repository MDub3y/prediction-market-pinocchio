// scripts/create_market.ts
//
// Creates a new Alley market (create_market + initialize_orderbooks) directly against
// a live cluster, without going through the frontend. Uses the same wire format as
// app/create/page.tsx in alley-web, minus the custom Token-2022 metadata path (this
// always creates markets with plain default-metadata outcome mints — has_custom_meta=0).
//
// Usage:
//   bun scripts/create_market.ts <title> <outcomeA> <outcomeB> [options]
//
// Options:
//   --keypair <path>       Path to creator/oracle keypair (default: ~/.config/solana/id.json)
//   --url <url>            RPC URL (default: http://127.0.0.1:8899)
//   --devnet               Shorthand for --url https://api.devnet.solana.com
//   --collateral-mint <id> Collateral mint (default: official devnet USDC)
//   --tier <0|1|2>         Orderbook size tier (default: 0, small — cheapest rent)
//   --deadline-secs <n>    Seconds from now until settlement deadline (default: 604800 = 7d)
//
// Example:
//   bun scripts/create_market.ts "Who wins? M. Kasnikowski vs H. Barton" "Kasnikowski" "Barton" --devnet

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEFAULT_PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const DEFAULT_DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const ORDERBOOK_HEADER_SIZE = 44;
const DIRECTORY_SIZE = 8 * 200;
const TRADER_SEAT_SIZE = 56;
const ORDER_NODE_SIZE = 24;
const TIER_SEATS = [128, 1024, 4096];
const TIER_ORDERS = [512, 4096, 16384];

function orderbookSpace(tier: number): number {
    return ORDERBOOK_HEADER_SIZE + DIRECTORY_SIZE + TRADER_SEAT_SIZE * TIER_SEATS[tier]! + ORDER_NODE_SIZE * TIER_ORDERS[tier]!;
}

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

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [title, outcomeA, outcomeB] = positional;
    if (!title || !outcomeA || !outcomeB) {
        console.error("Usage: bun scripts/create_market.ts <title> <outcomeA> <outcomeB> [--devnet] [--keypair <path>] [--tier 0|1|2] [--deadline-secs <n>]");
        process.exit(1);
    }

    const rpcUrl = options.devnet ? "https://api.devnet.solana.com" : ((options.url as string) ?? "http://127.0.0.1:8899");
    const programId = options["program-id"] ? new PublicKey(options["program-id"] as string) : DEFAULT_PROGRAM_ID;
    const collateralMint = options["collateral-mint"] ? new PublicKey(options["collateral-mint"] as string) : DEFAULT_DEVNET_USDC;
    const tier = options.tier ? Number(options.tier) : 0;
    const deadlineSecs = options["deadline-secs"] ? Number(options["deadline-secs"]) : 604800;
    const keypairPath = (options.keypair as string) ?? path.join(os.homedir(), ".config/solana/id.json");

    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
    const creator = Keypair.fromSecretKey(secretKey);
    const connection = new Connection(rpcUrl, "confirmed");

    console.log("RPC:", rpcUrl);
    console.log("Creator/oracle:", creator.publicKey.toBase58());
    console.log("Collateral mint:", collateralMint.toBase58());
    console.log("Tier:", tier);

    const marketId = BigInt(Math.floor(Math.random() * 10_000_000));
    const unixDeadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);

    const marketIdBuffer = Buffer.alloc(8);
    marketIdBuffer.writeBigUInt64LE(marketId);

    const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from("market"), marketIdBuffer], programId);
    const [outcomeAMint, bumpA] = PublicKey.findProgramAddressSync([Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([0])], programId);
    const [outcomeBMint, bumpB] = PublicKey.findProgramAddressSync([Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([1])], programId);

    console.log("Market ID:", marketId.toString());
    console.log("Market PDA:", marketPda.toBase58());
    console.log("Outcome A mint:", outcomeAMint.toBase58());
    console.log("Outcome B mint:", outcomeBMint.toBase58());

    const [mStateRent, mintRent, obRent] = await Promise.all([
        connection.getMinimumBalanceForRentExemption(296),
        connection.getMinimumBalanceForRentExemption(82),
        connection.getMinimumBalanceForRentExemption(orderbookSpace(tier)),
    ]);

    const payload1 = Buffer.alloc(49);
    payload1.writeUInt8(0, 0); // discriminator: CreateMarket
    payload1.writeBigUInt64LE(marketId, 1);
    payload1.writeBigInt64LE(unixDeadline, 9);
    payload1.writeBigUInt64LE(BigInt(mStateRent), 17);
    payload1.writeBigUInt64LE(BigInt(mintRent), 25);
    payload1.writeUInt8(bumpA, 33);
    payload1.writeUInt8(bumpB, 34);
    payload1.writeUInt8(tier, 35);
    payload1.writeUInt8(0, 36); // has_custom_meta = false

    const tx1 = new Transaction();
    tx1.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    tx1.feePayer = creator.publicKey;
    tx1.add(new TransactionInstruction({
        keys: [
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: outcomeAMint, isSigner: false, isWritable: true },
            { pubkey: outcomeBMint, isSigner: false, isWritable: true },
            { pubkey: collateralMint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: creator.publicKey, isSigner: false, isWritable: false }, // oracle_authority_acc
        ],
        programId,
        data: payload1,
    }));
    tx1.sign(creator);
    const sig1 = await connection.sendRawTransaction(tx1.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig1, "confirmed");
    console.log("\ncreate_market:", sig1);

    const orderbookA = Keypair.generate();
    const orderbookB = Keypair.generate();
    const space = orderbookSpace(tier);
    const tx2 = new Transaction();
    tx2.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    tx2.feePayer = creator.publicKey;
    tx2.add(
        SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: orderbookA.publicKey, lamports: obRent, space, programId }),
        SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: orderbookB.publicKey, lamports: obRent, space, programId }),
    );
    tx2.sign(creator, orderbookA, orderbookB);
    const sig2 = await connection.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig2, "confirmed");
    console.log("orderbook account creation:", sig2);

    const tx3 = new Transaction();
    tx3.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    tx3.feePayer = creator.publicKey;
    tx3.add(new TransactionInstruction({
        keys: [
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: orderbookA.publicKey, isSigner: false, isWritable: true },
            { pubkey: orderbookB.publicKey, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId,
        data: Buffer.from([1]), // discriminator: InitializeOrderbooks
    }));
    tx3.sign(creator);
    const sig3 = await connection.sendRawTransaction(tx3.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig3, "confirmed");
    console.log("initialize_orderbooks:", sig3);

    console.log("\nSaving off-chain metadata to the Prisma DB via alley-web's API (must be running on localhost:3000)...");
    try {
        const res = await fetch("http://localhost:3000/api/market", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                marketPda: marketPda.toBase58(),
                marketId: marketId.toString(),
                creatorWallet: creator.publicKey.toBase58(),
                title,
                description: `${title} — created via scripts/create_market.ts for orderbook liquidity demo.`,
                category: "Sports",
                outcomeA,
                outcomeB,
                outcomeAMint: outcomeAMint.toBase58(),
                outcomeBMint: outcomeBMint.toBase58(),
                orderbookA: orderbookA.publicKey.toBase58(),
                orderbookB: orderbookB.publicKey.toBase58(),
                hasCustomMeta: false,
            }),
        });
        const body = await res.json();
        console.log(body.success ? "✅ Metadata saved." : `⚠️  Metadata save failed: ${body.error}`);
    } catch (err) {
        console.warn("⚠️  Could not reach alley-web at localhost:3000 to save metadata (is `bun dev` running?). You can retry this POST manually later.", err);
    }

    console.log("\n✅ Market created.");
    console.log("Market PDA:      ", marketPda.toBase58());
    console.log("Outcome A mint:  ", outcomeAMint.toBase58());
    console.log("Outcome B mint:  ", outcomeBMint.toBase58());
    console.log("Orderbook A:     ", orderbookA.publicKey.toBase58());
    console.log("Orderbook B:     ", orderbookB.publicKey.toBase58());
    console.log("Oracle authority:", creator.publicKey.toBase58());
}

main().catch((err) => {
    console.error("create_market script crashed:", err);
    process.exit(1);
});
