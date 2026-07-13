import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

async function main() {
    // Connect directly to your locally running validator instance
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");

    // Load your local system CLI keypair that holds the 500,000,100 SOL balance
    const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
    if (!fs.existsSync(keypairPath)) {
        throw new Error(`Local authority keypair not found at ${keypairPath}. Run 'solana keypair write' first.`);
    }

    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
    const payer = Keypair.fromSecretKey(secretKey);

    console.log("Wallet Loaded:", payer.publicKey.toBase58());
    console.log("Current Balance:", (await connection.getBalance(payer.publicKey)) / 1_000_000_000, "SOL");

    console.log("\nAllocating memory space and deploying Token-2022 mint layout...");

    // Deploy a verified Token-2022 compliant mint directly to your local validator sandbox
    const mint = await createMint(
        connection,
        payer,
        payer.publicKey, // Mint Authority
        payer.publicKey, // Freeze Authority
        6,               // Decimals matching USDC standard precision scales
        undefined,       // Randomized signers tracking
        undefined,
        TOKEN_2022_PROGRAM_ID
    );

    console.log("\n🚀 Token-2022 Mint Initialized Successfully on Localhost!");
    console.log("==========================================================================");
    console.log("Copy and update your `lib/constants.ts` file with this new address:");
    console.log(`export const USDC_DEV_MINT = new PublicKey("${mint.toBase58()}");`);
    console.log("==========================================================================");
}

main().catch((err) => {
    console.error("Token initialization crashed:", err);
});