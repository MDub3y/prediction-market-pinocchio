use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

use crate::state::{
    InitializeOrderBookArgs, MarketState, MarketTier, OrderBookHeader, OrderNode, PriceLevel,
    TraderSeat, calculate_orderbook_space,
};

pub fn process_initialize_orderbooks(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        creator,
        market_pda,
        orderbook_a,
        orderbook_b,
        _system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = InitializeOrderBookArgs::from_bytes(instruction_data)?;
    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let tier = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        MarketTier::from_u8(state.tier)?
    };

    let required_space = calculate_orderbook_space(tier);

    let a_bump_slice = [args.bump_book_a];
    let raw_a_seeds: &[&[u8]] = &[b"orderbook_a", market_pda.address().as_ref(), &a_bump_slice];
    let expected_book_a = Address::create_program_address(raw_a_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if orderbook_a.address() != &expected_book_a {
        return Err(ProgramError::InvalidSeeds);
    }

    let b_bump_slice = [args.bump_book_b];
    let raw_b_seeds: &[&[u8]] = &[b"orderbook_b", market_pda.address().as_ref(), &b_bump_slice];
    let expected_book_b = Address::create_program_address(raw_b_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if orderbook_b.address() != &expected_book_b {
        return Err(ProgramError::InvalidSeeds);
    }

    let signer_a_seeds = [
        Seed::from(b"orderbook_a"),
        Seed::from(market_pda.address().as_ref()),
        Seed::from(&a_bump_slice),
    ];
    CreateAccount {
        from: creator,
        to: orderbook_a,
        lamports: orderbook_a.lamports(),
        space: required_space as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_a_seeds)])?;

    let signer_b_seeds = [
        Seed::from(b"orderbook_b"),
        Seed::from(market_pda.address().as_ref()),
        Seed::from(&b_bump_slice),
    ];
    CreateAccount {
        from: creator,
        to: orderbook_b,
        lamports: orderbook_b.lamports(),
        space: required_space as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_b_seeds)])?;

    for (idx, book_account) in [0u8, 1u8]
        .iter()
        .zip([&mut *orderbook_a, &mut *orderbook_b])
    {
        unsafe {
            let mut data = book_account.borrow_unchecked_mut();

            let header = &mut *(data.as_mut_ptr() as *mut OrderBookHeader);
            header.market_state_pda = market_pda.address().clone();
            header.total_allocated_seats = 0;
            header.next_free_node_idx = 1;
            header.outcome_index = *idx;

            let offset_dir = core::mem::size_of::<OrderBookHeader>();
            let dir_ptr = data.as_mut_ptr().add(offset_dir) as *mut PriceLevel;
            core::ptr::write_bytes(dir_ptr, 0, 200);

            let max_orders = match tier {
                MarketTier::Small => crate::state::SMALL_ORDERS,
                MarketTier::Medium => crate::state::MEDIUM_ORDERS,
                MarketTier::Large => crate::state::LARGE_ORDERS,
            };

            let max_seats = match tier {
                MarketTier::Small => crate::state::SMALL_SEATS,
                MarketTier::Medium => crate::state::MEDIUM_SEATS,
                MarketTier::Large => crate::state::LARGE_SEATS,
            };

            let offset_seats = offset_dir + (core::mem::size_of::<PriceLevel>() * 200);
            let offset_orders = offset_seats + (core::mem::size_of::<TraderSeat>() * max_seats);
            let orders_ptr = data.as_mut_ptr().add(offset_orders) as *mut OrderNode;

            for i in 1..max_orders {
                let node = &mut *orders_ptr.add(i);
                node.next_idx = (i + 1) as u32;
            }
            (*orders_ptr.add(max_orders - 1)).next_idx = 0; // Terminate linked free pool
        }
    }

    unsafe {
        let mut data_slice = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_slice.as_mut_ptr() as *mut MarketState);
        state_mut.orderbook_a = orderbook_a.address().clone();
        state_mut.orderbook_b = orderbook_b.address().clone();
    }

    Ok(())
}
