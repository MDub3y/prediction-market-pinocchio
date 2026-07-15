use crate::state::{
    MarketState, MarketTier, MarketUserState, OrderBookView, PlaceOrderArgs, PlatformUserState,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

#[inline(always)]
fn calculate_symmetric_fee(quantity: u64, price: u8, fee_rate_bps: u64) -> u64 {
    let p = price as u64;
    if p == 0 || p >= 100 {
        return 0;
    }
    let numerator = quantity * fee_rate_bps * p * (100 - p);
    let fee = numerator / 100_000_000;
    if fee == 0 && numerator > 0 { 1 } else { fee }
}

pub fn execute_limit_order(accounts: &mut [AccountView], args: &PlaceOrderArgs) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let accounts_ptr = accounts.as_mut_ptr();
    let (market_pda, platform_user_state, market_user_state, orderbook_a, orderbook_b) = unsafe {
        (
            &mut *accounts_ptr.add(1),
            &mut *accounts_ptr.add(2),
            &mut *accounts_ptr.add(3),
            &mut *accounts_ptr.add(4),
            &mut *accounts_ptr.add(5),
        )
    };

    let (tier, fee_rate_bps) = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        (MarketTier::from_u8(state.tier)?, state.fee_rate_bps as u64)
    };

    let mut taker_remaining = args.quantity;

    unsafe {
        let book_a_data = orderbook_a.borrow_unchecked_mut();
        let book_b_data = orderbook_b.borrow_unchecked_mut();

        let mut view_a = OrderBookView::load(book_a_data.as_mut_ptr(), tier);
        let mut view_b = OrderBookView::load(book_b_data.as_mut_ptr(), tier);

        // Determine target book and complementary book references
        let (view_target, view_comp) = if args.outcome == 0 {
            (&mut view_a, &mut view_b)
        } else {
            (&mut view_b, &mut view_a)
        };

        let market_state_raw = market_pda.borrow_unchecked_mut();
        let market_mut = &mut *(market_state_raw.as_mut_ptr() as *mut MarketState);

        let taker_p_raw = platform_user_state.borrow_unchecked_mut();
        let taker_p_mut = &mut *(taker_p_raw.as_mut_ptr() as *mut PlatformUserState);

        let taker_m_raw = market_user_state.borrow_unchecked_mut();
        let taker_m_mut = &mut *(taker_m_raw.as_mut_ptr() as *mut MarketUserState);

        // Cross-Orderbook Matching (for Buy Side)
        if args.side == 0 && taker_remaining > 0 {
            for comp_price in (1..=99).rev() {
                if taker_remaining == 0 {
                    break;
                }

                // If Taker Price + Complementary Maker Price is less than $1.00, no match is possible
                if (args.price as usize) + comp_price < 100 {
                    continue;
                }

                let comp_level = &mut view_comp.directory[comp_price];

                while taker_remaining > 0 && comp_level.head != 0 {
                    let head_idx = comp_level.head as usize;
                    let maker_order = &mut view_comp.orders[head_idx];

                    let taker_matched_price = (100 - comp_price) as u8;

                    let maker_m_account = accounts
                        .get_mut(6 + maker_order.user_seat_idx as usize)
                        .ok_or(ProgramError::NotEnoughAccountKeys)?;
                    let mut maker_m_raw = maker_m_account.borrow_unchecked_mut();
                    let maker_m_mut = &mut *(maker_m_raw.as_mut_ptr() as *mut MarketUserState);

                    let match_qty = if taker_remaining < maker_order.quantity {
                        taker_remaining
                    } else {
                        maker_order.quantity
                    };

                    let fee = calculate_symmetric_fee(match_qty, taker_matched_price, fee_rate_bps);
                    let fee_platform = fee / 2;
                    let fee_maker = (fee * 40) / 100;
                    let fee_creator = fee - fee_platform - fee_maker;

                    let taker_cost = ((match_qty * taker_matched_price as u64) / 100) + fee;
                    if taker_p_mut.collateral_available < taker_cost {
                        return Err(ProgramError::InsufficientFunds);
                    }

                    taker_p_mut.collateral_available -= taker_cost;
                    maker_m_mut.collateral_claimable += fee_maker;

                    market_mut.accumulated_platform_fees += fee_platform;
                    market_mut.accumulated_creator_fees += fee_creator;

                    if args.outcome == 0 {
                        taker_m_mut.ot_a_balance += match_qty;
                        maker_m_mut.ot_b_balance += match_qty;
                    } else {
                        taker_m_mut.ot_b_balance += match_qty;
                        maker_m_mut.ot_a_balance += match_qty;
                    }

                    taker_remaining -= match_qty;
                    maker_order.quantity -= match_qty;

                    if maker_order.quantity == 0 {
                        let next_head = maker_order.next_idx;
                        maker_order.next_idx = view_comp.header.next_free_node_idx;
                        view_comp.header.next_free_node_idx = comp_level.head;
                        comp_level.head = next_head;
                        if next_head == 0 {
                            comp_level.tail = 0;
                        }
                    }
                }
            }
        }

        // Rest any unmatched balance on the target orderbook
        if taker_remaining > 0 {
            let mut seat_idx: Option<usize> = None;
            let mut available_tombstone_idx: Option<usize> = None;

            for i in 0..(view_target.header.total_allocated_seats as usize) {
                if view_target.seats[i].market_user_state == *market_user_state.address() {
                    seat_idx = Some(i);
                    break;
                }
                if view_target.seats[i].market_user_state == Address::default()
                    && available_tombstone_idx.is_none()
                {
                    available_tombstone_idx = Some(i);
                }
            }

            if seat_idx.is_none() {
                let target_seat_slot = if let Some(t_idx) = available_tombstone_idx {
                    t_idx
                } else {
                    let next_seat = view_target.header.total_allocated_seats as usize;
                    if next_seat >= view_target.seats.len() {
                        return Err(ProgramError::Custom(202));
                    }
                    view_target.header.total_allocated_seats += 1;
                    next_seat
                };

                view_target.seats[target_seat_slot].market_user_state =
                    market_user_state.address().clone();
                view_target.seats[target_seat_slot].collateral_locked = 0;
                view_target.seats[target_seat_slot].ot_a_locked = 0;
                view_target.seats[target_seat_slot].ot_b_locked = 0;
                seat_idx = Some(target_seat_slot);
            }

            let active_seat_idx = seat_idx.unwrap() as u32;
            let free_idx = view_target.header.next_free_node_idx;
            if free_idx == 0 {
                return Err(ProgramError::Custom(203));
            }

            let maker_seat = &mut view_target.seats[active_seat_idx as usize];

            if args.side == 0 {
                let cost = (taker_remaining * args.price as u64) / 100;
                if taker_p_mut.collateral_available < cost {
                    return Err(ProgramError::InsufficientFunds);
                }
                taker_p_mut.collateral_available -= cost;
                maker_seat.collateral_locked += cost;
            } else {
                if args.outcome == 0 {
                    if taker_m_mut.ot_a_balance < taker_remaining {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    taker_m_mut.ot_a_balance -= taker_remaining;
                    maker_seat.ot_a_locked += taker_remaining;
                } else {
                    if taker_m_mut.ot_b_balance < taker_remaining {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    taker_m_mut.ot_b_balance -= taker_remaining;
                    maker_seat.ot_b_locked += taker_remaining;
                }
            }

            view_target.header.next_free_node_idx = view_target.orders[free_idx as usize].next_idx;

            let new_node = &mut view_target.orders[free_idx as usize];
            new_node.user_seat_idx = active_seat_idx;
            new_node.quantity = taker_remaining;
            new_node.order_id = args.order_id;
            new_node.next_idx = 0;

            let directory_index = (args.side as usize * 100) + args.price as usize;
            let level = &mut view_target.directory[directory_index];
            if level.tail == 0 {
                level.head = free_idx;
                level.tail = free_idx;
            } else {
                view_target.orders[level.tail as usize].next_idx = free_idx;
                level.tail = free_idx;
            }
        }
    }

    Ok(())
}
