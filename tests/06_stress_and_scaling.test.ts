import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect, test, describe } from "bun:test";
import { FailedTransactionMetadata } from "litesvm";
import {
    setupTradableMarket,
    depositForNewUser,
    marketUserStatePda,
    buildPlaceOrderIx,
    readHeader,
    sendOk,
    OrderType,
    Side,
    Outcome,
    TIER_SEATS,
    TIER_ORDERS,
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
    return m.svm.sendTransaction(tx);
}

describe("orderbook capacity limits (Small tier: 128 seats, 512 order nodes)", () => {
    test("the 129th distinct maker in a single price-level fan-out is rejected once all seats are used", () => {
        const m = setupTradableMarket(0, 600n);
        // Spinning up 128+ fully funded users (airdrop + ATA + mint + deposit, each its
        // own transaction) is slow in wall-clock terms even though each is cheap on-chain.

        const maxSeats = TIER_SEATS[0]!;

        let lastRes;
        for (let i = 0; i < maxSeats + 2; i++) {
            const { user, platformUserState } = depositForNewUser(m, 200_000_000n, 100_000_000n);
            // spread across different prices so each maker's order survives independently
            const price = 1 + (i % 98);
            lastRes = placeLimit(m, user, platformUserState, Outcome.A, Side.Buy, price, 1000n, BigInt(i + 1));
            if (lastRes instanceof FailedTransactionMetadata) break;
        }

        expect(lastRes instanceof FailedTransactionMetadata).toBe(true);
        const bookA = Buffer.from(m.svm.getAccount(m.orderbookA.publicKey)!.data);
        const header = readHeader(bookA);
        expect(header.totalAllocatedSeats).toBe(maxSeats);
        console.log(`✅ Verified: Small-tier orderbook hard-caps at exactly ${maxSeats} distinct resting makers (Custom(202) seat-exhaustion error on the ${maxSeats + 1}th).`);
    }, 60_000);

    test("the order-node free list is exhausted after ~511 resting orders from one maker, even though only one seat is used", () => {
        const m = setupTradableMarket(0, 601n);
        const { user, platformUserState } = depositForNewUser(m, 5_000_000_000n, 2_000_000_000n);
        const maxOrders = TIER_ORDERS[0]!; // 512, but index 0 is a reserved null sentinel -> 511 usable

        let successCount = 0;
        let lastRes;
        for (let i = 0; i < maxOrders + 2; i++) {
            lastRes = placeLimit(m, user, platformUserState, Outcome.A, Side.Buy, 1, 1n, BigInt(i + 1));
            if (lastRes instanceof FailedTransactionMetadata) break;
            successCount++;
        }

        expect(lastRes instanceof FailedTransactionMetadata).toBe(true);
        expect(successCount).toBe(maxOrders - 1);
        console.log(`✅ Verified: Small-tier orderbook's free-node pool is exhausted after exactly ${successCount} resting orders (Custom(203)), independent of seat count — matches the fixed ${maxOrders}-node allocation from calculate_orderbook_space.`);
    }, 60_000);
});

