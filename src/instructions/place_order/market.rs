use crate::state::{
    MarketState, MarketTier, MarketUserState, OrderBookView, PlaceOrderArgs, PlatformUserState,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

const FEE_BASIS_POINTS: u64 = 20;

pub fn execute_market_order(accounts: &mut [AccountView], args: &PlaceOrderArgs) -> ProgramResult {
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

    let tier = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        MarketTier::from_u8(state.tier)?
    };

    unsafe {
        let book_data = orderbook.borrow_unchecked_mut();
        let view = OrderBookView::load(book_data.as_mut_ptr(), tier);

        let seats_ptr = view.seats.as_mut_ptr();
        let mut taker_remaining = args.quantity;

        let market_state_data = market_pda.borrow_unchecked_mut();
        let market_mut = &mut *(market_state_data.as_mut_ptr() as *mut MarketState);

        let taker_p_data = platform_user_state.borrow_unchecked_mut();
        let taker_p_mut = &mut *(taker_p_data.as_mut_ptr() as *mut PlatformUserState);

        let mut taker_m_data = market_user_state.borrow_unchecked_mut();
        let taker_m_mut = &mut *(taker_m_data.as_mut_ptr() as *mut MarketUserState);

        if args.side == 1 {
            // taker sell order: matches against buy orders
            for current_price in (args.price as usize..=99).rev() {
                if taker_remaining == 0 {
                    break;
                }
                let level = &mut view.directory[current_price];

                while taker_remaining > 0 && level.head != 0 {
                    let head_node_idx = level.head as usize;
                    let maker_order = &mut view.orders[head_node_idx];
                    let maker_seat = &mut *seats_ptr.add(maker_order.user_seat_idx as usize);

                    // Fetch maker storage account page reference using the seat link
                    let mut maker_m_data = AccountView::borrow_unchecked_mut(
                        accounts
                            .get_mut(4 + maker_order.user_seat_idx as usize)
                            .ok_or(ProgramError::NotEnoughAccountKeys)?,
                    );
                    let maker_m_mut = &mut *(maker_m_data.as_mut_ptr() as *mut MarketUserState);

                    let match_qty = if taker_remaining < maker_order.quantity {
                        taker_remaining
                    } else {
                        maker_order.quantity
                    };
                    let trade_collateral = match_qty * (current_price as u64);
                    let fee = (trade_collateral * FEE_BASIS_POINTS) / 10_000;
                    let net_collateral = trade_collateral - fee;

                    if args.outcome == 0 {
                        if taker_m_mut.ot_a_balance < match_qty {
                            return Err(ProgramError::InsufficientFunds);
                        }
                        taker_m_mut.ot_a_balance -= match_qty;
                        maker_m_mut.ot_a_balance += match_qty;
                    } else {
                        if taker_m_mut.ot_b_balance < match_qty {
                            return Err(ProgramError::InsufficientFunds);
                        }
                        taker_m_mut.ot_b_balance -= match_qty;
                        maker_m_mut.ot_b_balance += match_qty;
                    }

                    maker_seat.collateral_locked -= trade_collateral;
                    taker_p_mut.collateral_available += net_collateral;
                    market_mut.accumulated_fees += fee;

                    taker_remaining -= match_qty;
                    maker_order.quantity -= match_qty;

                    if maker_order.quantity == 0 {
                        let next_head = maker_order.next_idx;
                        maker_order.next_idx = view.header.next_free_node_idx;
                        view.header.next_free_node_idx = level.head;
                        level.head = next_head;
                        if next_head == 0 {
                            level.tail = 0;
                        }
                    }

                    // seat recycling: evict seat immediately if maker holds zero remaining structural liabilities
                    if maker_seat.collateral_locked == 0
                        && maker_seat.ot_a_locked == 0
                        && maker_seat.ot_b_locked == 0
                    {
                        maker_seat.market_user_state = Address::default();
                    }
                }
            }
        } else {
            // taker buy order: matches against sell orders
            for current_price in 1..=args.price as usize {
                if taker_remaining == 0 {
                    break;
                }
                let level = &mut view.directory[100 + current_price];

                while taker_remaining > 0 && level.head != 0 {
                    let head_node_idx = level.head as usize;
                    let maker_order = &mut view.orders[head_node_idx];
                    let maker_seat = &mut *seats_ptr.add(maker_order.user_seat_idx as usize);

                    let mut maker_m_data = AccountView::borrow_unchecked_mut(
                        accounts
                            .get_mut(4 + maker_order.user_seat_idx as usize)
                            .ok_or(ProgramError::NotEnoughAccountKeys)?,
                    );
                    let maker_m_mut = &mut *(maker_m_data.as_mut_ptr() as *mut MarketUserState);

                    let match_qty = if taker_remaining < maker_order.quantity {
                        taker_remaining
                    } else {
                        maker_order.quantity
                    };
                    let trade_collateral = match_qty * (current_price as u64);
                    let fee = (trade_collateral * FEE_BASIS_POINTS) / 10_000;
                    let net_collateral = trade_collateral - fee;

                    if taker_p_mut.collateral_available < trade_collateral {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    taker_p_mut.collateral_available -= trade_collateral;
                    maker_m_mut.collateral_claimable += net_collateral;

                    if args.outcome == 0 {
                        taker_m_mut.ot_a_balance += match_qty;
                        maker_seat.ot_a_locked -= match_qty;
                    } else {
                        taker_m_mut.ot_b_balance += match_qty;
                        maker_seat.ot_b_locked -= match_qty;
                    }

                    market_mut.accumulated_fees += fee;
                    taker_remaining -= match_qty;
                    maker_order.quantity -= match_qty;

                    if maker_order.quantity == 0 {
                        let next_head = maker_order.next_idx;
                        maker_order.next_idx = view.header.next_free_node_idx;
                        view.header.next_free_node_idx = level.head;
                        level.head = next_head;
                        if next_head == 0 {
                            level.tail = 0;
                        }
                    }

                    if maker_seat.collateral_locked == 0
                        && maker_seat.ot_a_locked == 0
                        && maker_seat.ot_b_locked == 0
                    {
                        maker_seat.market_user_state = Address::default();
                    }
                }
            }
        }

        if taker_remaining > 0 {
            return Err(ProgramError::InvalidArgument);
        }
    }

    Ok(())
}
