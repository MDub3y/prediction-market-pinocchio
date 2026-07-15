use crate::state::{
    CancelOrderArgs, MarketState, MarketTier, MarketUserState, OrderBookView, PlatformUserState,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub fn process_cancel_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        user,
        market_pda,
        platform_user_state,
        market_user_state,
        orderbook,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = CancelOrderArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if platform_user_state.data_len() < PlatformUserState::LEN
        || market_user_state.data_len() < MarketUserState::LEN
    {
        return Err(ProgramError::InvalidAccountData);
    }

    let platform_bump = unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
        state.bump
    };
    let p_bump_slice = [platform_bump];
    let expected_platform_pda = Address::create_program_address(
        &[b"user_state", user.address().as_ref(), &p_bump_slice],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;

    if platform_user_state.address() != &expected_platform_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let market_user_bump = unsafe {
        let user_data = market_user_state.borrow_unchecked();
        let state = MarketUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() || state.market_pda != *market_pda.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
        state.bump
    };
    let m_bump_slice = [market_user_bump];
    let expected_market_user_pda = Address::create_program_address(
        &[
            b"market_user",
            market_pda.address().as_ref(),
            user.address().as_ref(),
            &m_bump_slice,
        ],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;

    if market_user_state.address() != &expected_market_user_pda {
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

        let target_node_idx = args.order_node_idx as usize;
        if target_node_idx >= view.orders.len() {
            return Err(ProgramError::InvalidArgument);
        }

        let node_user_seat_idx = view.orders[target_node_idx].user_seat_idx;
        let node_next_idx = view.orders[target_node_idx].next_idx;
        let node_quantity = view.orders[target_node_idx].quantity;
        let node_order_id = view.orders[target_node_idx].order_id;

        let maker_seat = &mut view.seats[node_user_seat_idx as usize];

        if maker_seat.market_user_state != *market_user_state.address()
            || node_order_id != args.order_id
        {
            return Err(ProgramError::InvalidArgument);
        }

        // truncate Node from Linked List Directory
        let directory_index = (args.side as usize * 100) + args.price as usize;
        let level = &mut view.directory[directory_index];

        let mut curr_node_idx = level.head;
        let mut prev_node_idx = 0u32;
        let mut found = false;

        while curr_node_idx != 0 {
            if curr_node_idx == args.order_node_idx {
                found = true;
                break;
            }
            prev_node_idx = curr_node_idx;
            curr_node_idx = view.orders[curr_node_idx as usize].next_idx;
        }

        if !found {
            return Err(ProgramError::InvalidArgument);
        }

        if prev_node_idx == 0 {
            level.head = node_next_idx;
            if level.head == 0 {
                level.tail = 0;
            }
        } else {
            view.orders[prev_node_idx as usize].next_idx = node_next_idx;
            if level.tail == args.order_node_idx {
                level.tail = prev_node_idx;
            }
        }

        if args.side == 0 {
            // Refund Base Collateral directly to PlatformUserState
            let refund_collateral = (node_quantity * args.price as u64) / 100;
            maker_seat.collateral_locked -= refund_collateral;

            let user_p_data = platform_user_state.borrow_unchecked_mut();
            let user_p_mut = &mut *(user_p_data.as_mut_ptr() as *mut PlatformUserState);
            user_p_mut.collateral_available += refund_collateral;
        } else {
            // Refund Option Share Credits back to MarketUserState
            let user_m_data = market_user_state.borrow_unchecked_mut();
            let user_m_mut = &mut *(user_m_data.as_mut_ptr() as *mut MarketUserState);

            if args.outcome == 0 {
                maker_seat.ot_a_locked -= node_quantity;
                user_m_mut.ot_a_balance += node_quantity;
            } else {
                maker_seat.ot_b_locked -= node_quantity;
                user_m_mut.ot_b_balance += node_quantity;
            }
        }

        let mut_node = &mut view.orders[target_node_idx];
        mut_node.quantity = 0;
        mut_node.order_id = 0;
        mut_node.user_seat_idx = 0;
        mut_node.next_idx = view.header.next_free_node_idx;
        view.header.next_free_node_idx = args.order_node_idx;

        if maker_seat.collateral_locked == 0
            && maker_seat.ot_a_locked == 0
            && maker_seat.ot_b_locked == 0
        {
            maker_seat.market_user_state = Address::default();
        }
    }

    Ok(())
}
