// scripts/resolve_market.ts
//
// Minimal keeper CLI for Alley's trusted-keeper oracle model (see
// src/instructions/resolve_market.rs). A market's `oracle_authority` — set once, at
// create_market time — is the only pubkey that can ever resolve that market. This
// script signs and submits that resolve_market instruction on behalf of whichever
// keypair you point it at, after verifying it actually matches the market's recorded
// oracle_authority (so you get a clear error instead of a wasted on-chain rejection).
//
// It does NOT fetch or verify the real-world event result itself — that verification
// is the keeper operator's responsibility, off-chain, before running this script.
//
// Usage:
//   bun scripts/resolve_market.ts <marketPda> <winningOutcome: 0|1> [options]
//
// Options:
//   --keypair <path>   Path to the keeper keypair (default: ~/.config/solana/id.json)
//   --url <url>        RPC URL (default: http://127.0.0.1:8899)
//   --devnet           Shorthand for --url https://api.devnet.solana.com
//   --program-id <id>  Override the deployed program id (default: the one baked in below)
//
// Examples:
//   bun scripts/resolve_market.ts FLEVaf6zrDjrsQUCKQx19zDLNfiknR7uQVTaxpUHUKkH 0
//   bun scripts/resolve_market.ts FLEVaf6zrDjrsQUCKQx19zDLNfiknR7uQVTaxpUHUKkH 1 --devnet --keypair ./keeper.json

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEFAULT_PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");

// MarketState field offsets (repr(C), not packed) — mirrors src/state.rs / tests/helpers.ts.
const MarketStateOffsets = {
    creator: 0,
    oracleAuthority: 32,
    marketId: 64,
    settlementDeadline: 72,
    outcomeAMint: 112,
    outcomeBMint: 144,
    tier: 290,
    isSettled: 291,
    winningOutcome: 292,
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

function usageAndExit(message?: string): never {
    if (message) console.error(`Error: ${message}\n`);
    console.error("Usage: bun scripts/resolve_market.ts <marketPda> <winningOutcome: 0|1> [--keypair <path>] [--url <url> | --devnet] [--program-id <id>]");
    process.exit(1);
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [marketPdaArg, winningOutcomeArg] = positional;

    if (!marketPdaArg || winningOutcomeArg === undefined) {
        usageAndExit("marketPda and winningOutcome are required");
    }

    let marketPda: PublicKey;
    try {
        marketPda = new PublicKey(marketPdaArg);
    } catch {
        usageAndExit(`"${marketPdaArg}" is not a valid pubkey`);
    }

    const winningOutcome = Number(winningOutcomeArg);
    if (winningOutcome !== 0 && winningOutcome !== 1) {
        usageAndExit("winningOutcome must be 0 (outcome A) or 1 (outcome B)");
    }

    const rpcUrl = options.devnet ? "https://api.devnet.solana.com" : ((options.url as string) ?? "http://127.0.0.1:8899");
    const programId = options["program-id"] ? new PublicKey(options["program-id"] as string) : DEFAULT_PROGRAM_ID;
    const keypairPath = (options.keypair as string) ?? path.join(os.homedir(), ".config/solana/id.json");

    if (!fs.existsSync(keypairPath)) {
        usageAndExit(`Keeper keypair not found at ${keypairPath}`);
    }
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
    const keeper = Keypair.fromSecretKey(secretKey);

    const connection = new Connection(rpcUrl, "confirmed");

    console.log("RPC:", rpcUrl);
    console.log("Program:", programId.toBase58());
    console.log("Keeper:", keeper.publicKey.toBase58());
    console.log("Market:", marketPda.toBase58());

    const marketAccount = await connection.getAccountInfo(marketPda);
    if (!marketAccount) {
        usageAndExit(`No account found at ${marketPda.toBase58()} on this cluster`);
    }
    if (!marketAccount.owner.equals(programId)) {
        usageAndExit(`Account ${marketPda.toBase58()} is not owned by ${programId.toBase58()} (owner: ${marketAccount.owner.toBase58()})`);
    }

    const data = marketAccount.data;
    const o = MarketStateOffsets;
    const oracleAuthority = new PublicKey(data.subarray(o.oracleAuthority, o.oracleAuthority + 32));
    const marketId = data.readBigUInt64LE(o.marketId);
    const settlementDeadline = data.readBigInt64LE(o.settlementDeadline);
    const marketStatus = data.readUInt8(o.marketStatus);
    const isSettled = data.readUInt8(o.isSettled);

    console.log("\nMarket state:");
    console.log("  market_id:", marketId.toString());
    console.log("  settlement_deadline:", new Date(Number(settlementDeadline) * 1000).toISOString());
    console.log("  market_status:", marketStatus, marketStatus === 1 ? "(tradeable, resolvable)" : marketStatus === 2 ? "(already settled)" : "(not yet tradeable — has initialize_orderbooks run?)");
    console.log("  is_settled:", isSettled);
    console.log("  oracle_authority:", oracleAuthority.toBase58());

    if (isSettled === 1 || marketStatus === 2) {
        usageAndExit("This market has already been settled — resolve_market would reject a second resolution.");
    }
    if (marketStatus !== 1) {
        usageAndExit("This market's orderbooks haven't been initialized yet (market_status != 1) — resolve_market would reject this.");
    }
    if (!oracleAuthority.equals(keeper.publicKey)) {
        usageAndExit(
            `Keeper keypair ${keeper.publicKey.toBase58()} does not match this market's recorded oracle_authority ` +
                `(${oracleAuthority.toBase58()}). resolve_market would reject this signature — load the correct keeper keypair with --keypair.`
        );
    }

    console.log(`\nResolving with winning_outcome = ${winningOutcome} (${winningOutcome === 0 ? "A" : "B"})...`);

    const ix = new TransactionInstruction({
        programId,
        keys: [
            { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
            { pubkey: marketPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([6, winningOutcome]), // discriminator 6 = resolve_market
    });

    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(signature, "confirmed");
    const status = await connection.getSignatureStatus(signature);

    if (status.value?.err) {
        console.error("\n❌ resolve_market failed:", JSON.stringify(status.value.err));
        const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        console.error(txDetails?.meta?.logMessages?.join("\n"));
        process.exit(1);
    }

    console.log("\n✅ Market resolved.");
    console.log("Signature:", signature);
}

main().catch((err) => {
    console.error("resolve_market script crashed:", err);
    process.exit(1);
});
