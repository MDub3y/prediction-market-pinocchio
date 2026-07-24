pub mod limit;
pub mod market;
pub mod merge;
pub mod split;

use crate::{
    errors::AlleyError,
    state::{MarketState, MarketUserState, PlaceOrderArgs, PlatformUserState},
};
use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

/// Resolves a maker's `MarketUserState` account by scanning the client-supplied
/// "remaining accounts" for a pubkey match against the seat's recorded
/// `market_user_state`, instead of indexing `remaining[seat_idx]` directly.
///
/// The old index-based scheme required the client to pad the account list with a
/// placeholder for every *intervening* seat index up to the highest one touched, even
/// if only a couple of makers were actually crossed — which made transactions blow
/// Solana's 1232-byte limit at roughly 25 touched makers, far short of what a
/// Medium/Large tier orderbook (1024/4096 seats) needs to be usable. Since
/// `TraderSeat::market_user_state` already carries the exact pubkey to look for, the
/// client only needs to supply accounts for makers actually being crossed, in any order,
/// and this scans for it. That trades an O(1) index for an O(k) scan over k supplied
/// accounts (bounded by what fits in a transaction / compute budget anyway).
pub(crate) fn find_maker_account<'a>(
    remaining: &'a mut [AccountView],
    target: &Address,
) -> Result<&'a mut AccountView, ProgramError> {
    remaining
        .iter_mut()
        .find(|acc| acc.address() == target)
        .ok_or(ProgramError::NotEnoughAccountKeys)
}

pub fn process_place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    // 6 is the actual minimum the raw-pointer destructure below reads (indices 0-5).
    // Previously required >=7, a leftover from the old index-based maker-lookup scheme
    // that forced every order — including Split/Merge and single-book Market orders,
    // neither of which ever touch a maker account — to pad the account list with an
    // unused placeholder. Now that makers are resolved by pubkey scan (see
    // find_maker_account below), only orders that actually cross resting makers need any
    // accounts beyond this base set.
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let accounts_ptr = accounts.as_mut_ptr();
    let (user, market_pda, platform_user_state, market_user_state, _orderbook_a, _orderbook_b) = unsafe {
        (
            &mut *accounts_ptr.add(0),
            &mut *accounts_ptr.add(1),
            &mut *accounts_ptr.add(2),
            &mut *accounts_ptr.add(3),
            &mut *accounts_ptr.add(4),
            &mut *accounts_ptr.add(5),
        )
    };

    let args = PlaceOrderArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    unsafe {
        let market_data = market_pda.borrow_unchecked();
        let market_state = MarketState::from_bytes(&market_data)?;
        if market_state.is_settled == 1 || market_state.market_status == 2 {
            return Err(AlleyError::MarketAlreadySettled.into());
        }
    }

    // Global Profile Verification: Catch empty account buffers before pointer casting
    if platform_user_state.data_len() < PlatformUserState::LEN {
        return Err(AlleyError::PlatformUserNotInitialized.into());
    }

    // Input Boundary Verification
    if args.order_type == 0 || args.order_type == 1 {
        if args.price == 0 || args.price >= 100 {
            return Err(AlleyError::InvalidPriceBounds.into());
        }
    }

    if market_user_state.data_len() == 0 {
        let bump_slice = [args.bump_market_user];
        let pda_signer_seeds = [
            Seed::from(b"market_user"),
            Seed::from(market_pda.address().as_ref()),
            Seed::from(user.address().as_ref()),
            Seed::from(&bump_slice),
        ];

        CreateAccount {
            from: user,
            to: market_user_state,
            lamports: 2_000_000,
            space: MarketUserState::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&pda_signer_seeds)])?;

        unsafe {
            let user_data_mut = market_user_state.borrow_unchecked_mut();
            let state_mut = &mut *(user_data_mut.as_mut_ptr() as *mut MarketUserState);
            state_mut.wallet = user.address().clone();
            state_mut.market_pda = market_pda.address().clone();
            state_mut.platform_user_state = platform_user_state.address().clone();
            state_mut.ot_a_balance = 0;
            state_mut.ot_b_balance = 0;
            state_mut.collateral_claimable = 0;
            state_mut.bump = args.bump_market_user;
        }
    }

    match args.order_type {
        0 => limit::execute_limit_order(accounts, &args),
        1 | 4 => market::execute_market_order(accounts, &args),
        2 => split::execute_split_operation(accounts, &args),
        3 => merge::execute_merge_operation(accounts, &args),
        _ => Err(ProgramError::InvalidArgument),
    }
}
