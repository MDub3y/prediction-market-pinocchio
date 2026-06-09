import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createInitializeMintInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, test, describe, beforeAll } from "bun:test";
import { LiteSVM, FailedTransactionMetadata, Rent } from "litesvm";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PROGRAM_ID = new PublicKey("D5rjf89YcBER8dJxLg1oekZFZqWUKqemSsMj5DWWXhZ9");

describe("Prediction Market tests", () => {
    let svm: LiteSVM;
    let maker: Keypair;
    let collateralMintKeypair: Keypair;
    let collateralMint: PublicKey;

    beforeAll(() => {
        svm = new LiteSVM();

        // Turn off rent rules so Token Program doesn't panic at 0 lamports during execution
        svm.setRent(Rent.free());

        // Load your bare-metal binary from the target deployment directory
        svm.addProgramFromFile(PROGRAM_ID, "../target/deploy/alley.so");

        maker = Keypair.generate();
        svm.airdrop(maker.publicKey, 10_000_000_000n);

        // Setup a mock Collateral Mint inside LiteSVM
        collateralMintKeypair = Keypair.generate();
        collateralMint = collateralMintKeypair.publicKey;

        const rentMint = svm.minimumBalanceForRentExemption(82n);
        const createMintTx = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: maker.publicKey,
                newAccountPubkey: collateralMint,
                lamports: Number(rentMint),
                space: 82,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMintInstruction(
                collateralMint,
                6,
                maker.publicKey,
                maker.publicKey
            )
        );
        createMintTx.recentBlockhash = svm.latestBlockhash();
        createMintTx.feePayer = maker.publicKey;
        createMintTx.sign(maker, collateralMintKeypair);

        const mintResult = svm.sendTransaction(createMintTx);
        expect(mintResult instanceof FailedTransactionMetadata).toBe(false);
    });

    test("Create market instruction", () => {
        const marketId = 42n;
        const settlementDeadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
        const tier = 1;

        const marketIdBuffer = Buffer.alloc(8);
        marketIdBuffer.writeBigUInt64LE(marketId);

        const [marketPda, marketBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("market"), marketIdBuffer],
            PROGRAM_ID
        );

        const [outcomeAMint, bumpOtA] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([0])],
            PROGRAM_ID
        );

        const [outcomeBMint, bumpOtB] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([1])],
            PROGRAM_ID
        );

        const [collateralVault] = PublicKey.findProgramAddressSync(
            [
                marketPda.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                collateralMint.toBuffer()
            ],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const instructionData = Buffer.alloc(20);
        instructionData.writeUInt8(0, 0);
        instructionData.writeBigUInt64LE(marketId, 1);
        instructionData.writeBigInt64LE(settlementDeadline, 9);
        instructionData.writeUInt8(bumpOtA, 17);
        instructionData.writeUInt8(bumpOtB, 18);
        instructionData.writeUInt8(tier, 19);

        const keys = [
            { pubkey: maker.publicKey, isSigner: true, isWritable: true },
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: collateralVault, isSigner: false, isWritable: true },
            { pubkey: outcomeAMint, isSigner: false, isWritable: true },
            { pubkey: outcomeBMint, isSigner: false, isWritable: true },
            { pubkey: collateralMint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];

        const createMarketIx = new TransactionInstruction({
            keys,
            programId: PROGRAM_ID,
            data: instructionData,
        });

        // Pack the creation instruction followed by funding instructions into the same transaction block
        const tx = new Transaction().add(
            createMarketIx,
            SystemProgram.transfer({
                fromPubkey: maker.publicKey,
                toPubkey: marketPda,
                lamports: 5_000_000, // Post-fund to prevent garbage collection
            }),
            SystemProgram.transfer({
                fromPubkey: maker.publicKey,
                toPubkey: outcomeAMint,
                lamports: 2_000_000,
            }),
            SystemProgram.transfer({
                fromPubkey: maker.publicKey,
                toPubkey: outcomeBMint,
                lamports: 2_000_000,
            })
        );

        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = maker.publicKey;
        tx.sign(maker);

        const txResult = svm.sendTransaction(tx);

        if (txResult instanceof FailedTransactionMetadata) {
            console.error("\n=== TRANSACTION FAILED ===");
            console.error("Error Details:", txResult.err().toString());

            const metadata = txResult.meta();
            if (metadata) {
                console.error("Program Logs:\n", metadata.prettyLogs());
            }
            console.error("=============================\n");
        }

        expect(txResult instanceof FailedTransactionMetadata).toBe(false);

        // Verify state persistence inside LiteSVM ledger
        const marketAccountInfo = svm.getAccount(marketPda);
        expect(marketAccountInfo).not.toBeNull();
        console.log("MarketAccountInfo: ", marketAccountInfo);
        expect(marketAccountInfo?.owner.toBuffer().equals(PROGRAM_ID.toBuffer())).toBe(true);
    });
});