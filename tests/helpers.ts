// Shared test helpers for the Alley prediction-market program.
// Layout constants below are derived directly from src/state.rs field-by-field
// (repr(C) alignment for *State structs, repr(C, packed) for orderbook structs) —
// not copied from the older, now out-of-sync client/alley.test.ts.

import {
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from "@solana/web3.js";
import {
    createAssociatedTokenAccountInstruction,
    createInitializeMintInstruction,
    createMintToInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { expect } from "bun:test";

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const PROGRAM_ID = new PublicKey("AQMAYn7oYNotsMTUzhQsTNoj1TbwNmbudKjFg3Rhx9pt");
export const TXLINE_PROGRAM_ID = new PublicKey(Buffer.from([
    0x56, 0x5c, 0x64, 0x1d, 0x93, 0x76, 0x82, 0xd8, 0x92, 0x4f, 0x6b, 0xec, 0x7f, 0x18, 0xda, 0x3d,
    0x42, 0x13, 0xaa, 0xd5, 0x76, 0x1b, 0x81, 0x98, 0x6e, 0x34, 0x7a, 0x22, 0xbc, 0x15, 0xee, 0x1a,
]));

// ---------- Orderbook binary layout (repr(C, packed) in state.rs) ----------
export const ORDERBOOK_HEADER_SIZE = 44; // Address(32) + u32 + u32 + u8 + [u8;3]
export const PRICE_LEVEL_SIZE = 8; // u32 head + u32 tail
export const DIRECTORY_ENTRIES = 200; // 100 buy + 100 sell price levels
export const DIRECTORY_SIZE = PRICE_LEVEL_SIZE * DIRECTORY_ENTRIES; // 1600
export const TRADER_SEAT_SIZE = 56; // Address(32) + u64*3
export const ORDER_NODE_SIZE = 24; // u32 + u64 + u32 + u64  (packed, NOT 32 as the stale client test assumed)

export const TIER_SEATS = [128, 1024, 4096];
export const TIER_ORDERS = [512, 4096, 16384];

export function calculateOrderbookSpace(tier: number): number {
    const seats = TIER_SEATS[tier];
    const orders = TIER_ORDERS[tier];
    if (seats === undefined || orders === undefined) throw new Error(`bad tier ${tier}`);
    return ORDERBOOK_HEADER_SIZE + DIRECTORY_SIZE + TRADER_SEAT_SIZE * seats + ORDER_NODE_SIZE * orders;
}

export function seatsOffset(): number {
    return ORDERBOOK_HEADER_SIZE + DIRECTORY_SIZE;
}
export function ordersOffset(tier: number): number {
    const seats = TIER_SEATS[tier]!;
    return seatsOffset() + TRADER_SEAT_SIZE * seats;
}

export function readHeader(buf: Buffer) {
    return {
        marketStatePda: new PublicKey(buf.subarray(0, 32)),
        totalAllocatedSeats: buf.readUInt32LE(32),
        nextFreeNodeIdx: buf.readUInt32LE(36),
        outcomeIndex: buf.readUInt8(40),
    };
}

export function directoryIndex(side: number, price: number): number {
    return side * 100 + price;
}
export function readPriceLevel(buf: Buffer, side: number, price: number) {
    const off = ORDERBOOK_HEADER_SIZE + directoryIndex(side, price) * PRICE_LEVEL_SIZE;
    return { head: buf.readUInt32LE(off), tail: buf.readUInt32LE(off + 4) };
}
export function readSeat(buf: Buffer, tier: number, idx: number) {
    const off = seatsOffset() + idx * TRADER_SEAT_SIZE;
    return {
        marketUserState: new PublicKey(buf.subarray(off, off + 32)),
        collateralLocked: buf.readBigUInt64LE(off + 32),
        otALocked: buf.readBigUInt64LE(off + 40),
        otBLocked: buf.readBigUInt64LE(off + 48),
    };
}
export function readNode(buf: Buffer, tier: number, idx: number) {
    const off = ordersOffset(tier) + idx * ORDER_NODE_SIZE;
    return {
        userSeatIdx: buf.readUInt32LE(off),
        quantity: buf.readBigUInt64LE(off + 4),
        nextIdx: buf.readUInt32LE(off + 12),
        orderId: buf.readBigUInt64LE(off + 16),
    };
}

// ---------- MarketState (repr(C), NOT packed) — offsets verified against LEN=296 ----------
export const MarketStateOffsets = {
    creator: 0,
    oracleAuthority: 32,
    marketId: 64,
    settlementDeadline: 72,
    collateralVault: 80,
    outcomeAMint: 112,
    outcomeBMint: 144,
    collateralMint: 176,
    orderbookA: 208,
    orderbookB: 240,
    accumulatedPlatformFees: 272,
    accumulatedCreatorFees: 280,
    feeRateBps: 288,
    tier: 290,
    isSettled: 291,
    winningOutcome: 292,
    marketStatus: 293,
    bump: 294,
};
export const MARKET_STATE_LEN = 296;

export function readMarketState(buf: Buffer) {
    const o = MarketStateOffsets;
    return {
        creator: new PublicKey(buf.subarray(o.creator, o.creator + 32)),
        oracleAuthority: new PublicKey(buf.subarray(o.oracleAuthority, o.oracleAuthority + 32)),
        marketId: buf.readBigUInt64LE(o.marketId),
        settlementDeadline: buf.readBigInt64LE(o.settlementDeadline),
        collateralVault: new PublicKey(buf.subarray(o.collateralVault, o.collateralVault + 32)),
        outcomeAMint: new PublicKey(buf.subarray(o.outcomeAMint, o.outcomeAMint + 32)),
        outcomeBMint: new PublicKey(buf.subarray(o.outcomeBMint, o.outcomeBMint + 32)),
        collateralMint: new PublicKey(buf.subarray(o.collateralMint, o.collateralMint + 32)),
        orderbookA: new PublicKey(buf.subarray(o.orderbookA, o.orderbookA + 32)),
        orderbookB: new PublicKey(buf.subarray(o.orderbookB, o.orderbookB + 32)),
        accumulatedPlatformFees: buf.readBigUInt64LE(o.accumulatedPlatformFees),
        accumulatedCreatorFees: buf.readBigUInt64LE(o.accumulatedCreatorFees),
        feeRateBps: buf.readUInt16LE(o.feeRateBps),
        tier: buf.readUInt8(o.tier),
        isSettled: buf.readUInt8(o.isSettled),
        winningOutcome: buf.readUInt8(o.winningOutcome),
        marketStatus: buf.readUInt8(o.marketStatus),
        bump: buf.readUInt8(o.bump),
    };
}

// ---------- PlatformUserState ----------
export const PlatformUserStateOffsets = { wallet: 0, collateralAvailable: 32, bump: 40 };
export const PLATFORM_USER_STATE_LEN = 41;
export function readPlatformUserState(buf: Buffer) {
    return {
        wallet: new PublicKey(buf.subarray(0, 32)),
        collateralAvailable: buf.readBigUInt64LE(32),
        bump: buf.readUInt8(40),
    };
}

// ---------- MarketUserState ----------
export const MarketUserStateOffsets = {
    wallet: 0,
    marketPda: 32,
    platformUserState: 64,
    otABalance: 96,
    otBBalance: 104,
    collateralClaimable: 112,
    bump: 120,
};
export const MARKET_USER_STATE_LEN = 128;
export function readMarketUserState(buf: Buffer) {
    const o = MarketUserStateOffsets;
    return {
        wallet: new PublicKey(buf.subarray(o.wallet, o.wallet + 32)),
        marketPda: new PublicKey(buf.subarray(o.marketPda, o.marketPda + 32)),
        platformUserState: new PublicKey(buf.subarray(o.platformUserState, o.platformUserState + 32)),
        otABalance: buf.readBigUInt64LE(o.otABalance),
        otBBalance: buf.readBigUInt64LE(o.otBBalance),
        collateralClaimable: buf.readBigUInt64LE(o.collateralClaimable),
        bump: buf.readUInt8(o.bump),
    };
}

// ---------- Discriminators ----------
export const IX = {
    CreateMarket: 0,
    InitializeOrderbooks: 1,
    DepositCollateral: 2,
    PlaceOrder: 3,
    CancelOrder: 4,
    ClaimFunds: 5,
    ResolveMarket: 6,
    ClaimWinnings: 7,
    EmergencyRefund: 8,
    Ping: 9,
};

export const OrderType = { Limit: 0, Market: 1, Split: 2, Merge: 3, MarketFOK: 4 };
export const Side = { Buy: 0, Sell: 1 };
export const Outcome = { A: 0, B: 1 };

// ---------- Test harness setup ----------
export interface TestCtx {
    svm: LiteSVM;
    payer: Keypair;
    collateralMint: PublicKey;
}

export function freshSvm(): LiteSVM {
    const svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM_ID, "../target/deploy/alley.so");
    return svm;
}

export function sendOk(svm: LiteSVM, tx: Transaction, label: string) {
    const res = svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) {
        console.error(`\n=== ${label} FAILED ===`);
        console.error(res.err().toString());
        console.error(res.meta()?.prettyLogs());
        console.error("=======================\n");
    }
    expect(res instanceof FailedTransactionMetadata).toBe(false);
    return res;
}

