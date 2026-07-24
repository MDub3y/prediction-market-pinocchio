import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect, test, describe } from "bun:test";
import { FailedTransactionMetadata } from "litesvm";
import {
    freshSvm,
    setupPayerAndMint,
    marketPdas,
    collateralVaultAta,
    buildCreateMarketIx,
    sendOk,
    readMarketState,
} from "./helpers";

describe("create_market", () => {
    test("creates market + mints, and records the (global, not yet created) collateral vault address", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);

        const marketId = 1n;
        const { marketPda, outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);

        const marketRent = svm.minimumBalanceForRentExemption(296n);
        const mintRent = svm.minimumBalanceForRentExemption(82n);

        const ix = buildCreateMarketIx({
            payer: payer.publicKey,
            marketPda,
            outcomeAMint,
            outcomeBMint,
            collateralMint,
            marketId,
            settlementDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
            marketRent,
            mintRent,
            bumpOtA,
            bumpOtB,
            tier: 1,
        });

        const tx = new Transaction().add(ix);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(payer);
        sendOk(svm, tx, "create_market");

        const marketAcct = svm.getAccount(marketPda);
        expect(marketAcct).not.toBeNull();
        const state = readMarketState(Buffer.from(marketAcct!.data));
        expect(state.outcomeAMint.equals(outcomeAMint)).toBe(true);
        expect(state.outcomeBMint.equals(outcomeBMint)).toBe(true);
        expect(state.marketStatus).toBe(0);

        // The collateral vault is now a single account shared across every market
        // (mirrors PlatformUserState already being global) — create_market only records
        // its canonical derived address, it doesn't create the account. It's created
        // lazily by whichever deposit_collateral call happens first on the whole
        // platform (see 02_orderbooks_and_deposit.test.ts).
        const expectedVault = collateralVaultAta(collateralMint);
        expect(state.collateralVault.equals(expectedVault)).toBe(true);
        const vaultAcct = svm.getAccount(expectedVault);
        expect(vaultAcct).toBeNull();
        console.log("✅ Verified: create_market records the correct global vault address without creating it.");
    });

    test("two different markets record the SAME global vault address", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);

        function create(marketId: bigint) {
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
            return readMarketState(Buffer.from(svm.getAccount(marketPda)!.data));
        }

        const stateA = create(10n);
        const stateB = create(11n);
        expect(stateA.collateralVault.equals(stateB.collateralVault)).toBe(true);
        expect(stateA.collateralVault.equals(collateralVaultAta(collateralMint))).toBe(true);
        console.log("✅ Verified: every market records the same shared collateral vault address.");
    });

    test("rejects a wrong market PDA (seed mismatch)", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);
        const marketId = 2n;
        const { outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);
        const wrongMarketPda = PublicKey.unique();

        const ix = buildCreateMarketIx({
            payer: payer.publicKey,
            marketPda: wrongMarketPda,
            outcomeAMint,
            outcomeBMint,
            collateralMint,
            marketId,
            settlementDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
            marketRent: svm.minimumBalanceForRentExemption(296n),
            mintRent: svm.minimumBalanceForRentExemption(82n),
            bumpOtA,
            bumpOtB,
            tier: 0,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(payer);
        const res = svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });

    test("rejects an invalid tier byte", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);
        const marketId = 3n;
        const { marketPda, outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);

        const ix = buildCreateMarketIx({
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
            tier: 5, // invalid
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(payer);
        const res = svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});
