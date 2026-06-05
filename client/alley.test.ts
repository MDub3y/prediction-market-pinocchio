import { describe, beforeAll, test, expect } from "bun:test";
import { LiteSVM } from "litesvm"; // High-performance in-process Solana VM
import {
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction
} from "@solana/web3.js";
import { Buffer } from "buffer";

// Standard Token Program ID constants
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

describe("Alley Core Protocol Integration Engine", () => {
    let svm: LiteSVM;
    let programId: PublicKey;

    // Actor Roles
    let creator: Keypair;
    let traderTaker: Keypair;
    let traderMaker: Keypair;

    // Shared State PDA Derivations
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

    // User Central Position Profiles
    let makerPlatformState: PublicKey;
    let makerStateBump: number;
    let takerPlatformState: PublicKey;
    let takerStateBump: number;

    beforeAll(() => {
        svm = new LiteSVM();
        programId = new PublicKey("D5rjf89YcBER8dJxLg1oekZFZqWUKqemSsMj5DWWXhZ9");

        svm.addProgramFromFile(programId, "target/deploy/alley.so");

        creator = Keypair.generate();
        traderMaker = Keypair.generate();
        traderTaker = Keypair.generate();

        svm.airdrop(creator.publicKey, 10_000_000_000n);
        svm.airdrop(traderMaker.publicKey, 10_000_000_000n);
        svm.airdrop(traderTaker.publicKey, 10_000_000_000n);

        marketId = 8888n;
        collateralMint = Keypair.generate().publicKey;

        const [marketPda, marketBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("market"), Buffer.from(marketId.toString(16).padStart(16, '0'), 'hex').reverse()],
            programId
        );
        const [outcomeAMint, outcomeABump] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([0])],
            programId
        );
        const [outcomeBMint, outcomeBBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([1])],
            programId
        );

        const [collateralVault] = PublicKey.findProgramAddressSync(
            [marketPda.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), collateralMint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Derive Monolithic Price Book PDAs
        const [orderbookA, orderbookABump] = PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook_a"), marketPda.toBuffer()],
            programId
        );

        const [orderbookB, orderbookBBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook_b"), marketPda.toBuffer()],
            programId
        );

        const [makerPlatformState, makerStateBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), traderMaker.publicKey.toBuffer()],
            programId
        );

        const [takerPlatformState, takerStateBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_state"), traderTaker.publicKey.toBuffer()],
            programId
        );
    });
});