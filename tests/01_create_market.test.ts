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
    test("creates market + mints + the collateral vault ATA", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);

        const marketId = 1n;
        const { marketPda, outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);
        const vault = collateralVaultAta(marketPda, collateralMint);

        const marketRent = svm.minimumBalanceForRentExemption(296n);
        const mintRent = svm.minimumBalanceForRentExemption(82n);

        const ix = buildCreateMarketIx({
            payer: payer.publicKey,
            marketPda,
            collateralVault: vault,
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

        // create_market now creates the collateral_vault associated token account itself
        // (CPI to the Associated Token Program, legacy Token program to match
        // deposit_collateral's hardcoded Transfer). Previously this account was never
        // created on-chain at all — the PDA address was only recorded in MarketState.
        const vaultAcct = svm.getAccount(vault);
        expect(vaultAcct).not.toBeNull();
        expect(vaultAcct!.owner.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        const vaultData = Buffer.from(vaultAcct!.data);
        expect(new PublicKey(vaultData.subarray(0, 32)).equals(collateralMint)).toBe(true); // mint field
        expect(new PublicKey(vaultData.subarray(32, 64)).equals(marketPda)).toBe(true); // owner field
        console.log("✅ Verified: collateral_vault ATA is created by create_market itself, owned by the legacy Token program, with owner=market_pda.");
    });

    test("rejects a wrong market PDA (seed mismatch)", () => {
        const svm = freshSvm();
        const { payer, collateralMint } = setupPayerAndMint(svm);
        const marketId = 2n;
        const { outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);
        const wrongMarketPda = PublicKey.unique();
        const vault = collateralVaultAta(wrongMarketPda, collateralMint);

        const ix = buildCreateMarketIx({
            payer: payer.publicKey,
            marketPda: wrongMarketPda,
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
        const vault = collateralVaultAta(marketPda, collateralMint);

        const ix = buildCreateMarketIx({
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
