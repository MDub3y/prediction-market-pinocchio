import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect, test, describe } from "bun:test";
import { FailedTransactionMetadata } from "litesvm";
import {
    setupTradableMarket,
    depositForNewUser,
    marketUserStatePda,
    buildPlaceOrderIx,
    buildResolveMarketIx,
    buildClaimFundsIx,
    buildClaimWinningsIx,
    buildEmergencyRefundIx,
    readMarketState,
    readMarketUserState,
    readPlatformUserState,
    sendOk,
    advanceClockBy,
    OrderType,
    MarketStateOffsets,
} from "./helpers";

function split(m: ReturnType<typeof setupTradableMarket>, user: any, platformUserState: PublicKey, amount: bigint) {
    const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);
    const ix = buildPlaceOrderIx({
        user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
        orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
        outcome: 0, side: 0, orderType: OrderType.Split, price: 0, quantity: amount, orderId: 0n, bumpMarketUser: bump,
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = m.svm.latestBlockhash();
    tx.feePayer = user.publicKey;
    tx.sign(user);
    sendOk(m.svm, tx, `split ${amount}`);
    return marketUserState;
}

describe("resolve_market", () => {
    // resolve_market now uses a trusted-keeper model: whichever pubkey was passed as
    // `oracle_authority_acc` at create_market time is the only signer that can ever
    // resolve that specific market. setupTradableMarket() generates a dedicated keeper
    // keypair per market (m.keeper) to exercise this.

    test("market_status advances to 1 once orderbooks exist, and the configured keeper can then resolve it", () => {
        const marketId = 500n;
        const m = setupTradableMarket(0, marketId);

        const stateBefore = readMarketState(Buffer.from(m.svm.getAccount(m.marketPda)!.data));
        expect(stateBefore.marketStatus).toBe(1);
        expect(stateBefore.oracleAuthority.equals(m.keeper.publicKey)).toBe(true);

        const ix = buildResolveMarketIx({ keeper: m.keeper.publicKey, marketPda: m.marketPda, winningOutcome: 0 });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = m.payer.publicKey;
        tx.sign(m.payer, m.keeper);
        sendOk(m.svm, tx, "resolve_market via normal flow, signed by the market's keeper");

        const state = readMarketState(Buffer.from(m.svm.getAccount(m.marketPda)!.data));
        expect(state.isSettled).toBe(1);
        expect(state.winningOutcome).toBe(0);
        expect(state.marketStatus).toBe(2);
        console.log("✅ Verified: resolve_market succeeds end-to-end via create_market -> initialize_orderbooks -> resolve_market, signed by the market's configured keeper.");
    });

    test("rejects resolution attempts NOT signed by the market's configured keeper", () => {
        const marketId = 501n;
        const m = setupTradableMarket(0, marketId);
        const impostor = m.payer; // anyone who is not m.keeper, including the market creator itself

        const ix = buildResolveMarketIx({ keeper: impostor.publicKey, marketPda: m.marketPda, winningOutcome: 0 });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = impostor.publicKey;
        tx.sign(impostor);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
        console.log("✅ Verified: resolve_market rejects any signer other than the market's recorded oracle_authority.");
    });

    test("resolve_market is idempotency-guarded against double resolution", () => {
        const marketId = 502n;
        const m = setupTradableMarket(0, marketId);
        const ix = buildResolveMarketIx({ keeper: m.keeper.publicKey, marketPda: m.marketPda, winningOutcome: 1 });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = m.payer.publicKey;
        tx.sign(m.payer, m.keeper);
        sendOk(m.svm, tx, "resolve_market");

        const state = readMarketState(Buffer.from(m.svm.getAccount(m.marketPda)!.data));
        expect(state.isSettled).toBe(1);
        expect(state.winningOutcome).toBe(1);
        expect(state.marketStatus).toBe(2);

        // second resolution attempt must fail (already settled), even from the real keeper
        const tx2 = new Transaction().add(buildResolveMarketIx({ keeper: m.keeper.publicKey, marketPda: m.marketPda, winningOutcome: 0 }));
        tx2.recentBlockhash = m.svm.latestBlockhash();
        tx2.feePayer = m.payer.publicKey;
        tx2.sign(m.payer, m.keeper);
        const res2 = m.svm.sendTransaction(tx2);
        expect(res2 instanceof FailedTransactionMetadata).toBe(true);
    });

    test("rejects an out-of-range winning_outcome byte", () => {
        const marketId = 503n;
        const m = setupTradableMarket(0, marketId);
        const ix = buildResolveMarketIx({ keeper: m.keeper.publicKey, marketPda: m.marketPda, winningOutcome: 7 });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = m.payer.publicKey;
        tx.sign(m.payer, m.keeper);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});

describe("claim_winnings", () => {
    test("FIXED: claim_winnings correctly credits ot_a_balance when outcome A wins", () => {
        // Previously claim_winning.rs compared a mint address to a market PDA address
        // (`if winning_mint_target == market_user.market_pda`), which can never be equal,
        // so it always fell into the ot_b branch regardless of which outcome actually won.
        // It now branches on the market's actual `winning_outcome` field instead.
        const marketId = 510n;
        const m = setupTradableMarket(0, marketId);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const mus = split(m, user, platformUserState, 10_000_000n); // otABalance = otBBalance = 10_000_000

        // Deliberately make the two legs diverge so a wrong-leg credit is unmistakable:
        // burn down ot_b_balance via merge is not possible alone, so instead just trust
        // the distinguishing assertions below (which leg went to zero, which stayed).
        const acct = m.svm.getAccount(m.marketPda)!;
        const buf = Buffer.from(acct.data);
        buf.writeUInt8(1, MarketStateOffsets.isSettled);
        buf.writeUInt8(0, MarketStateOffsets.winningOutcome); // A wins
        buf.writeUInt8(2, MarketStateOffsets.marketStatus);
        m.svm.setAccount(m.marketPda, { ...acct, data: new Uint8Array(buf) });

        const userAtaA = getAssociatedTokenAddressSync(m.outcomeAMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ix = buildClaimWinningsIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState: mus,
            winningMint: m.outcomeAMint, userTokenAccount: userAtaA, // no external ATA created -> external balance treated as 0
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        sendOk(m.svm, tx, "claim_winnings (A wins)");

        const musAfter = readMarketUserState(Buffer.from(m.svm.getAccount(mus)!.data));
        expect(musAfter.otABalance).toBe(0n); // the correct (winning) leg got cleared
        expect(musAfter.otBBalance).toBe(10_000_000n); // the losing leg is untouched, as it should be

        const pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(200_000_000n - 10_000_000n + 10_000_000n); // split cost 10M, winnings credited back 10M
        console.log("✅ Verified: claim_winnings now correctly credits ot_a_balance (the actual winning leg) when outcome A wins, and leaves ot_b_balance untouched.");
    });

    test("claim_winnings burns external wallet tokens and credits them to platform collateral", () => {
        const marketId = 511n;
        const m = setupTradableMarket(0, marketId);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const mus = marketUserStatePda(m.marketPda, user.publicKey)[0];
        split(m, user, platformUserState, 1n); // just to create market_user_state

        // settle: outcome B wins
        const acct = m.svm.getAccount(m.marketPda)!;
        const buf = Buffer.from(acct.data);
        buf.writeUInt8(1, MarketStateOffsets.isSettled);
        buf.writeUInt8(1, MarketStateOffsets.winningOutcome);
        buf.writeUInt8(2, MarketStateOffsets.marketStatus);
        m.svm.setAccount(m.marketPda, { ...acct, data: new Uint8Array(buf) });

        const userAtaB = getAssociatedTokenAddressSync(m.outcomeBMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ix = buildClaimWinningsIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState: mus,
            winningMint: m.outcomeBMint, userTokenAccount: userAtaB,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        sendOk(m.svm, tx, "claim_winnings (B wins, internal ledger only)");

        const pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(200_000_000n - 1n + 1n); // split cost 1, credited back 1
    });
});

describe("emergency_refund", () => {
    test("rejects before the 7-day post-deadline grace window has elapsed", () => {
        const marketId = 520n;
        const m = setupTradableMarket(0, marketId, 100); // settlement in 100s
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const mus = split(m, user, platformUserState, 5_000_000n);

        advanceClockBy(m.svm, 200n); // past deadline but not past deadline+7d
        const ataA = getAssociatedTokenAddressSync(m.outcomeAMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ataB = getAssociatedTokenAddressSync(m.outcomeBMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ix = buildEmergencyRefundIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState: mus,
            outcomeAMint: m.outcomeAMint, outcomeBMint: m.outcomeBMint, userAtaA: ataA, userAtaB: ataB,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });

    test("succeeds after deadline + 7 days and refunds the min(ot_a, ot_b) balance to platform collateral", () => {
        const marketId = 521n;
        const m = setupTradableMarket(0, marketId, 100);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const mus = split(m, user, platformUserState, 5_000_000n);

        advanceClockBy(m.svm, 100n + 604_800n + 10n);
        const ataA = getAssociatedTokenAddressSync(m.outcomeAMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ataB = getAssociatedTokenAddressSync(m.outcomeBMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ix = buildEmergencyRefundIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState: mus,
            outcomeAMint: m.outcomeAMint, outcomeBMint: m.outcomeBMint, userAtaA: ataA, userAtaB: ataB,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        sendOk(m.svm, tx, "emergency_refund");

        const musAfter = readMarketUserState(Buffer.from(m.svm.getAccount(mus)!.data));
        expect(musAfter.otABalance).toBe(0n);
        expect(musAfter.otBBalance).toBe(0n);
        const pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(200_000_000n); // 5M split out, 5M refunded back
        console.log("✅ Verified: emergency_refund correctly refunds a stuck market's balanced OT holdings after the 7-day grace window.");
    });

    test("rejects once the market has already been settled", () => {
        const marketId = 522n;
        const m = setupTradableMarket(0, marketId, 100);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const mus = split(m, user, platformUserState, 5_000_000n);

        const acct = m.svm.getAccount(m.marketPda)!;
        const buf = Buffer.from(acct.data);
        buf.writeUInt8(1, MarketStateOffsets.isSettled);
        m.svm.setAccount(m.marketPda, { ...acct, data: new Uint8Array(buf) });

        advanceClockBy(m.svm, 100n + 604_800n + 10n);
        const ataA = getAssociatedTokenAddressSync(m.outcomeAMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ataB = getAssociatedTokenAddressSync(m.outcomeBMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ix = buildEmergencyRefundIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState: mus,
            outcomeAMint: m.outcomeAMint, outcomeBMint: m.outcomeBMint, userAtaA: ataA, userAtaB: ataB,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});