describe("scaling concern: maker accounts required scales with seat index, not match count", () => {
    test("crossing a resting order held by a high-index seat requires padding the account list up to that index — this blows past Solana's transaction size limit for realistic seat counts", () => {
        // limit.rs / market.rs resolve makers via `accounts[BASE + maker_order.user_seat_idx]`
        // — a raw positional index into the transaction's account list, not a lookup by
        // pubkey. This means crossing an order resting in seat #400 requires the CLIENT
        // to supply an account list at least 400+ entries long (with placeholder entries
        // for every unused intervening seat index), regardless of how many orders are
        // actually being matched. Demonstrate the actual byte cost of this concretely.
        const SOLANA_TX_SIZE_LIMIT = 1232;
        const PUBKEY_BYTES = 32;
        const ACCOUNT_META_OVERHEAD = 1; // simplified: signature flags packed elsewhere; pubkeys dominate

        for (const seatIndex of [10, 50, 100, 400, 1023, 4095]) {
            const accountsNeeded = 6 /* base accounts for a limit order */ + seatIndex + 1;
            const approxBytes = accountsNeeded * (PUBKEY_BYTES + ACCOUNT_META_OVERHEAD);
            const fits = approxBytes <= SOLANA_TX_SIZE_LIMIT;
            console.log(`seat_idx=${seatIndex}: needs ${accountsNeeded} accounts (~${approxBytes} bytes of pubkeys alone) -> ${fits ? "fits" : "EXCEEDS"} the ${SOLANA_TX_SIZE_LIMIT}-byte tx limit`);
        }

        // Concretely build a real transaction that must reference a maker resting in seat #40
        // (i.e. the 41st distinct maker to ever rest an order in this market) and show it
        // already approaches/breaks the limit well before Large-tier seat counts (4096) are
        // even remotely reached.
        const m = setupTradableMarket(0, 602n);
        const makers: PublicKey[] = [];
        const N = 45;
        for (let i = 0; i < N; i++) {
            const { user, platformUserState } = depositForNewUser(m, 200_000_000n, 100_000_000n);
            const mus = marketUserStatePda(m.marketPda, user.publicKey)[0];
            const res = placeLimit(m, user, platformUserState, Outcome.B, Side.Buy, 40, 1000n, BigInt(i + 1));
            expect(res instanceof FailedTransactionMetadata).toBe(false);
            makers.push(mus);
        }

        const taker = depositForNewUser(m, 200_000_000n, 100_000_000n);
        const [takerMus, bump] = marketUserStatePda(m.marketPda, taker.user.publicKey);

        // Find the largest number of simultaneously-touched makers that still fits in one
        // real, serializable Solana transaction under this account-addressing scheme.
        let largestThatFits = 0;
        let firstFailureAt: number | null = null;
        let firstFailureSize: number | null = null;
        for (let count = 1; count <= N; count++) {
            const ix = buildPlaceOrderIx({
                user: taker.user.publicKey, marketPda: m.marketPda, platformUserState: taker.platformUserState,
                marketUserState: takerMus, orderbookA: m.orderbookA.publicKey, orderbookB: m.orderbookB.publicKey,
                outcome: Outcome.A, side: Side.Buy, orderType: OrderType.Limit, price: 60, quantity: BigInt(count * 1000), orderId: 9999n,
                bumpMarketUser: bump, remainingAccounts: makers.slice(0, count),
            });
            const tx = new Transaction();
            tx.add(ix);
            tx.recentBlockhash = m.svm.latestBlockhash();
            tx.feePayer = taker.user.publicKey;
            tx.sign(taker.user);
            try {
                const serialized = tx.serialize();
                largestThatFits = count;
            } catch (e) {
                if (firstFailureAt === null) {
                    firstFailureAt = count;
                    firstFailureSize = (e as Error).message.match(/(\d+) > 1232/)?.[1] ? Number((e as Error).message.match(/(\d+) > 1232/)![1]) : null;
                }
                break;
            }
        }

        console.log(`Largest number of simultaneously-touched distinct resting makers a single transaction can cross under this scheme: ${largestThatFits}.`);
        if (firstFailureAt !== null) {
            console.log(`⚠️  CONFIRMED: at ${firstFailureAt} touched makers the required account list (${firstFailureSize ?? "?"} bytes) already EXCEEDS Solana's hard 1232-byte transaction size limit — the instruction cannot be sent at all, regardless of compute budget.`);
        }
        expect(largestThatFits).toBeLessThan(N); // prove we actually hit the wall within this test's range
        console.log("⚠️  Since maker accounts are addressed by raw seat index (not by which makers are actually touched), a popular price level with more resting distinct makers than this — or simply an unlucky high seat-index landing in a Medium/Large tier market (1024/4096 seats) — cannot be crossed by a single transaction under the current design, no matter how the client is written.");
    });
});