export function sendExpectErr(svm: LiteSVM, tx: Transaction, label: string): FailedTransactionMetadata {
    const res = svm.sendTransaction(tx);
    if (!(res instanceof FailedTransactionMetadata)) {
        throw new Error(`${label}: expected failure but transaction succeeded`);
    }
    return res;
}

// IMPORTANT: deposit_collateral.rs hardcodes `pinocchio_token::instructions::Transfer`,
// i.e. it *always* CPIs into the legacy Tokenkeg program regardless of whichever
// `token_program` account is actually passed to the instruction (that account is
// accepted but ignored — see finding in 02_orderbooks_and_deposit.test.ts). So the
// collateral mint must be a legacy SPL-Token mint for deposits to work at all — this
// matches how the user set up their local USDC spoof by hand (`spl-token create-token`
// defaults to the legacy Tokenkeg program). Only the outcome (A/B) mints use Token-2022.
export function setupPayerAndMint(svm: LiteSVM): { payer: Keypair; collateralMint: PublicKey } {
    const payer = Keypair.generate();
    svm.airdrop(payer.publicKey, 1_000_000_000_000n);

    const collateralMintKp = Keypair.generate();
    const rentMint = svm.minimumBalanceForRentExemption(82n);
    const tx = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: collateralMintKp.publicKey,
            lamports: Number(rentMint),
            space: 82,
            programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(collateralMintKp.publicKey, 6, payer.publicKey, payer.publicKey, TOKEN_PROGRAM_ID)
    );
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    tx.sign(payer, collateralMintKp);
    sendOk(svm, tx, "create collateral mint");

    return { payer, collateralMint: collateralMintKp.publicKey };
}

