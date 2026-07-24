import { PublicKey, Transaction } from "@solana/web3.js";
import { expect, test, describe } from "bun:test";
import { FailedTransactionMetadata } from "litesvm";
import {
    setupTradableMarket,
    depositForNewUser,
    marketUserStatePda,
    buildPlaceOrderIx,
    readMarketUserState,
    readPriceLevel,
    readSeat,
    readNode,
    readPlatformUserState,
    sendOk,
    OrderType,
    Side,
    Outcome,
} from "./helpers";

function placeLimit(m: ReturnType<typeof setupTradableMarket>, user: any, platformUserState: PublicKey, outcome: number, side: number, price: number, quantity: bigint, orderId: bigint, remaining: PublicKey[] = []) {
    const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);
    const ix = buildPlaceOrderIx({
        user: user.publicKey,
        marketPda: m.marketPda,
        platformUserState,
        marketUserState,
        orderbookA: m.orderbookA.publicKey,
        orderbookB: m.orderbookB.publicKey,
        outcome,
        side,
        orderType: OrderType.Limit,
        price,
        quantity,
        orderId,
        bumpMarketUser: bump,
        remainingAccounts: remaining,
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = m.svm.latestBlockhash();
    tx.feePayer = user.publicKey;
    tx.sign(user);
    sendOk(m.svm, tx, `place limit order (outcome=${outcome} side=${side} price=${price} qty=${quantity})`);
    return marketUserState;
}

describe("place_order: limit — validation", () => {
    test("rejects price = 0 and price >= 100 for limit orders", () => {
        const m = setupTradableMarket(0, 300n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);

        for (const badPrice of [0, 100, 255]) {
            const ix = buildPlaceOrderIx({
                user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
                orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
                outcome: Outcome.A, side: Side.Buy, orderType: OrderType.Limit,
                price: badPrice, quantity: 1000n, orderId: 1n, bumpMarketUser: bump,
            });
            const tx = new Transaction().add(ix);
            tx.recentBlockhash = m.svm.latestBlockhash();
            tx.feePayer = user.publicKey;
            tx.sign(user);
            const res = m.svm.sendTransaction(tx);
            expect(res instanceof FailedTransactionMetadata).toBe(true);
        }
    });

    test("rejects placing an order when platform user state was never funded", () => {
        const m = setupTradableMarket(0, 301n);
        const { user, tokenAccount } = require("./helpers").createFundedUser(m.svm, m.collateralMint, m.payer, 500_000_000n);
        const [platformUserState] = require("./helpers").platformUserStatePda(user.publicKey);
        const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);
        const ix = buildPlaceOrderIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
            orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            outcome: Outcome.A, side: Side.Buy, orderType: OrderType.Limit,
            price: 50, quantity: 1000n, orderId: 1n, bumpMarketUser: bump,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});

describe("place_order: limit — resting orders", () => {
    test("a lone limit buy rests on the book and locks collateral", () => {
        const m = setupTradableMarket(0, 302n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);

        const marketUserState = placeLimit(m, user, platformUserState, Outcome.A, Side.Buy, 50, 1_000_000n, 1n);

        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const level = readPriceLevel(bookA, Side.Buy, 50);
        expect(level.head).not.toBe(0);
        const node = readNode(bookA, m.tier, level.head);
        expect(node.quantity).toBe(1_000_000n);
        expect(node.orderId).toBe(1n);

        const seat = readSeat(bookA, m.tier, node.userSeatIdx);
        expect(seat.marketUserState.equals(marketUserState)).toBe(true);
        expect(seat.collateralLocked).toBe((1_000_000n * 50n) / 100n);

        const pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(200_000_000n - (1_000_000n * 50n) / 100n);
    });

    test("second resting order from the same user reuses their existing seat (does not allocate a new one)", () => {
        const m = setupTradableMarket(0, 303n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);

        placeLimit(m, user, platformUserState, Outcome.A, Side.Buy, 40, 500_000n, 1n);
        placeLimit(m, user, platformUserState, Outcome.A, Side.Buy, 41, 500_000n, 2n);

        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const level40 = readPriceLevel(bookA, Side.Buy, 40);
        const level41 = readPriceLevel(bookA, Side.Buy, 41);
        const node40 = readNode(bookA, m.tier, level40.head);
        const node41 = readNode(bookA, m.tier, level41.head);
        expect(node40.userSeatIdx).toBe(node41.userSeatIdx);

        const header = require("./helpers").readHeader(bookA);
        expect(header.totalAllocatedSeats).toBe(1);
    });
});

describe("place_order: limit — complementary cross-book matching", () => {
    test("a resting Buy-B order gets matched by a taker Buy-A order when prices sum to >= 100", () => {
        const m = setupTradableMarket(0, 304n);
        const maker = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const taker = depositForNewUser(m, 500_000_000n, 200_000_000n);

        // Maker rests a Buy order on outcome B at price 45 (implicitly offering to sell A at 55)
        const makerMarketUserState = placeLimit(m, maker.user, maker.platformUserState, Outcome.B, Side.Buy, 45, 1_000_000n, 10n);

        // Taker buys outcome A at price 55: 55 + 45 = 100 -> should cross fully
        placeLimit(m, taker.user, taker.platformUserState, Outcome.A, Side.Buy, 55, 1_000_000n, 11n, [makerMarketUserState]);

        const takerMus = readMarketUserState(Buffer.from(m.svm.getAccount(marketUserStatePda(m.marketPda, taker.user.publicKey)[0])!.data));
        expect(takerMus.otABalance).toBe(1_000_000n);

        const makerMus = readMarketUserState(Buffer.from(m.svm.getAccount(makerMarketUserState)!.data));
        expect(makerMus.otBBalance).toBe(1_000_000n);

        // Taker paid ~55% of notional + fee; maker's resting order should be fully consumed (bid gone)
        const bookB = Buffer.from(m.svm.getAccount(m.orderbookB.publicKey)!.data);
        const levelB45 = readPriceLevel(bookB, Side.Buy, 45);
        expect(levelB45.head).toBe(0);

        console.log("✅ Verified: complementary cross-book matching (Buy A + resting Buy B, prices summing to 100) mints both outcome legs correctly.");
    });

    test("BUG: a resting Sell order can never be instantly matched by a limit order — it always just rests", () => {
        // limit.rs only ever attempts crossing when args.side == 0 (Buy), and even then only
        // against the *complementary* book's Buy-side directory (comp_price in 1..=99, which
        // only ever indexes rows 0..99 i.e. Buy rows). A resting Sell (side=1, directory rows
        // 100..199) is never read by the crossing loop, and a taker Sell (side=1) skips the
        // crossing loop entirely (`if args.side == 0 && ...`). So two limit orders that should
        // obviously cross — a resting Sell A @ 40 and an incoming Buy A @ 50 — never match via
        // place_order's limit path; both simply end up resting.
        const m = setupTradableMarket(0, 305n);
        const seller = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const buyer = depositForNewUser(m, 500_000_000n, 200_000_000n);

        // seller needs outcome-A tokens to sell; mint some via split
        const sellerMarketUserState = marketUserStatePda(m.marketPda, seller.user.publicKey)[0];
        const splitIx = buildPlaceOrderIx({
            user: seller.user.publicKey, marketPda: m.marketPda, platformUserState: seller.platformUserState,
            marketUserState: sellerMarketUserState, orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            outcome: Outcome.A, side: Side.Buy, orderType: OrderType.Split, price: 0, quantity: 1_000_000n, orderId: 0n,
            bumpMarketUser: marketUserStatePda(m.marketPda, seller.user.publicKey)[1],
        });
        const splitTx = new Transaction().add(splitIx);
        splitTx.recentBlockhash = m.svm.latestBlockhash();
        splitTx.feePayer = seller.user.publicKey;
        splitTx.sign(seller.user);
        sendOk(m.svm, splitTx, "split to mint outcome A/B for seller");

        // seller rests a Sell A @ 40
        placeLimit(m, seller.user, seller.platformUserState, Outcome.A, Side.Sell, 40, 1_000_000n, 20n);
        // buyer places a Buy A @ 50 (a normal exchange would cross these instantly: buyer pays <= their limit, seller receives >= their limit)
        placeLimit(m, buyer.user, buyer.platformUserState, Outcome.A, Side.Buy, 50, 1_000_000n, 21n);

        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const sellLevel40 = readPriceLevel(bookA, Side.Sell, 40);
        const buyLevel50 = readPriceLevel(bookA, Side.Buy, 50);

        // Both orders are still fully resting, unmatched -- confirms the gap.
        expect(sellLevel40.head).not.toBe(0);
        expect(buyLevel50.head).not.toBe(0);
        console.log("⚠️  CONFIRMED BUG: resting Sell A@40 and incoming Buy A@50 did not cross via limit orders; both simply rest.");
    });
});
