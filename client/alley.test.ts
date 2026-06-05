import { describe, beforeAll, test, expect } from "bun:test";
import { LiteSVM } from "litesvm";
import {
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction
} from "@solana/web3.js";
import { Buffer } from "buffer";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

describe("Alley Core Protocol Integration Engine", () => {
    let svm: LiteSVM;
    let programId: PublicKey;

    let creator: Keypair;
    let traderTaker: Keypair;
    let traderMaker: Keypair;

    let marketId: bigint;
    let marketPda: PublicKey;
    let marketBump: number;
    let collateralMint: PublicKey;
    let collateralVault: PublicKey;
    let outcomeAMint: PublicKey;
    let outcomeBMint: PublicKey;
    let outcomeABump: number;
    let outcomeBBump: number;
    let orderbookA: PublicKey;
    let orderbookABump: number;
    let orderbookB: PublicKey;
    let orderbookBBump: number;

    let makerPlatformState: PublicKey;
    let makerStateBump: number;
    let takerPlatformState: PublicKey;
    let takerStateBump: number;

    beforeAll(() => {
        svm = new LiteSVM();
        programId = new PublicKey("D5rjf89YcBER8dJxLg1oekZFZqWUKqemSsMj5DWWXhZ9");

        svm.addProgramFromFile(programId, "../target/deploy/alley.so");

        creator = Keypair.generate();
        traderMaker = Keypair.generate();
        traderTaker = Keypair.generate();

        svm.airdrop(creator.publicKey, 10_000_000_000n);
        svm.airdrop(traderMaker.publicKey, 10_000_000_000n);
        svm.airdrop(traderTaker.publicKey, 10_000_000_000n);

        marketId = 8888n;
        collateralMint = Keypair.generate().publicKey;

        const marketPdaRes = PublicKey.findProgramAddressSync(
            [Buffer.from("market"), Buffer.from(marketId.toString(16).padStart(16, '0'), 'hex').reverse()],
            programId
        );
        marketPda = marketPdaRes[0];
        marketBump = marketPdaRes[1];

        const outcomeAMintRes = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([0])],
            programId
        );
        outcomeAMint = outcomeAMintRes[0];
        outcomeABump = outcomeAMintRes[1];

        const outcomeBMintRes = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([1])],
            programId
        );
        outcomeBMint = outcomeBMintRes[0];
        outcomeBBump = outcomeBMintRes[1];

        const collateralVaultRes = PublicKey.findProgramAddressSync(
            [marketPda.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), collateralMint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        collateralVault = collateralVaultRes[0];

        const orderbookARes = PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook_a"), marketPda.toBuffer()],
            programId
        );
        orderbookA = orderbookARes[0];
        orderbookABump = orderbookARes[1];

        const orderbookBRes = PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook_b"), marketPda.toBuffer()],
            programId
        );
        orderbookB = orderbookBRes[0];
        orderbookBBump = orderbookBRes[1];

        const makerPlatformStateRes = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), traderMaker.publicKey.toBuffer()],
            programId
        );
        makerPlatformState = makerPlatformStateRes[0];
        makerStateBump = makerPlatformStateRes[1];

        const takerPlatformStateRes = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), traderTaker.publicKey.toBuffer()],
            programId
        );
        takerPlatformState = takerPlatformStateRes[0];
        takerStateBump = takerPlatformStateRes[1];
    });

    test("Alley create market", () => {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
        const tier = 1;

        const layoutBuffer = Buffer.alloc(20);
        layoutBuffer.writeUInt8(0, 0);
        layoutBuffer.writeBigUInt64LE(marketId, 1);
        layoutBuffer.writeBigInt64LE(deadline, 9);
        layoutBuffer.writeUInt8(outcomeABump, 17);
        layoutBuffer.writeUInt8(outcomeBBump, 18);
        layoutBuffer.writeUInt8(tier, 19);

        const fundMarketTx = SystemProgram.transfer({
            fromPubkey: creator.publicKey,
            toPubkey: marketPda,
            lamports: 3_000_000,
        });
        const fundMintATx = SystemProgram.transfer({
            fromPubkey: creator.publicKey,
            toPubkey: outcomeAMint,
            lamports: 2_000_000,
        });
        const fundMintBTx = SystemProgram.transfer({
            fromPubkey: creator.publicKey,
            toPubkey: outcomeBMint,
            lamports: 2_000_000,
        });

        const instruction = new TransactionInstruction({
            programId,
            keys: [
                { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                { pubkey: marketPda, isSigner: false, isWritable: true },
                { pubkey: collateralVault, isSigner: false, isWritable: true },
                { pubkey: outcomeAMint, isSigner: false, isWritable: true },
                { pubkey: outcomeBMint, isSigner: false, isWritable: true },
                { pubkey: collateralMint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: layoutBuffer,
        });

        const tx = new Transaction()
            .add(fundMarketTx)
            .add(fundMintATx)
            .add(fundMintBTx)
            .add(instruction);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.sign(creator);

        const txResult = svm.sendTransaction(tx);
        expect(txResult).not.toBeNull();

        const marketAccountInfo = svm.getAccount(marketPda);
        expect(marketAccountInfo).not.toBeNull();
        expect(marketAccountInfo?.data.length).toBe(252);
    });
});