use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

use crate::state::{
    MarketState, MarketTier, OrderBookHeader, OrderNode, PriceLevel, TraderSeat,
    calculate_orderbook_space,
};

pub fn process_initialize_orderbooks(
    program_id: &Address,
    accounts: &mut [AccountView],
    _instruction_data: &[u8],
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

    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let tier = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        MarketTier::from_u8(state.tier)?
    };

    let required_space = calculate_orderbook_space(tier);

    // Both orderbooks will be standard keypairs generated on client
    // with program_id as the designated owner. This allows to create accounts
    // with space allocation upto 10 MiB.
    // Verify: if the owners of the orderbook accounts is program_id.
    if orderbook_a.owner() != program_id || orderbook_b.owner() != program_id {
        return Err(ProgramError::IncorrectAuthority);
    }

    // Verify: if the client actually paid for the required memory footprint
    if orderbook_a.data_len() < required_space || orderbook_b.data_len() < required_space {
        return Err(ProgramError::AccountDataTooSmall);
    }

    for (idx, book_account) in [0u8, 1u8]
        .iter()
        .zip([&mut *orderbook_a, &mut *orderbook_b])
    {
        unsafe {
            let data = book_account.borrow_unchecked_mut();

            core::ptr::write_bytes(data.as_mut_ptr(), 0, data.len());

            let header = &mut *(data.as_mut_ptr() as *mut OrderBookHeader);
            header.market_state_pda = market_pda.address().clone();
            header.total_allocated_seats = 0;
            header.next_free_node_idx = 1; // free list starts at idx 1 (idx 0 = null sentinel)
            header.outcome_index = *idx;

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

            let offset_dir = core::mem::size_of::<OrderBookHeader>();
            let dir_ptr = data.as_mut_ptr().add(offset_dir) as *mut PriceLevel;
            core::ptr::write_bytes(dir_ptr, 0, 200);
            let offset_seats = offset_dir + (core::mem::size_of::<PriceLevel>() * 200);
            let offset_orders = offset_seats + (core::mem::size_of::<TraderSeat>() * max_seats);
            let orders_ptr = data.as_mut_ptr().add(offset_orders) as *mut OrderNode;

            // explicitly cleared the 0th index node to guarantee a pure null sentinel
            let null_node = &mut *orders_ptr.add(0);
            null_node.user_seat_idx = 0;
            null_node.quantity = 0;
            null_node.next_idx = 0;
            null_node.order_id = 0;

            for i in 1..max_orders {
                let node = &mut *orders_ptr.add(i);
                node.next_idx = (i + 1) as u32;
            }
            (*orders_ptr.add(max_orders - 1)).next_idx = 0; // Terminate linked free pool
        }
    }

    unsafe {
        let data_slice = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_slice.as_mut_ptr() as *mut MarketState);
        state_mut.orderbook_a = orderbook_a.address().clone();
        state_mut.orderbook_b = orderbook_b.address().clone();
    }

    Ok(())
}
