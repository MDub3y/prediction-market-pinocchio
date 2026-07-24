import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, test, describe } from "bun:test";
import { FailedTransactionMetadata } from "litesvm";
import {
    freshSvm,
    setupPayerAndMint,
    marketPdas,
    collateralVaultAta,
    buildCreateMarketIx,
    buildInitOrderbooksIx,
    buildDepositIx,
    calculateOrderbookSpace,
    readHeader,
    sendOk,
    PROGRAM_ID,
    createFundedUser,
    platformUserStatePda,
    deposit,
    readPlatformUserState,
    TIER_SEATS,
    TIER_ORDERS,
} from "./helpers";

function setUpMarket(tier: number, marketId: bigint) {
    const svm = freshSvm();
    const { payer, collateralMint } = setupPayerAndMint(svm);
    const { marketPda, outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);
    const vault = collateralVaultAta(marketPda, collateralMint);

    const createIx = buildCreateMarketIx({
        payer: payer.publicKey,
        marketPda,
        collateralVault: vault,
        outcomeAMint,
        outcomeBMint,
        collateralMint,
        marketId,
        settlementDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        marketRent: svm.minimumBalanceForRentExemption(296n),
        mintRent: svm.minimumBalanceForRentExemption(82n),
        bumpOtA,
        bumpOtB,
        tier,
    });
    const tx = new Transaction().add(createIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    sendOk(svm, tx, "create_market"); // also creates the collateral vault ATA on-chain now

    return { svm, payer, collateralMint, marketPda, outcomeAMint, outcomeBMint, vault };
}

describe("initialize_orderbooks", () => {
    for (const tier of [0, 1, 2]) {
        test(`allocates correct space and zero-initializes free-lists for tier ${tier}`, () => {
            const { svm, payer, marketPda } = setUpMarket(tier, 100n + BigInt(tier));

            const orderbookA = Keypair.generate();
            const orderbookB = Keypair.generate();
            const requiredSpace = calculateOrderbookSpace(tier);
            const rent = svm.minimumBalanceForRentExemption(BigInt(requiredSpace));

            const tx = new Transaction().add(
                SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: orderbookA.publicKey, lamports: Number(rent), space: requiredSpace, programId: PROGRAM_ID }),
                SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: orderbookB.publicKey, lamports: Number(rent), space: requiredSpace, programId: PROGRAM_ID }),
                buildInitOrderbooksIx({ payer: payer.publicKey, marketPda, orderbookA: orderbookA.publicKey, orderbookB: orderbookB.publicKey })
            );
            tx.recentBlockhash = svm.latestBlockhash();
            tx.feePayer = payer.publicKey;
            tx.sign(payer, orderbookA, orderbookB);
            sendOk(svm, tx, `initialize_orderbooks tier ${tier}`);

            const acctA = svm.getAccount(orderbookA.publicKey)!;
            expect(acctA.data.length).toBe(requiredSpace);
            const header = readHeader(Buffer.from(acctA.data));
            expect(header.marketStatePda.equals(marketPda)).toBe(true);
            expect(header.totalAllocatedSeats).toBe(0);
            expect(header.nextFreeNodeIdx).toBe(1);
            expect(header.outcomeIndex).toBe(0);

            console.log(`✅ tier ${tier}: seats=${TIER_SEATS[tier]} orders=${TIER_ORDERS[tier]} space=${requiredSpace} bytes, rent=${rent} lamports (${Number(rent) / 1e9} SOL)`);
        });
    }

    test("rejects orderbook accounts smaller than required tier space", () => {
        const { svm, payer, marketPda } = setUpMarket(1, 110n);
        const orderbookA = Keypair.generate();
        const orderbookB = Keypair.generate();
        const tooSmall = 1000; // way under the ~350KB medium-tier requirement
        const rent = svm.minimumBalanceForRentExemption(BigInt(tooSmall));

        const tx = new Transaction().add(
            SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: orderbookA.publicKey, lamports: Number(rent), space: tooSmall, programId: PROGRAM_ID }),
            SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: orderbookB.publicKey, lamports: Number(rent), space: tooSmall, programId: PROGRAM_ID }),
            buildInitOrderbooksIx({ payer: payer.publicKey, marketPda, orderbookA: orderbookA.publicKey, orderbookB: orderbookB.publicKey })
        );
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(payer, orderbookA, orderbookB);
        const res = svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});