export function marketPdas(marketId: bigint) {
    const marketIdBuf = Buffer.alloc(8);
    marketIdBuf.writeBigUInt64LE(marketId);
    const [marketPda, marketBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), marketIdBuf],
        PROGRAM_ID
    );
    const [outcomeAMint, bumpOtA] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([0])],
        PROGRAM_ID
    );
    const [outcomeBMint, bumpOtB] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint"), marketPda.toBuffer(), Buffer.from([1])],
        PROGRAM_ID
    );
    return { marketPda, marketBump, outcomeAMint, bumpOtA, outcomeBMint, bumpOtB, marketIdBuf };
}

// Derived with the LEGACY token program, matching the collateral mint's real owner
// (see setupPayerAndMint comment). NOTE: alley-web's app/create/page.tsx currently
// derives this same address using TOKEN_PROGRAM_2022_ID instead — see the dedicated
// regression test in 02_orderbooks_and_deposit.test.ts that proves that derivation
// can never correspond to a valid token account for a legacy-program mint.
export function collateralVaultAta(marketPda: PublicKey, collateralMint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
    const [vault] = PublicKey.findProgramAddressSync(
        [marketPda.toBuffer(), tokenProgram.toBuffer(), collateralMint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return vault;
}

export function buildCreateMarketIx(params: {
    payer: PublicKey;
    marketPda: PublicKey;
    collateralVault: PublicKey;
    outcomeAMint: PublicKey;
    outcomeBMint: PublicKey;
    collateralMint: PublicKey;
    marketId: bigint;
    settlementDeadline: bigint;
    marketRent: bigint;
    mintRent: bigint;
    bumpOtA: number;
    bumpOtB: number;
    tier: number;
    oracleAuthority?: PublicKey; // defaults to `payer` if omitted
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 48);
    data.writeUInt8(IX.CreateMarket, 0);
    data.writeBigUInt64LE(params.marketId, 1);
    data.writeBigInt64LE(params.settlementDeadline, 9);
    data.writeBigUInt64LE(params.marketRent, 17);
    data.writeBigUInt64LE(params.mintRent, 25);
    data.writeUInt8(params.bumpOtA, 33);
    data.writeUInt8(params.bumpOtB, 34);
    data.writeUInt8(params.tier, 35);
    data.writeUInt8(0, 36); // has_custom_meta
    // name/symbol/uri lens all zero, no trailing strings

    const keys = [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: true },
        { pubkey: params.collateralVault, isSigner: false, isWritable: true },
        { pubkey: params.outcomeAMint, isSigner: false, isWritable: true },
        { pubkey: params.outcomeBMint, isSigner: false, isWritable: true },
        { pubkey: params.collateralMint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // collateral_token_program (legacy) — now required for the on-chain vault-ATA creation CPI
        { pubkey: params.oracleAuthority ?? params.payer, isSigner: false, isWritable: false }, // oracle_authority_acc — recorded as this market's trusted keeper pubkey
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildInitOrderbooksIx(params: {
    payer: PublicKey;
    marketPda: PublicKey;
    orderbookA: PublicKey;
    orderbookB: PublicKey;
}): TransactionInstruction {
    const data = Buffer.from([IX.InitializeOrderbooks]);
    const keys = [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: true },
        { pubkey: params.orderbookA, isSigner: false, isWritable: true },
        { pubkey: params.orderbookB, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildDepositIx(params: {
    user: PublicKey;
    platformUserState: PublicKey;
    userTokenAccount: PublicKey;
    collateralVault: PublicKey;
    amount: bigint;
    bumpUserState: number;
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 9);
    data.writeUInt8(IX.DepositCollateral, 0);
    data.writeBigUInt64LE(params.amount, 1);
    data.writeUInt8(params.bumpUserState, 9);
    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.collateralVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // accepted but ignored on-chain
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildPlaceOrderIx(params: {
    user: PublicKey;
    marketPda: PublicKey;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    orderbookA: PublicKey;
    orderbookB: PublicKey; // for market orders, pass the single relevant orderbook here and set singleBook=true
    singleBook?: boolean;
    outcome: number;
    side: number;
    orderType: number;
    price: number;
    quantity: bigint;
    orderId: bigint;
    bumpMarketUser: number;
    remainingAccounts?: PublicKey[]; // MarketUserState PDAs indexed by seat_idx, aligned starting at base index
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 21);
    data.writeUInt8(IX.PlaceOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(params.orderType, 3);
    data.writeUInt8(params.price, 4);
    data.writeBigUInt64LE(params.quantity, 5);
    data.writeBigUInt64LE(params.orderId, 13);
    data.writeUInt8(params.bumpMarketUser, 21);

    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: true },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.marketUserState, isSigner: false, isWritable: true },
        { pubkey: params.orderbookA, isSigner: false, isWritable: true },
    ];
    if (!params.singleBook) {
        keys.push({ pubkey: params.orderbookB, isSigner: false, isWritable: true });
    }
    // NOTE: place_order has no system_program account slot at all — pinocchio_system's
    // CreateAccount CPI hardcodes the System Program address internally. Maker accounts
    // must start immediately after the fixed prefix (index 6 for limit orders / index 5
    // for single-book market orders), matching limit.rs's/market.rs's `accounts.get_mut(N + seat_idx)`.
    for (const acc of params.remainingAccounts ?? []) {
        keys.push({ pubkey: acc, isSigner: false, isWritable: true });
    }
    // The System Program account is never named as a fixed field in mod.rs, but it must
    // still be present *somewhere* in the instruction's account list: pinocchio's CPI
    // (used for the on-demand `CreateAccount` of a first-time MarketUserState) requires
    // the callee program to be one of the accounts already provided to the invoking
    // instruction, or the runtime rejects the CPI outright. Appending it after the real
    // maker accounts keeps the `6 + seat_idx` (limit) / `5 + seat_idx` (market) addressing
    // scheme intact for maker lookups.
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
    // process_place_order (mod.rs) also gates on `accounts.len() < 7` for EVERY order
    // type, before even branching on order_type — so even a Split/Merge with no maker
    // accounts, or a single-book Market order (5 fixed accounts), must still pad the
    // account list out to 7 entries or the whole instruction is rejected with
    // NotEnoughAccountKeys.
    while (keys.length < 7) {
        keys.push({ pubkey: params.marketPda, isSigner: false, isWritable: false });
    }
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildCancelOrderIx(params: {
    user: PublicKey;
    marketPda: PublicKey;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    orderbook: PublicKey;
    outcome: number;
    side: number;
    price: number;
    orderNodeIdx: number;
    orderId: bigint;
}): TransactionInstruction {
    const data = Buffer.alloc(1 + 15);
    data.writeUInt8(IX.CancelOrder, 0);
    data.writeUInt8(params.outcome, 1);
    data.writeUInt8(params.side, 2);
    data.writeUInt8(params.price, 3);
    data.writeUInt32LE(params.orderNodeIdx, 4);
    data.writeBigUInt64LE(params.orderId, 8);
    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: true },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.marketUserState, isSigner: false, isWritable: true },
        { pubkey: params.orderbook, isSigner: false, isWritable: true },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildClaimFundsIx(params: {
    user: PublicKey;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
}): TransactionInstruction {
    const data = Buffer.from([IX.ClaimFunds]);
    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.marketUserState, isSigner: false, isWritable: true },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildResolveMarketIx(params: {
    keeper: PublicKey;
    marketPda: PublicKey;
    winningOutcome: number;
}): TransactionInstruction {
    const data = Buffer.from([IX.ResolveMarket, params.winningOutcome]);
    const keys = [
        { pubkey: params.keeper, isSigner: true, isWritable: false },
        { pubkey: params.marketPda, isSigner: false, isWritable: true },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildClaimWinningsIx(params: {
    user: PublicKey;
    marketPda: PublicKey;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    winningMint: PublicKey;
    userTokenAccount: PublicKey;
}): TransactionInstruction {
    const data = Buffer.from([IX.ClaimWinnings]);
    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: false },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.marketUserState, isSigner: false, isWritable: true },
        { pubkey: params.winningMint, isSigner: false, isWritable: true },
        { pubkey: params.userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

export function buildEmergencyRefundIx(params: {
    user: PublicKey;
    marketPda: PublicKey;
    platformUserState: PublicKey;
    marketUserState: PublicKey;
    outcomeAMint: PublicKey;
    outcomeBMint: PublicKey;
    userAtaA: PublicKey;
    userAtaB: PublicKey;
}): TransactionInstruction {
    const data = Buffer.from([IX.EmergencyRefund]);
    const SYSVAR_CLOCK_PUBKEY = new PublicKey("SysvarC1ock11111111111111111111111111111111");
    const keys = [
        { pubkey: params.user, isSigner: true, isWritable: true },
        { pubkey: params.marketPda, isSigner: false, isWritable: false },
        { pubkey: params.platformUserState, isSigner: false, isWritable: true },
        { pubkey: params.marketUserState, isSigner: false, isWritable: true },
        { pubkey: params.outcomeAMint, isSigner: false, isWritable: true },
        { pubkey: params.outcomeBMint, isSigner: false, isWritable: true },
        { pubkey: params.userAtaA, isSigner: false, isWritable: true },
        { pubkey: params.userAtaB, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ keys, programId: PROGRAM_ID, data });
}

// ---------- Higher-level flow helpers ----------
export function createFundedUser(
    svm: LiteSVM,
    collateralMint: PublicKey,
    mintAuthority: Keypair,
    fundAmount: bigint
): { user: Keypair; tokenAccount: PublicKey } {
    const user = Keypair.generate();
    svm.airdrop(user.publicKey, 5_000_000_000n);
    const tokenAccount = getAssociatedTokenAddressSync(collateralMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(user.publicKey, tokenAccount, user.publicKey, collateralMint, TOKEN_PROGRAM_ID),
        createMintToInstruction(collateralMint, tokenAccount, mintAuthority.publicKey, fundAmount, [], TOKEN_PROGRAM_ID)
    );
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = user.publicKey;
    tx.sign(user, mintAuthority);
    sendOk(svm, tx, "fund user");
    return { user, tokenAccount };
}

export function deposit(svm: LiteSVM, user: Keypair, collateralMint: PublicKey, collateralVault: PublicKey, userTokenAccount: PublicKey, amount: bigint) {
    const [platformUserState, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_state"), user.publicKey.toBuffer()],
        PROGRAM_ID
    );
    const alreadyExists = svm.getAccount(platformUserState) !== null;
    const ix = buildDepositIx({
        user: user.publicKey,
        platformUserState,
        userTokenAccount,
        collateralVault,
        amount,
        bumpUserState: bump,
    });
    const tx = new Transaction().add(ix);
    if (!alreadyExists) {
        tx.add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: platformUserState, lamports: 3_000_000 }));
    }
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = user.publicKey;
    tx.sign(user);
    sendOk(svm, tx, "deposit collateral");
    return platformUserState;
}

export function marketUserStatePda(marketPda: PublicKey, user: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("market_user"), marketPda.toBuffer(), user.toBuffer()],
        PROGRAM_ID
    );
}

export function platformUserStatePda(user: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("user_state"), user.toBuffer()], PROGRAM_ID);
}

