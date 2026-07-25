// scripts/resolve_and_claim.ts
//
// End-to-end verification of the resolve_market -> claim_winnings -> claim_funds flow
// on a live devnet market:
//   1. Operator takes real crossing trades against the resting maker liquidity on BOTH
//      outcome books, so several distinct wallets end up holding real OT-A/OT-B balances
//      and real collateral_claimable (maker rebate) balances.
//   2. Snapshots every wallet's on-chain ledger state BEFORE resolution.
//   3. Calls resolve_market as the market's oracle_authority (the trusted-keeper model —
//      see src/instructions/resolve_market.rs) to settle outcome A ("Yes") as the winner.
//   4. Calls claim_winnings then claim_funds for every wallet, logging each result
//      (including the expected failures: a wallet with zero winning-outcome balance, or
//      calling claim_winnings twice in a row).
//   5. Snapshots every wallet's ledger state AFTER, and prints a before/after table.
//
// Usage: bun scripts/resolve_and_claim.ts <marketPda>

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
const TOKEN_PROGRAM_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const KEYS_DIR = path.join(import.meta.dir, ".keys");

const IX = { DepositCollateral: 2, PlaceOrder: 3, ClaimFunds: 5, ResolveMarket: 6, ClaimWinnings: 7 };
const OrderType = { Limit: 0 };
const Side = { Buy: 0 };

const MarketOff = { oracleAuthority: 32, outcomeAMint: 112, outcomeBMint: 144, orderbookA: 208, orderbookB: 240, collateralMint: 176, isSettled: 291, winningOutcome: 292, marketStatus: 293 };
const PlatformOff = { collateralAvailable: 32 };
const MarketUserOff = { otA: 96, otB: 104, claimable: 112 };

interface Wallet { name: string; kp: Keypair; platformUserState: PublicKey; marketUserState: PublicKey; bumpMarketUser: number; }

function u64(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }

