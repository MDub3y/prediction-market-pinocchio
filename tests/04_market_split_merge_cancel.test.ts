import { PublicKey, Transaction } from "@solana/web3.js";
import { expect, test, describe } from "bun:test";
import { FailedTransactionMetadata } from "litesvm";
import {
    setupTradableMarket,
    depositForNewUser,
    marketUserStatePda,
    buildPlaceOrderIx,
    buildCancelOrderIx,
    readMarketUserState,
    readPriceLevel,
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
        user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
        orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
        outcome, side, orderType: OrderType.Limit, price, quantity, orderId, bumpMarketUser: bump,
        remainingAccounts: remaining,
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = m.svm.latestBlockhash();
    tx.feePayer = user.publicKey;
    tx.sign(user);
    sendOk(m.svm, tx, `place limit (outcome=${outcome} side=${side} price=${price} qty=${quantity})`);
    return marketUserState;
}

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

describe("place_order: split / merge", () => {
    test("split converts collateral into equal OT-A/OT-B balances; merge reverses it", () => {
        const m = setupTradableMarket(0, 400n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);

        const mus = split(m, user, platformUserState, 50_000_000n);
        let musState = readMarketUserState(Buffer.from(m.svm.getAccount(mus)!.data));
        expect(musState.otABalance).toBe(50_000_000n);
        expect(musState.otBBalance).toBe(50_000_000n);
        let pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(150_000_000n);

        // merge
        const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);
        const mergeIx = buildPlaceOrderIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
            orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            outcome: 0, side: 0, orderType: OrderType.Merge, price: 0, quantity: 20_000_000n, orderId: 0n, bumpMarketUser: bump,
        });
        const tx = new Transaction().add(mergeIx);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        sendOk(m.svm, tx, "merge 20_000_000");

        musState = readMarketUserState(Buffer.from(m.svm.getAccount(mus)!.data));
        expect(musState.otABalance).toBe(30_000_000n);
        expect(musState.otBBalance).toBe(30_000_000n);
        pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(170_000_000n);
    });

    test("split fails when platform collateral is insufficient", () => {
        const m = setupTradableMarket(0, 401n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 1_000n);
        const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);
        const ix = buildPlaceOrderIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
            orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            outcome: 0, side: 0, orderType: OrderType.Split, price: 0, quantity: 999_999_999n, orderId: 0n, bumpMarketUser: bump,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });

    test("merge fails when the user doesn't hold enough of either outcome leg", () => {
        const m = setupTradableMarket(0, 402n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const mus = split(m, user, platformUserState, 10_000_000n);
        const [marketUserState, bump] = marketUserStatePda(m.marketPda, user.publicKey);
        const ix = buildPlaceOrderIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
            orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            outcome: 0, side: 0, orderType: OrderType.Merge, price: 0, quantity: 50_000_000n, orderId: 0n, bumpMarketUser: bump,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
    });
});