export function advanceClockBy(svm: LiteSVM, seconds: bigint) {
    const clock = svm.getClock();
    const newClock = new Clock(
        clock.slot + 1n,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + seconds
    );
    svm.setClock(newClock);
}

// ---------- Full market bootstrap (create_market + orderbooks) ----------
export interface TradableMarket {
    svm: LiteSVM;
    payer: Keypair;
    collateralMint: PublicKey;
    marketPda: PublicKey;
    outcomeAMint: PublicKey;
    outcomeBMint: PublicKey;
    vault: PublicKey;
    orderbookA: Keypair;
    orderbookB: Keypair;
    tier: number;
    settlementDeadline: bigint;
    keeper: Keypair; // this market's oracle_authority — must sign resolve_market
}

export function setupTradableMarket(tier: number, marketId: bigint, settlementDeadlineSecondsFromNow = 86400): TradableMarket {
    const svm = freshSvm();
    const { payer, collateralMint } = setupPayerAndMint(svm);
    const { marketPda, outcomeAMint, outcomeBMint, bumpOtA, bumpOtB } = marketPdas(marketId);
    const vault = collateralVaultAta(marketPda, collateralMint);
    const keeper = Keypair.generate();
    // litesvm's simulated clock starts at unix time 0, not real wall-clock time — anchor
    // the deadline to the VM's own clock, not Date.now(), or later advanceClockBy() calls
    // can never catch up to a deadline computed from real time.
    const settlementDeadline = svm.getClock().unixTimestamp + BigInt(settlementDeadlineSecondsFromNow);

    const createTx = new Transaction().add(
        buildCreateMarketIx({
            payer: payer.publicKey,
            marketPda,
            collateralVault: vault,
            outcomeAMint,
            outcomeBMint,
            collateralMint,
            marketId,
            settlementDeadline,
            marketRent: svm.minimumBalanceForRentExemption(296n),
            mintRent: svm.minimumBalanceForRentExemption(82n),
            bumpOtA,
            bumpOtB,
            tier,
            oracleAuthority: keeper.publicKey,
        })
    );
    createTx.recentBlockhash = svm.latestBlockhash();
    createTx.feePayer = payer.publicKey;
    createTx.sign(payer);
    sendOk(svm, createTx, "create_market"); // now also creates the collateral vault ATA on-chain

    const orderbookA = Keypair.generate();
    const orderbookB = Keypair.generate();
    const requiredSpace = calculateOrderbookSpace(tier);
    const rent = svm.minimumBalanceForRentExemption(BigInt(requiredSpace));
    const obTx = new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: orderbookA.publicKey, lamports: Number(rent), space: requiredSpace, programId: PROGRAM_ID }),
        SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: orderbookB.publicKey, lamports: Number(rent), space: requiredSpace, programId: PROGRAM_ID }),
        buildInitOrderbooksIx({ payer: payer.publicKey, marketPda, orderbookA: orderbookA.publicKey, orderbookB: orderbookB.publicKey })
    );
    obTx.recentBlockhash = svm.latestBlockhash();
    obTx.feePayer = payer.publicKey;
    obTx.sign(payer, orderbookA, orderbookB);
    sendOk(svm, obTx, "initialize_orderbooks");

    return { svm, payer, collateralMint, marketPda, outcomeAMint, outcomeBMint, vault, orderbookA, orderbookB, tier, settlementDeadline, keeper };
}

export function depositForNewUser(m: TradableMarket, fundAmount: bigint, depositAmount: bigint) {
    const { user, tokenAccount } = createFundedUser(m.svm, m.collateralMint, m.payer, fundAmount);
    const platformUserState = deposit(m.svm, user, m.collateralMint, m.vault, tokenAccount, depositAmount);
    return { user, tokenAccount, platformUserState };
}
