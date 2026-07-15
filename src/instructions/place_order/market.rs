use crate::state::{
    MarketState, MarketTier, MarketUserState, OrderBookView, PlaceOrderArgs, PlatformUserState,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

const FEE_BASIS_POINTS: u64 = 20;

#[inline(always)]
fn calculate_symmetric_fee(quantity: u64, price: u8, fee_rate_bps: u64) -> u64 {
    let p = price as u64;
    if p == 0 || p >= 100 {
        return 0;
    }

    // Denominator = 10,000 (bps) * 100 (p percentage) * 100 (1-p percentage) = 100,000,000
    let numerator = quantity * fee_rate_bps * p * (100 - p);
    let fee = numerator / 100_000_000;

    if fee == 0 && numerator > 0 { 1 } else { fee }
}

pub fn execute_market_order(accounts: &mut [AccountView], args: &PlaceOrderArgs) -> ProgramResult {
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

    let (tier, fee_rate_bps) = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        (MarketTier::from_u8(state.tier)?, state.fee_rate_bps as u64)
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

        let taker_m_data = market_user_state.borrow_unchecked_mut();
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
                    let maker_m_data = AccountView::borrow_unchecked_mut(
                        accounts
                            .get_mut(5 + maker_order.user_seat_idx as usize)
                            .ok_or(ProgramError::NotEnoughAccountKeys)?,
                    );
                    let maker_m_mut = &mut *(maker_m_data.as_mut_ptr() as *mut MarketUserState);

                    let match_qty = if taker_remaining < maker_order.quantity {
                        taker_remaining
                    } else {
                        maker_order.quantity
                    };
                    let trade_collateral = (match_qty * current_price as u64) / 100;
                    let fee = calculate_symmetric_fee(match_qty, current_price as u8, fee_rate_bps);
                    let fee_platform = fee / 2; // 50%
                    let fee_maker = (fee * 40) / 100; // 40%
                    let fee_creator = fee - fee_platform - fee_maker; // 10% dust protection remainder

                    let net_taker_payout = trade_collateral - fee;

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

                    taker_p_mut.collateral_available += net_taker_payout;
                    maker_m_mut.collateral_claimable += fee_maker;
                    market_mut.accumulated_platform_fees += fee_platform;
                    market_mut.accumulated_creator_fees += fee_creator;

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

                    let maker_m_data = AccountView::borrow_unchecked_mut(
                        accounts
                            .get_mut(5 + maker_order.user_seat_idx as usize)
                            .ok_or(ProgramError::NotEnoughAccountKeys)?,
                    );
                    let maker_m_mut = &mut *(maker_m_data.as_mut_ptr() as *mut MarketUserState);

                    let match_qty = if taker_remaining < maker_order.quantity {
                        taker_remaining
                    } else {
                        maker_order.quantity
                    };
                    let trade_collateral = (match_qty * current_price as u64) / 100;
                    let fee = calculate_symmetric_fee(match_qty, current_price as u8, fee_rate_bps);
                    let fee_platform = fee / 2;
                    let fee_maker = (fee * 40) / 100;
                    let fee_creator = fee - fee_platform - fee_maker;

                    let total_taker_cost = trade_collateral + fee;

                    if taker_p_mut.collateral_available < total_taker_cost {
                        return Err(ProgramError::InsufficientFunds);
                    }

                    // Debit total capital cost + symmetric fee from the Taker
                    taker_p_mut.collateral_available -= total_taker_cost;

                    // Credit resting maker original trade collateral + their 40% rebate share
                    maker_m_mut.collateral_claimable += trade_collateral + fee_maker;

                    market_mut.accumulated_platform_fees += fee_platform;
                    market_mut.accumulated_creator_fees += fee_creator;

                    if args.outcome == 0 {
                        taker_m_mut.ot_a_balance += match_qty;
                        maker_seat.ot_a_locked -= match_qty;
                    } else {
                        taker_m_mut.ot_b_balance += match_qty;
                        maker_seat.ot_b_locked -= match_qty;
                    }

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
            if taker_remaining == args.quantity {
                // FOK Behavior: Absolutely zero liquidity found, revert transaction cleanly
                return Err(crate::errors::AlleyError::InsufficientBookLiquidity.into());
            }
            // FAK Behavior: Partial match achieved! Commit the filled contracts and kill the rest cleanly
        }
    }

    Ok(())
}
