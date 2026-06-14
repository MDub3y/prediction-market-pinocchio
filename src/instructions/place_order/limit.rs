use crate::state::{
    MarketState, MarketTier, MarketUserState, OrderBookView, PlaceOrderArgs,
    PlatformUserState,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub fn execute_limit_order(accounts: &mut [AccountView], args: &PlaceOrderArgs) -> ProgramResult {
    let [
        _user,
        market_pda,
        platform_user_state,
        market_user_state,
        orderbook,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let tier = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        MarketTier::from_u8(state.tier)?
    };

    unsafe {
        let book_data = orderbook.borrow_unchecked_mut();
        let view = OrderBookView::load(book_data.as_mut_ptr(), tier);

        let mut seat_idx: Option<usize> = None;
        let mut available_tombstone_idx: Option<usize> = None;

        // match seat by MarketUserState address link (not wallet)
        for i in 0..(view.header.total_allocated_seats as usize) {
            if view.seats[i].market_user_state == *market_user_state.address() {
                seat_idx = Some(i);
                break;
            }
            if view.seats[i].market_user_state == Address::default()
                && available_tombstone_idx.is_none()
            {
                available_tombstone_idx = Some(i);
            }
        }

        if seat_idx.is_none() {
            let target_seat_slot = if let Some(t_idx) = available_tombstone_idx {
                t_idx
            } else {
                let next_seat = view.header.total_allocated_seats as usize;
                if next_seat >= view.seats.len() {
                    return Err(ProgramError::Custom(202));
                }
                view.header.total_allocated_seats += 1;
                next_seat
            };

            view.seats[target_seat_slot].market_user_state = market_user_state.address().clone();
            view.seats[target_seat_slot].collateral_locked = 0;
            view.seats[target_seat_slot].ot_a_locked = 0;
            view.seats[target_seat_slot].ot_b_locked = 0;
            seat_idx = Some(target_seat_slot);
        }

        let active_seat_idx = seat_idx.unwrap() as u32;
        let free_idx = view.header.next_free_node_idx;
        if free_idx == 0 {
            return Err(ProgramError::Custom(203));
        }

        let maker_seat = &mut view.seats[active_seat_idx as usize];

        if args.side == 0 {
            let cost = args.quantity * (args.price as u64);
            let p_data = platform_user_state.borrow_unchecked_mut();
            let user_mut = &mut *(p_data.as_mut_ptr() as *mut PlatformUserState);
            if user_mut.collateral_available < cost {
                return Err(ProgramError::InsufficientFunds);
            }
            user_mut.collateral_available -= cost;
            maker_seat.collateral_locked += cost;
        } else {
            let m_data = market_user_state.borrow_unchecked_mut();
            let market_user = &mut *(m_data.as_mut_ptr() as *mut MarketUserState);
            if args.outcome == 0 {
                if market_user.ot_a_balance < args.quantity {
                    return Err(ProgramError::InsufficientFunds);
                }
                market_user.ot_a_balance -= args.quantity;
                maker_seat.ot_a_locked += args.quantity;
            } else {
                if market_user.ot_b_balance < args.quantity {
                    return Err(ProgramError::InsufficientFunds);
                }
                market_user.ot_b_balance -= args.quantity;
                maker_seat.ot_b_locked += args.quantity;
            }
        }

        view.header.next_free_node_idx = view.orders[free_idx as usize].next_idx;

        let new_node = &mut view.orders[free_idx as usize];
        new_node.user_seat_idx = active_seat_idx;
        new_node.quantity = args.quantity;
        new_node.order_id = args.order_id;
        new_node.next_idx = 0;

        let directory_index = (args.side as usize * 100) + args.price as usize;
        let level = &mut view.directory[directory_index];
        if level.tail == 0 {
            level.head = free_idx;
            level.tail = free_idx;
        } else {
            view.orders[level.tail as usize].next_idx = free_idx;
            level.tail = free_idx;
        }
    }

    Ok(())
}