describe("deposit_collateral", () => {
    test("creates PlatformUserState on first deposit and accumulates on repeat deposits", () => {
        const { svm, payer, collateralMint, vault } = setUpMarket(1, 200n);
        const { user, tokenAccount } = createFundedUser(svm, collateralMint, payer, 500_000_000n);

        const platformState = deposit(svm, user, collateralMint, vault, tokenAccount, 100_000_000n);
        let stateAcct = svm.getAccount(platformState)!;
        let state = readPlatformUserState(Buffer.from(stateAcct.data));
        expect(state.wallet.equals(user.publicKey)).toBe(true);
        expect(state.collateralAvailable).toBe(100_000_000n);

        // second deposit should top up, not overwrite
        deposit(svm, user, collateralMint, vault, tokenAccount, 50_000_000n);
        stateAcct = svm.getAccount(platformState)!;
        state = readPlatformUserState(Buffer.from(stateAcct.data));
        expect(state.collateralAvailable).toBe(150_000_000n);

        // vault should hold the sum
        const vaultAcct = svm.getAccount(vault)!;
        const vaultAmount = Buffer.from(vaultAcct.data).readBigUInt64LE(64);
        expect(vaultAmount).toBe(150_000_000n);

        console.log("✅ Verified: repeat deposits accumulate correctly in PlatformUserState and the vault.");
    });

    test("fails cleanly when the user's token account has insufficient balance", () => {
        const { svm, payer, collateralMint, vault } = setUpMarket(1, 201n);
        const { user, tokenAccount } = createFundedUser(svm, collateralMint, payer, 10_000n);
        const [platformState, bump] = platformUserStatePda(user.publicKey);

        const ix = buildDepositIx({
            user: user.publicKey,
            platformUserState: platformState,
            userTokenAccount: tokenAccount,
            collateralVault: vault,
            amount: 999_999_999n,
            bumpUserState: bump,
        });
        const tx = new Transaction().add(
            ix,
            SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: platformState, lamports: 3_000_000 })
        );
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        const res = svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});

describe("frontend/on-chain token-program mismatch (regression)", () => {
    test("the vault address alley-web actually derives (seeded with TOKEN_PROGRAM_2022_ID) cannot be created for a legacy-Token collateral mint", () => {
        // app/create/page.tsx derives collateralVault as:
        //   findProgramAddressSync([marketPda, TOKEN_PROGRAM_2022_ID, USDC_DEV_MINT], ASSOCIATED_TOKEN_PROGRAM_ID)
        // but USDC_DEV_MINT (like any `spl-token create-token` mint) is owned by the
        // LEGACY Tokenkeg program, and deposit_collateral.rs's Transfer CPI is hardcoded
        // to the legacy program too. Reproduce exactly what the frontend does and show
        // the resulting "vault" can never actually be initialized as a token account for
        // that mint — the Associated Token Program instruction fails immediately.
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm); // legacy-Token mint
        const marketId = 999n;
        const { marketPda } = marketPdas(marketId);

        const frontendDerivedVault = collateralVaultAta(marketPda, collateralMint, TOKEN_2022_PROGRAM_ID);

        const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(payer.publicKey, frontendDerivedVault, marketPda, collateralMint, TOKEN_2022_PROGRAM_ID)
        );
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(payer);
        const res = svm.sendTransaction(tx);

        expect(res instanceof FailedTransactionMetadata).toBe(true);
        console.log("⚠️  CONFIRMED: app/create/page.tsx's collateralVault derivation (seeded with TOKEN_PROGRAM_2022_ID) is not a valid ATA for the legacy-Token USDC_DEV_MINT — it can never be created.");
    });
});
