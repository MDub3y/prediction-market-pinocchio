import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, createInitializeMintInstruction, createMintToInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, test, describe, beforeAll } from "bun:test";
import { LiteSVM, FailedTransactionMetadata, Rent } from "litesvm";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PROGRAM_ID = new PublicKey("D5rjf89YcBER8dJxLg1oekZFZqWUKqemSsMj5DWWXhZ9");

function calculateOrderbookSpace(tier: number) {
    const HEADER_SIZE = 44;
    const DIRECTORY_SIZE = 8 * 100 * 2;
    const SEAT_SIZE = 80;
    const NODE_SIZE = 32;

    let seats = 0;
    let orders = 0;

    switch (tier) {
        case 0:
            seats = 128;
            orders = 512;
            break;
        case 1:
            seats = 1024;
            orders = 4096;
            break;
        case 2:
            seats = 4096;
            orders = 16384;
            break;
        default:
            throw new Error(`Invalid market tier: ${tier}`);
    }

    return HEADER_SIZE + DIRECTORY_SIZE + (SEAT_SIZE * seats) + (NODE_SIZE * orders);
}

describe("Prediction Market tests", () => {
    let svm: LiteSVM;
    let maker: Keypair;
    let collateralMintKeypair: Keypair;
    let collateralMint: PublicKey;
    let marketId: bigint;
    let market_pda: PublicKey;
    let marketTier: number;
    let collateralVault: PublicKey;

    let retailUser: Keypair;
    let retailUserState: PublicKey;
    let sharedOrderbookA: Keypair;
    let sharedOrderbookB: Keypair;

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
        marketId = 42n;
        const settlementDeadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
        marketTier = 1;

        const marketIdBuffer = Buffer.alloc(8);
        marketIdBuffer.writeBigUInt64LE(marketId);

        const [marketPda, marketBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("market"), marketIdBuffer],
            PROGRAM_ID
        );
        market_pda = marketPda;

        const [outcomeAMint, bumpOtA] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([0])],
            PROGRAM_ID
        );

        const [outcomeBMint, bumpOtB] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([1])],
            PROGRAM_ID
        );

        const [derivedVault] = PublicKey.findProgramAddressSync(
            [
                marketPda.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                collateralMint.toBuffer()
            ],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        collateralVault = derivedVault;

        const instructionData = Buffer.alloc(20);
        instructionData.writeUInt8(0, 0);
        instructionData.writeBigUInt64LE(marketId, 1);
        instructionData.writeBigInt64LE(settlementDeadline, 9);
        instructionData.writeUInt8(bumpOtA, 17);
        instructionData.writeUInt8(bumpOtB, 18);
        instructionData.writeUInt8(marketTier, 19);

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
                lamports: 5_000_000,
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
            }),
            SystemProgram.transfer({
                fromPubkey: maker.publicKey,
                toPubkey: collateralVault,
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
        expect(marketAccountInfo?.owner.toBuffer().equals(PROGRAM_ID.toBuffer())).toBe(true);

        const vaultAccountInfo = svm.getAccount(collateralVault);
        expect(vaultAccountInfo).not.toBeNull();

        expect(vaultAccountInfo!.owner.toBuffer().equals(TOKEN_PROGRAM_ID.toBuffer())).toBe(true);

        const vaultData = vaultAccountInfo!.data;
        const tokenAuthorityBytes = vaultData.slice(32, 64); // Bytes 32 to 64 represent the token account owner field

        expect(Buffer.from(tokenAuthorityBytes).equals(marketPda.toBuffer())).toBe(true);
        console.log("✅ Verified: The collateral vault internal authority is strictly market_pda.");
    });

    test("Initialize Outcome Orderbooks", () => {
        const orderbookAKeypair = Keypair.generate();
        const orderbookBKeypair = Keypair.generate();
        sharedOrderbookA = orderbookAKeypair;
        sharedOrderbookB = orderbookBKeypair;

        const requiredSpace = calculateOrderbookSpace(marketTier);
        const rentRequired = Number(svm.minimumBalanceForRentExemption(BigInt(requiredSpace)));

        const tx = new Transaction();
        tx.add(
            SystemProgram.createAccount({
                fromPubkey: maker.publicKey,
                newAccountPubkey: orderbookAKeypair.publicKey,
                lamports: rentRequired,
                space: requiredSpace,
                programId: PROGRAM_ID
            })
        );
        tx.add(
            SystemProgram.createAccount({
                fromPubkey: maker.publicKey,
                newAccountPubkey: orderbookBKeypair.publicKey,
                lamports: rentRequired,
                space: requiredSpace,
                programId: PROGRAM_ID
            })
        );

        const instruction_data = Buffer.alloc(1);
        instruction_data.writeUInt8(1, 0);

        const keys = [
            { pubkey: maker.publicKey, isSigner: true, isWritable: true },
            { pubkey: market_pda, isSigner: false, isWritable: true },
            { pubkey: orderbookAKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: orderbookBKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        tx.add(
            new TransactionInstruction({
                keys,
                programId: PROGRAM_ID,
                data: instruction_data
            })
        );

        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = maker.publicKey;
        tx.sign(maker, orderbookAKeypair, orderbookBKeypair);

        const txResult = svm.sendTransaction(tx);

        if (txResult instanceof FailedTransactionMetadata) {
            console.error("========== INITIALIZE ORDERBOOKS FAILED ===========");
            console.error("Error details: ", txResult.err().toString());
            const metadata = txResult.meta();
            if (metadata) {
                console.error("Program logs:\n", metadata.prettyLogs());
            }
            console.log("=================================================");
        }

        expect(txResult instanceof FailedTransactionMetadata).toBe(false);

        const accountInfoA = svm.getAccount(orderbookAKeypair.publicKey);
        const accountInfoB = svm.getAccount(orderbookBKeypair.publicKey);

        expect(accountInfoA).not.toBeNull();
        expect(accountInfoB).not.toBeNull();
        expect(accountInfoA!.owner.toBuffer().equals(PROGRAM_ID.toBuffer())).toBe(true);
        expect(accountInfoB!.owner.toBuffer().equals(PROGRAM_ID.toBuffer())).toBe(true);

        console.log(`✅ Verified: Footprint of ${requiredSpace} bytes initialized for Medium Tier orderbooks.`);
    });

    test("Deposit collateral from retail user", () => {
        const user = Keypair.generate();
        retailUser = user;
        svm.airdrop(user.publicKey, 2_000_000_000n);

        const userTokenAccount = getAssociatedTokenAddressSync(collateralMint, user.publicKey);

        const setupTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                user.publicKey,
                userTokenAccount,
                user.publicKey,
                collateralMint
            ),
            createMintToInstruction(
                collateralMint,
                userTokenAccount,
                maker.publicKey,
                500_000_000n
            )
        );
        setupTx.recentBlockhash = svm.latestBlockhash();
        setupTx.feePayer = user.publicKey;
        setupTx.sign(user, maker);

        const setupResult = svm.sendTransaction(setupTx);
        expect(setupResult instanceof FailedTransactionMetadata).toBe(false);

        const [platformUserState, bumpUserState] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), user.publicKey.toBuffer()],
            PROGRAM_ID
        );
        retailUserState = platformUserState;

        const depositAmount = 200_000_000n;

        const instructionData = Buffer.alloc(10);
        instructionData.writeUInt8(2, 0);
        instructionData.writeBigUInt64LE(depositAmount, 1);
        instructionData.writeUInt8(bumpUserState, 9);

        const keys = [
            { pubkey: user.publicKey, isSigner: true, isWritable: true },
            { pubkey: platformUserState, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: collateralVault, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];

        const depositCollateralIx = new TransactionInstruction({
            keys,
            programId: PROGRAM_ID,
            data: instructionData
        });

        const tx = new Transaction().add(
            depositCollateralIx,
            SystemProgram.transfer({
                fromPubkey: user.publicKey,
                toPubkey: platformUserState,
                lamports: 3_000_000,
            })
        );

        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);

        const txResult = svm.sendTransaction(tx);

        if (txResult instanceof FailedTransactionMetadata) {
            console.error("========== DEPOSIT COLLATERAL FAILED ===========");
            console.error("Error details: ", txResult.err().toString());
            const metadata = txResult.meta();
            if (metadata) {
                console.error("Program logs:\n", metadata.prettyLogs());
            }
            console.log("=================================================");
        }

        expect(txResult instanceof FailedTransactionMetadata).toBe(false);

        const stateAccountInfo = svm.getAccount(platformUserState);
        expect(stateAccountInfo).not.toBeNull();

        const ownerBytes = stateAccountInfo!.owner;
        expect(ownerBytes.toBuffer().equals(PROGRAM_ID.toBuffer())).toBe(true);

        const rawData = stateAccountInfo!.data;
        const dataBuffer = Buffer.from(rawData);

        const savedWalletBytes = dataBuffer.subarray(0, 32);
        const savedCollateralValue = dataBuffer.readBigUInt64LE(32);

        expect(Buffer.from(savedWalletBytes).equals(user.publicKey.toBuffer())).toBe(true);
        expect(savedCollateralValue).toBe(depositAmount);

        console.log(`✅ Verified: New user safely deposited ${depositAmount} tokens into the vault.`);
    });

    test("Place limit order by retail user on outcome A", () => {
        expect(retailUser).not.toBeUndefined();
        expect(retailUserState).not.toBeUndefined();
        expect(sharedOrderbookA).not.toBeUndefined();

        const outcome = 0;
        const side = 0;
        const orderType = 0;
        const price = 50;
        const quantity = 1_000_000n;
        const orderId = 1001n;

        const instructionData = Buffer.alloc(21);
        instructionData.writeUInt8(3, 0);
        instructionData.writeUInt8(outcome, 1);
        instructionData.writeUInt8(side, 2);
        instructionData.writeUInt8(orderType, 3);
        instructionData.writeUInt8(price, 4);
        instructionData.writeBigUInt64LE(quantity, 5);
        instructionData.writeBigUInt64LE(orderId, 13);

        const keys = [
            { pubkey: retailUser.publicKey, isSigner: true, isWritable: true },
            { pubkey: market_pda, isSigner: false, isWritable: true },
            { pubkey: retailUserState, isSigner: false, isWritable: true },
            { pubkey: sharedOrderbookA.publicKey, isSigner: false, isWritable: true }
        ];

        const placeOrderIx = new TransactionInstruction({
            keys,
            programId: PROGRAM_ID,
            data: instructionData
        });

        const tx = new Transaction().add(placeOrderIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = retailUser.publicKey;
        tx.sign(retailUser);

        const txResult = svm.sendTransaction(tx);

        if (txResult instanceof FailedTransactionMetadata) {
            console.error("========== PLACE ORDER FAILED ===========");
            console.error("Error details: ", txResult.err().toString());
            const metadata = txResult.meta();
            if (metadata) {
                console.error("Program logs:\n", metadata.prettyLogs());
            }
            console.log("=========================================");
        }

        expect(txResult instanceof FailedTransactionMetadata).toBe(false);

        const orderbookAccountInfo = svm.getAccount(sharedOrderbookA.publicKey);
        console.log("<<<<<<<<<< ORDERBOOK ACCOUNT INFO >>>>>>>>>>>\n", orderbookAccountInfo);
        expect(orderbookAccountInfo).not.toBeNull();

        const dataBuffer = Buffer.from(orderbookAccountInfo!.data);

        const savedMarketStatePda = new PublicKey(dataBuffer.subarray(0, 32));
        const totalAllocatedSeats = dataBuffer.readUInt32LE(32);
        const nextFreeNodeIdx = dataBuffer.readUInt32LE(36);

        expect(savedMarketStatePda.equals(market_pda)).toBe(true);
        expect(totalAllocatedSeats).toBe(1);
        expect(nextFreeNodeIdx).not.toBe(1);

        const userStateAccountInfo = svm.getAccount(retailUserState);
        const userStateBuffer = Buffer.from(userStateAccountInfo!.data);

        const collateralAvailable = userStateBuffer.readBigUInt64LE(32);
        const expectedRemaining = 200_000_000n - (quantity * BigInt(price));

        expect(collateralAvailable).toBe(expectedRemaining);
        console.log(`✅ Verified: Limit Buy Order placed successfully. Remaining free user balance: ${collateralAvailable}`);
    });
});