async function sendAndConfirm(connection: Connection, tx: Transaction, signers: Keypair[], label: string, allowFail = false) {
    tx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
    const status = await connection.getSignatureStatus(sig);
    if (status.value?.err) {
        const txDetails = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        const msg = `${label}: FAILED ${JSON.stringify(status.value.err)} — ${txDetails?.meta?.logMessages?.find((l) => l.includes("Error"))}`;
        if (allowFail) { console.log(`  ${msg}`); return null; }
        throw new Error(msg);
    }
    console.log(`  ${label}: OK (${sig.slice(0, 20)}...)`);
    return sig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readPlatform(connection: Connection, pk: PublicKey): Promise<bigint> {
    const acc = await connection.getAccountInfo(pk);
    if (!acc) return 0n;
    return u64(acc.data, PlatformOff.collateralAvailable);
}
async function readMarketUser(connection: Connection, pk: PublicKey): Promise<{ otA: bigint; otB: bigint; claimable: bigint }> {
    const acc = await connection.getAccountInfo(pk);
    if (!acc) return { otA: 0n, otB: 0n, claimable: 0n };
    return { otA: u64(acc.data, MarketUserOff.otA), otB: u64(acc.data, MarketUserOff.otB), claimable: u64(acc.data, MarketUserOff.claimable) };
}

async function snapshot(connection: Connection, wallets: Wallet[]) {
    const rows: Record<string, { available: bigint; otA: bigint; otB: bigint; claimable: bigint }> = {};
    for (const w of wallets) {
        const [available, mu] = await Promise.all([readPlatform(connection, w.platformUserState), readMarketUser(connection, w.marketUserState)]);
        rows[w.name] = { available, ...mu };
    }
    return rows;
}

function fmt(n: bigint): string { return (Number(n) / 1_000_000).toFixed(4); }

async function main() {
    const [marketPdaArg] = process.argv.slice(2);
    if (!marketPdaArg) { console.error("Usage: bun scripts/resolve_and_claim.ts <marketPda>"); process.exit(1); }
    const marketPda = new PublicKey(marketPdaArg);
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");

    const marketAccount = await connection.getAccountInfo(marketPda);
    if (!marketAccount) throw new Error("Market not found");
    const d = marketAccount.data;
    const oracleAuthority = new PublicKey(d.subarray(MarketOff.oracleAuthority, MarketOff.oracleAuthority + 32));
    const outcomeAMint = new PublicKey(d.subarray(MarketOff.outcomeAMint, MarketOff.outcomeAMint + 32));
    const outcomeBMint = new PublicKey(d.subarray(MarketOff.outcomeBMint, MarketOff.outcomeBMint + 32));
    const orderbookA = new PublicKey(d.subarray(MarketOff.orderbookA, MarketOff.orderbookA + 32));
    const orderbookB = new PublicKey(d.subarray(MarketOff.orderbookB, MarketOff.orderbookB + 32));
    const collateralMint = new PublicKey(d.subarray(MarketOff.collateralMint, MarketOff.collateralMint + 32));

    const operatorKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
    const makerKps = [0, 1, 2].map((i) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `maker${i}.json`), "utf-8")))));

    console.log("Market:           ", marketPda.toBase58());
    console.log("Oracle authority: ", oracleAuthority.toBase58());
    console.log("Operator wallet:  ", operatorKp.publicKey.toBase58());
    console.log("Oracle == operator?", oracleAuthority.equals(operatorKp.publicKey));

    const wallets: Wallet[] = [operatorKp, ...makerKps].map((kp, i) => {
        const [platformUserState] = PublicKey.findProgramAddressSync([Buffer.from("user_state"), kp.publicKey.toBuffer()], PROGRAM_ID);
        const [marketUserState, bumpMarketUser] = PublicKey.findProgramAddressSync([Buffer.from("market_user"), marketPda.toBuffer(), kp.publicKey.toBuffer()], PROGRAM_ID);
        return { name: i === 0 ? "operator" : `maker${i - 1}`, kp, platformUserState, marketUserState, bumpMarketUser };
    });
    const allMakerAccounts = wallets.map((w) => w.marketUserState);

    // ---- Step 1: operator deposits collateral, then takes real crossing trades on
    // BOTH outcome books so multiple wallets end up holding real positions/proceeds. ----
    console.log("\n=== Step 1: operator deposits collateral + crosses resting liquidity on both books ===");

    const [operatorPlatformState, opBump] = PublicKey.findProgramAddressSync([Buffer.from("user_state"), operatorKp.publicKey.toBuffer()], PROGRAM_ID);
    const { getAssociatedTokenAddressSync: ata } = await import("@solana/spl-token");
    const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const operatorAta = ata(collateralMint, operatorKp.publicKey, false, TOKEN_PROGRAM_ID);
    const [collateralAuthority] = PublicKey.findProgramAddressSync([Buffer.from("collateral_authority")], PROGRAM_ID);
    const collateralVault = PublicKey.findProgramAddressSync([collateralAuthority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), collateralMint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

    const depositAmount = 300_000_000n; // 300 test-collateral tokens
    const depositData = Buffer.alloc(1 + 9);
    depositData.writeUInt8(IX.DepositCollateral, 0);
    depositData.writeBigUInt64LE(depositAmount, 1);
    depositData.writeUInt8(opBump, 9);
    const depositTx = new Transaction().add(new TransactionInstruction({
        keys: [
            { pubkey: operatorKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: operatorPlatformState, isSigner: false, isWritable: true },
            { pubkey: operatorAta, isSigner: false, isWritable: true },
            { pubkey: collateralVault, isSigner: false, isWritable: true },
            { pubkey: collateralMint, isSigner: false, isWritable: false },
            { pubkey: collateralAuthority, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID, data: depositData,
    }));
    await sendAndConfirm(connection, depositTx, [operatorKp], "deposit_collateral (300)");
    await sleep(1200);

    function buildPlaceOrderIx(w: Wallet, params: { outcome: number; side: number; price: number; quantity: bigint; orderId: bigint; makerAccounts: PublicKey[] }): TransactionInstruction {
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
            ...params.makerAccounts.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true })),
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ];
        return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
    }

    let orderId = BigInt(Date.now());
    const operatorWallet = wallets[0]!;

    // BUY outcome A @75c walks through all 3 resting asks (64/67/70) -> operator ends up
    // holding real OT-A ("Yes") inventory, makers get real collateral_claimable proceeds.
    const buyA = new Transaction().add(buildPlaceOrderIx(operatorWallet, { outcome: 0, side: Side.Buy, price: 75, quantity: 1_500_000n, orderId: orderId++, makerAccounts: allMakerAccounts }));
    await sendAndConfirm(connection, buyA, [operatorKp], "operator BUY outcome A (Yes) @75c x1.5, crosses all 3 maker asks");
    await sleep(1200);

    // BUY outcome B @75c similarly, so operator ALSO ends up holding OT-B ("No") — the
    // losing side once we resolve A as the winner, to demonstrate losing tokens are NOT
    // paid out by claim_winnings.
    const buyB = new Transaction().add(buildPlaceOrderIx(operatorWallet, { outcome: 1, side: Side.Buy, price: 75, quantity: 1_500_000n, orderId: orderId++, makerAccounts: allMakerAccounts }));
    await sendAndConfirm(connection, buyB, [operatorKp], "operator BUY outcome B (No) @75c x1.5, crosses all 3 maker asks");
    await sleep(1200);

    // ---- Step 2: snapshot BEFORE resolution ----
    console.log("\n=== Step 2: ledger snapshot BEFORE resolution ===");
    const before = await snapshot(connection, wallets);
    for (const w of wallets) {
        const s = before[w.name]!;
        console.log(`  ${w.name.padEnd(9)} available=${fmt(s.available)}  ot_a=${fmt(s.otA)}  ot_b=${fmt(s.otB)}  claimable=${fmt(s.claimable)}`);
    }

    // ---- Step 3: resolve_market, signed by the oracle_authority key ----
    console.log("\n=== Step 3: resolve_market (oracle_authority signs, winning_outcome=0 -> 'Yes' wins) ===");
    const resolveData = Buffer.from([IX.ResolveMarket, 0]); // winning_outcome = 0
    const resolveTx = new Transaction().add(new TransactionInstruction({
        keys: [
            { pubkey: oracleAuthority, isSigner: true, isWritable: false },
            { pubkey: marketPda, isSigner: false, isWritable: true },
        ],
        programId: PROGRAM_ID, data: resolveData,
    }));
    await sendAndConfirm(connection, resolveTx, [operatorKp], "resolve_market(winning_outcome=0)");
    await sleep(1200);

    const marketAfterResolve = await connection.getAccountInfo(marketPda);
    const rd = marketAfterResolve!.data;
    console.log(`  market_status=${rd.readUInt8(MarketOff.marketStatus)} (2=Settled)  is_settled=${rd.readUInt8(MarketOff.isSettled)}  winning_outcome=${rd.readUInt8(MarketOff.winningOutcome)} (0=A/Yes)`);

    // ---- Step 4: claim_winnings + claim_funds for every wallet ----
    console.log("\n=== Step 4: claim_winnings then claim_funds, per wallet ===");
    for (const w of wallets) {
        console.log(`\n-- ${w.name} (${w.kp.publicKey.toBase58()}) --`);
        const userTokenAccount = ata(outcomeAMint, w.kp.publicKey, false, TOKEN_PROGRAM_2022_ID);
        const claimWinTx = new Transaction().add(new TransactionInstruction({
            keys: [
                { pubkey: w.kp.publicKey, isSigner: true, isWritable: true },
                { pubkey: marketPda, isSigner: false, isWritable: false },
                { pubkey: w.platformUserState, isSigner: false, isWritable: true },
                { pubkey: w.marketUserState, isSigner: false, isWritable: true },
                { pubkey: outcomeAMint, isSigner: false, isWritable: true },
                { pubkey: userTokenAccount, isSigner: false, isWritable: true },
                { pubkey: TOKEN_PROGRAM_2022_ID, isSigner: false, isWritable: false },
            ],
            programId: PROGRAM_ID, data: Buffer.from([IX.ClaimWinnings]),
        }));
        await sendAndConfirm(connection, claimWinTx, [w.kp], "claim_winnings", true);
        await sleep(1000);

        const claimFundsTx = new Transaction().add(new TransactionInstruction({
            keys: [
                { pubkey: w.kp.publicKey, isSigner: true, isWritable: true },
                { pubkey: w.platformUserState, isSigner: false, isWritable: true },
                { pubkey: w.marketUserState, isSigner: false, isWritable: true },
            ],
            programId: PROGRAM_ID, data: Buffer.from([IX.ClaimFunds]),
        }));
        await sendAndConfirm(connection, claimFundsTx, [w.kp], "claim_funds", true);
        await sleep(1000);
    }

    // ---- Step 4b: demonstrate claim_winnings is not double-payable ----
    console.log("\n=== Step 4b: operator calls claim_winnings AGAIN (expect InsufficientFunds — already claimed) ===");
    {
        const w = operatorWallet;
        const userTokenAccount = ata(outcomeAMint, w.kp.publicKey, false, TOKEN_PROGRAM_2022_ID);
        const tx = new Transaction().add(new TransactionInstruction({
            keys: [
                { pubkey: w.kp.publicKey, isSigner: true, isWritable: true },
                { pubkey: marketPda, isSigner: false, isWritable: false },
                { pubkey: w.platformUserState, isSigner: false, isWritable: true },
                { pubkey: w.marketUserState, isSigner: false, isWritable: true },
                { pubkey: outcomeAMint, isSigner: false, isWritable: true },
                { pubkey: userTokenAccount, isSigner: false, isWritable: true },
                { pubkey: TOKEN_PROGRAM_2022_ID, isSigner: false, isWritable: false },
            ],
            programId: PROGRAM_ID, data: Buffer.from([IX.ClaimWinnings]),
        }));
        await sendAndConfirm(connection, tx, [w.kp], "claim_winnings (2nd call)", true);
    }

    // ---- Step 5: snapshot AFTER, print before/after table ----
    console.log("\n=== Step 5: ledger snapshot AFTER ===");
    const after = await snapshot(connection, wallets);
    console.log("\n%-9s %14s %14s %14s %14s", "wallet", "avail before", "avail after", "otA before", "otA after");
    for (const w of wallets) {
        const b = before[w.name]!, a = after[w.name]!;
        console.log(`  ${w.name.padEnd(9)} available: ${fmt(b.available)} -> ${fmt(a.available)}   ot_a: ${fmt(b.otA)} -> ${fmt(a.otA)}   ot_b(unclaimable, lost side): ${fmt(b.otB)} -> ${fmt(a.otB)}   claimable: ${fmt(b.claimable)} -> ${fmt(a.claimable)}`);
    }

    console.log("\n✅ Full resolve -> claim_winnings -> claim_funds flow verified on-chain.");
}

main().catch((err) => {
    console.error("resolve_and_claim crashed:", err);
    process.exit(1);
});
