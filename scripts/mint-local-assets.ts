import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// REPLACE THIS WITH YOUR PHANTOM WALLET PUBLIC KEY
const PHANTOM_WALLET_PUBKEY = new PublicKey("8qTU8baUJSoiDQeBUxchWThsQHMQhFAMZngtYDkR1bYc");
const MOCK_USDC_MINT = new PublicKey("97niChCwqL1cZq38e4ZeKZYeqqBzyG7paNt5UZkeJjy5");

async function main() {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");

    // 1. Connection Sanity Check (Ping Node)
    try {
        const slot = await connection.getSlot();
        console.log(`✅ Connected to localhost successfully! Current Slot: ${slot}`);
    } catch (e) {
        console.error("❌ Cannot connect to local validator. Run 'solana-test-validator' in your terminal.");
        return;
    }

    // 2. Airdrop SOL to Phantom Wallet
    console.log(`\nRequesting 10 SOL airdrop for Phantom wallet: ${PHANTOM_WALLET_PUBKEY.toBase58()}...`);
    const airdropSig = await connection.requestAirdrop(PHANTOM_WALLET_PUBKEY, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig, "confirmed");
    console.log("✅ SOL Airdrop confirmed!");

    // 3. Load System Authority Keypair to sign the mint instructions
    const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
    const mintAuthority = Keypair.fromSecretKey(secretKey);

    console.log(`\nCreating Associated Token Account for Phantom...`);
    const phantomAta = await getOrCreateAssociatedTokenAccount(
        connection,
        mintAuthority, // Payer
        MOCK_USDC_MINT,
        PHANTOM_WALLET_PUBKEY,
        false,
        "confirmed",
        undefined,
        TOKEN_2022_PROGRAM_ID
    );
    console.log(`✅ ATA Derived: ${phantomAta.address.toBase58()}`);

    console.log(`\nMinting 5,000 mock USDC to Phantom wallet...`);
    const mintAmount = 5000 * 1_000_000; // 6 decimals
    const mintSig = await mintTo(
        connection,
        mintAuthority,
        MOCK_USDC_MINT,
        phantomAta.address,
        mintAuthority.publicKey,
        mintAmount,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID
    );
    await connection.confirmTransaction(mintSig, "confirmed");

    const phantomUsdcBalance = await connection.getTokenAccountBalance(phantomAta.address);
    console.log(`\n🚀 Sandbox Funding Complete!`);
    console.log(`Current Phantom Balance: ${phantomUsdcBalance.value.uiAmount} USDC`);
}

main().catch(console.error);