use crate::state::{ClaimFundsArgs, MarketState, MarketTier, OrderBookView, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub fn process_claim_funds(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [user, market_pda, platform_user_state, orderbook, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = ClaimFundsArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if platform_user_state.data_len() < PlatformUserState::LEN {
        return Err(ProgramError::InvalidAccountData);
    }

    // 2. Validate Platform State Ownership and Extract Stored Bump
    let state_bump = unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
        state.bump
    };

    // 3. SECURE FIXED: Re-derive and verify off-curve PDA integrity
    let bump_slice = [state_bump];
    let expected_state_seeds: &[&[u8]] = &[b"user_state", user.address().as_ref(), &bump_slice];
    let expected_state_pda = Address::create_program_address(expected_state_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;

    if platform_user_state.address() != &expected_state_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let tier = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        if args.outcome == 0 {
            if state.orderbook_a != *orderbook.address() {
                return Err(ProgramError::InvalidArgument);
            }
        } else {
            if state.orderbook_b != *orderbook.address() {
                return Err(ProgramError::InvalidArgument);
            }
        }
        MarketTier::from_u8(state.tier)?
    };

    unsafe {
        let book_data = orderbook.borrow_unchecked_mut();
        let view = OrderBookView::load(book_data.as_mut_ptr(), tier);

        let mut seat_idx: Option<usize> = None;
        for i in 0..(view.header.total_allocated_seats as usize) {
            if view.seats[i].wallet == *user.address() {
                seat_idx = Some(i);
                break;
            }
        }

        let s_idx = seat_idx.ok_or(ProgramError::InvalidArgument)?;
        let seat = &mut view.seats[s_idx];

        let user_data = platform_user_state.borrow_unchecked_mut();
        let user_mut = &mut *(user_data.as_mut_ptr() as *mut PlatformUserState);

        if seat.collateral_claimable > 0 {
            user_mut.collateral_available += seat.collateral_claimable;
            seat.collateral_claimable = 0;
        }

        // Note: Outcome shares (`ot_a_claimable` / `ot_b_claimable`) stay on the seat
        // until the user either uses them to sell via an Ask order, or explicitly calls
        // a standard platform `export_tokens` instruction to mint them out into an external wallet ATA.

        // Tombstone Check: If a trader has zero active orders or claimable balances, free the slot
        let has_active_liabilities = seat.collateral_locked > 0
            || seat.ot_a_locked > 0
            || seat.ot_b_locked > 0
            || seat.ot_a_claimable > 0
            || seat.ot_b_claimable > 0;

        if !has_active_liabilities {
            seat.wallet = Address::default();
        }
    }

    Ok(())
}