describe("place_order: market orders (single-book bid/ask matching)", () => {
    test("FAK market sell walks multiple resting bid levels and partially fills", () => {
        const m = setupTradableMarket(0, 410n);
        const buyer1 = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const buyer2 = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const seller = depositForNewUser(m, 500_000_000n, 200_000_000n);

        const buyer1Mus = placeLimit(m, buyer1.user, buyer1.platformUserState, Outcome.A, Side.Buy, 50, 1_000_000n, 1n);
        const buyer2Mus = placeLimit(m, buyer2.user, buyer2.platformUserState, Outcome.A, Side.Buy, 48, 2_000_000n, 2n);

        // seller needs OT-A tokens: split first
        split(m, seller.user, seller.platformUserState, 5_000_000n);

        const [sellerMus, bump] = marketUserStatePda(m.marketPda, seller.user.publicKey);
        // FAK market sell of 1.5M @ min price 48 -> should consume all of buyer1's 1M @50, then 0.5M of buyer2's 2M @48
        const ix = buildPlaceOrderIx({
            user: seller.user.publicKey, marketPda: m.marketPda, platformUserState: seller.platformUserState,
            marketUserState: sellerMus, orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            singleBook: true, outcome: Outcome.A, side: Side.Sell, orderType: OrderType.Market,
            price: 48, quantity: 1_500_000n, orderId: 3n, bumpMarketUser: bump,
            remainingAccounts: [buyer1Mus, buyer2Mus],
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = seller.user.publicKey;
        tx.sign(seller.user);
        sendOk(m.svm, tx, "FAK market sell walking two levels");

        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const level50 = readPriceLevel(bookA, Side.Buy, 50);
        expect(level50.head).toBe(0); // fully consumed

        const level48 = readPriceLevel(bookA, Side.Buy, 48);
        expect(level48.head).not.toBe(0);
        const node48 = readNode(bookA, m.tier, level48.head);
        expect(node48.quantity).toBe(1_500_000n); // 2M - 0.5M consumed

        const sellerMusState = readMarketUserState(Buffer.from(m.svm.getAccount(sellerMus)!.data));
        expect(sellerMusState.otABalance).toBe(3_500_000n); // 5M split - 1.5M sold
        console.log("✅ Verified: FAK market sell correctly walks multiple price levels and partial-fills the last one touched.");
    });

    test("FOK market order aborts entirely (no state change) when book depth can't fill it", () => {
        const m = setupTradableMarket(0, 411n);
        const buyer = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const seller = depositForNewUser(m, 500_000_000n, 200_000_000n);

        const buyerMus = placeLimit(m, buyer.user, buyer.platformUserState, Outcome.A, Side.Buy, 50, 1_000_000n, 1n);
        split(m, seller.user, seller.platformUserState, 10_000_000n);

        const [sellerMus, bump] = marketUserStatePda(m.marketPda, seller.user.publicKey);
        const ix = buildPlaceOrderIx({
            user: seller.user.publicKey, marketPda: m.marketPda, platformUserState: seller.platformUserState,
            marketUserState: sellerMus, orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
            singleBook: true, outcome: Outcome.A, side: Side.Sell, orderType: OrderType.MarketFOK,
            price: 50, quantity: 5_000_000n, orderId: 2n, bumpMarketUser: bump,
            remainingAccounts: [buyerMus],
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = seller.user.publicKey;
        tx.sign(seller.user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);

        // book untouched
        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const level50 = readPriceLevel(bookA, Side.Buy, 50);
        const node = readNode(bookA, m.tier, level50.head);
        expect(node.quantity).toBe(1_000_000n);
    });
});

describe("cancel_order", () => {
    test("owner can cancel a resting buy and gets collateral refunded", () => {
        const m = setupTradableMarket(0, 420n);
        const { user, platformUserState } = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const marketUserState = placeLimit(m, user, platformUserState, Outcome.A, Side.Buy, 50, 1_000_000n, 1n);

        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const level = readPriceLevel(bookA, Side.Buy, 50);
        const nodeIdx = level.head;

        const ix = buildCancelOrderIx({
            user: user.publicKey, marketPda: m.marketPda, platformUserState, marketUserState,
            orderbook: m.orderbookA.publicKey, outcome: Outcome.A, side: Side.Buy, price: 50,
            orderNodeIdx: nodeIdx, orderId: 1n,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = user.publicKey;
        tx.sign(user);
        sendOk(m.svm, tx, "cancel_order");

        const pState = readPlatformUserState(Buffer.from(m.svm.getAccount(platformUserState)!.data));
        expect(pState.collateralAvailable).toBe(200_000_000n); // fully refunded

        const bookAfter = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const levelAfter = readPriceLevel(bookAfter, Side.Buy, 50);
        expect(levelAfter.head).toBe(0);
    });

    test("a different user cannot cancel someone else's order", () => {
        const m = setupTradableMarket(0, 421n);
        const owner = depositForNewUser(m, 500_000_000n, 200_000_000n);
        const attacker = depositForNewUser(m, 500_000_000n, 200_000_000n);
        placeLimit(m, owner.user, owner.platformUserState, Outcome.A, Side.Buy, 50, 1_000_000n, 1n);

        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const level = readPriceLevel(bookA, Side.Buy, 50);
        const nodeIdx = level.head;

        const [attackerMarketUserState] = marketUserStatePda(m.marketPda, attacker.user.publicKey);
        // attacker has no market_user_state yet in this market — create one via a harmless split first
        split(m, attacker.user, attacker.platformUserState, 1_000n);

        const ix = buildCancelOrderIx({
            user: attacker.user.publicKey, marketPda: m.marketPda, platformUserState: attacker.platformUserState,
            marketUserState: attackerMarketUserState, orderbook: m.orderbookA.publicKey,
            outcome: Outcome.A, side: Side.Buy, price: 50, orderNodeIdx: nodeIdx, orderId: 1n,
        });
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = m.svm.latestBlockhash();
        tx.feePayer = attacker.user.publicKey;
        tx.sign(attacker.user);
        const res = m.svm.sendTransaction(tx);
        expect(res instanceof FailedTransactionMetadata).toBe(true);
        console.log("✅ Verified: cancel_order correctly rejects a non-owner cancel attempt.");
    });
});
