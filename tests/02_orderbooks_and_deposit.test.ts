import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
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
    const vault = collateralVaultAta(collateralMint);

    const createIx = buildCreateMarketIx({
        payer: payer.publicKey,
        marketPda,
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
    sendOk(svm, tx, "create_market");

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
    test("lazily creates the global vault on the very first deposit, then reuses it", () => {
        const { svm, payer, collateralMint, vault } = setUpMarket(1, 200n);
        expect(svm.getAccount(vault)).toBeNull(); // not created by create_market

        const { user, tokenAccount } = createFundedUser(svm, collateralMint, payer, 500_000_000n);
        deposit(svm, user, collateralMint, vault, tokenAccount, 100_000_000n);

        const vaultAcct = svm.getAccount(vault);
        expect(vaultAcct).not.toBeNull();
        expect(vaultAcct!.owner.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        console.log("✅ Verified: deposit_collateral lazily creates the global vault on first use.");
    });

    test("a second market's deposits land in the SAME vault as the first market's", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);
        const vault = collateralVaultAta(collateralMint);

        function createMarket(marketId: bigint) {
            const { marketPda, outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);
            const ix = buildCreateMarketIx({
                payer: payer.publicKey, marketPda, outcomeAMint, outcomeBMint, collateralMint, marketId,
                settlementDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
                marketRent: svm.minimumBalanceForRentExemption(296n),
                mintRent: svm.minimumBalanceForRentExemption(82n),
                bumpOtA, bumpOtB, tier: 0,
            });
            const tx = new Transaction().add(ix);
            tx.recentBlockhash = svm.latestBlockhash();
            tx.feePayer = payer.publicKey;
            tx.sign(payer);
            sendOk(svm, tx, `create_market ${marketId}`);
        }
        createMarket(300n);
        createMarket(301n);

        const { user: userA, tokenAccount: taA } = createFundedUser(svm, collateralMint, payer, 500_000_000n);
        deposit(svm, userA, collateralMint, vault, taA, 40_000_000n); // creates the vault (market 300 context doesn't matter -- deposit_collateral takes no market_pda)

        const { user: userB, tokenAccount: taB } = createFundedUser(svm, collateralMint, payer, 500_000_000n);
        deposit(svm, userB, collateralMint, vault, taB, 25_000_000n);

        const vaultAcct = svm.getAccount(vault)!;
        const vaultAmount = Buffer.from(vaultAcct.data).readBigUInt64LE(64);
        expect(vaultAmount).toBe(65_000_000n); // both users' deposits landed in the one shared vault
        console.log("✅ Verified: deposits from users trading on different markets accumulate in the single shared vault.");
    });

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
            collateralMint,
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

    test("rejects a vault address that doesn't match the canonical derivation", () => {
        const { svm, payer, collateralMint } = setUpMarket(1, 202n);
        const { user, tokenAccount } = createFundedUser(svm, collateralMint, payer, 500_000_000n);
        const [platformState, bump] = platformUserStatePda(user.publicKey);
        const wrongVault = PublicKey.unique();

        const ix = buildDepositIx({
            user: user.publicKey,
            platformUserState: platformState,
            userTokenAccount: tokenAccount,
            collateralVault: wrongVault,
            collateralMint,
            amount: 1_000n,
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
