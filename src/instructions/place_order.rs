use crate::state::{
    MarketState, MarketTier, OrderBookHeader, OrderNode, PlaceOrderArgs, PriceLevel, TraderSeat,
    UserMarketPosition,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

const FEE_BASIS_POINTS: u64 = 20;

pub fn process_place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [user, market_pda, user_market_position, orderbook, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = PlaceOrderArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if args.price < 1 || args.price > 99 {
        return Err(ProgramError::InvalidArgument);
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
        MarketTier::from_u8(state.size_params.tier_flag)?
    };

    let max_seats = match tier {
        MarketTier::Small => crate::state::SMALL_SEATS,
        MarketTier::Medium => crate::state::MEDIUM_SEATS,
        MarketTier::Large => crate::state::LARGE_SEATS,
    };

    let max_orders = match tier {
        MarketTier::Small => crate::state::SMALL_ORDERS * 2,
        MarketTier::Medium => crate::state::MEDIUM_ORDERS * 2,
        MarketTier::Large => crate::state::LARGE_ORDERS * 2,
    };

    let offset_dir = core::mem::size_of::<OrderBookHeader>();
    let offset_seats = offset_dir + (core::mem::size_of::<PriceLevel>() * 200);
    let offset_orders = offset_seats + (core::mem::size_of::<TraderSeat>() * max_seats);

    unsafe {
        let mut book_data = orderbook.borrow_unchecked_mut();
        let book_ptr = book_data.as_mut_ptr();

        let header = &mut *(book_ptr as *mut OrderBookHeader);
        if header.market_state_pda != *market_pda.address() {
            return Err(ProgramError::InvalidArgument);
        }

        let dir_slice =
            core::slice::from_raw_parts_mut(book_ptr.add(offset_dir) as *mut PriceLevel, 200);
        let seats_slice = core::slice::from_raw_parts_mut(
            book_ptr.add(offset_seats) as *mut TraderSeat,
            max_seats,
        );
        let orders_slice = core::slice::from_raw_parts_mut(
            book_ptr.add(offset_orders) as *mut OrderNode,
            max_orders,
        );

        let mut seat_idx: Option<usize> = None;
        for i in 0..(header.total_allocated_seats as usize) {
            if seats_slice[i].wallet == *user.address() {
                seat_idx = Some(i);
                break;
            }
        }

        if seat_idx.is_none() {
            let next_seat = header.total_allocated_seats as usize;
            if next_seat >= max_seats {
                return Err(ProgramError::Custom(202));
            }
            seats_slice[next_seat].wallet = user.address().clone();
            seats_slice[next_seat].collateral_claimable = 0;
            seats_slice[next_seat].shares_claimable = 0;
            header.total_allocated_seats += 1;
            seat_idx = Some(next_seat);
        }
        let active_seat_idx = seat_idx.unwrap() as u32;

        let directory_index = (args.side as usize * 100) + args.price as usize;

        if args.order_type == 0 {
            // limit order
            let free_idx = header.next_free_node_idx;
            if free_idx == 0 {
                return Err(ProgramError::Custom(203));
            }

            let mut pos_data = user_market_position.borrow_unchecked_mut();
            let pos_mut = &mut *(pos_data.as_mut_ptr() as *mut UserMarketPosition);

            if args.side == 0 {
                let cost = args.quantity * (args.price as u64);
                if pos_mut.collateral_available < cost {
                    return Err(ProgramError::InsufficientFunds);
                }
                pos_mut.collateral_available -= cost;
                pos_mut.collateral_locked += cost;
            } else {
                if args.outcome == 0 {
                    if pos_mut.ot_a_available < args.quantity {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    pos_mut.ot_a_available -= args.quantity;
                    pos_mut.ot_a_locked += args.quantity;
                } else {
                    if pos_mut.ot_b_available < args.quantity {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    pos_mut.ot_b_available -= args.quantity;
                    pos_mut.ot_b_locked += args.quantity;
                }
            }

            header.next_free_node_idx = orders_slice[free_idx as usize].next_idx;

            let new_node = &mut orders_slice[free_idx as usize];
            new_node.user_seat_idx = active_seat_idx;
            new_node.quantity = args.quantity;
            new_node.order_id = args.order_id;
            new_node.next_idx = 0;

            let level = &mut dir_slice[directory_index];
            if level.tail == 0 {
                level.head = free_idx;
                level.tail = free_idx;
            } else {
                orders_slice[level.tail as usize].next_idx = free_idx;
                level.tail = free_idx;
            }
        } else {
            // market order
            let counter_side = if args.side == 0 { 1 } else { 0 };
            let target_dir_index = (counter_side * 100) + args.price as usize;

            let mut taker_remaining = args.quantity;
            let level = &mut dir_slice[target_dir_index];

            let mut market_state_data = market_pda.borrow_unchecked_mut();
            let market_mut = &mut *(market_state_data.as_mut_ptr() as *mut MarketState);

            let taker_pos_data = user_market_position.borrow_unchecked_mut();
            let taker_pos_mut = &mut *(taker_pos_data.as_mut_ptr() as *mut UserMarketPosition);

            while taker_remaining > 0 && level.head != 0 {
                let head_node_idx = level.head as usize;
                let maker_order = &mut orders_slice[head_node_idx];
                let maker_seat = &mut seats_slice[maker_order.user_seat_idx as usize];

                let match_qty = if taker_remaining < maker_order.quantity {
                    taker_remaining
                } else {
                    maker_order.quantity
                };
                let trade_collateral = match_qty * (args.price as u64);
                let fee = (trade_collateral * FEE_BASIS_POINTS) / 10_000;
                let net_collateral = trade_collateral - fee;

                if args.side == 0 {
                    // taker buying vs maker resting seller
                    if taker_pos_mut.collateral_available < trade_collateral {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    maker_seat.collateral_claimable += net_collateral;

                    taker_pos_mut.collateral_available -= trade_collateral;
                    if args.outcome == 0 {
                        taker_pos_mut.ot_a_available += match_qty;
                    } else {
                        taker_pos_mut.ot_b_available += match_qty;
                    }
                } else {
                    // taker selling vs maker resting buyer
                    if args.outcome == 0 {
                        if taker_pos_mut.ot_a_available < match_qty {
                            return Err(ProgramError::InsufficientFunds);
                        }
                        taker_pos_mut.ot_a_available -= match_qty;
                    } else {
                        if taker_pos_mut.ot_b_available < match_qty {
                            return Err(ProgramError::InsufficientFunds);
                        }
                        taker_pos_mut.ot_b_available -= match_qty;
                    }

                    maker_seat.shares_claimable += match_qty;
                    taker_pos_mut.collateral_available += net_collateral;
                }

                market_mut.accumulated_fees += fee;
                taker_remaining -= match_qty;
                maker_order.quantity -= match_qty;

                if maker_order.quantity == 0 {
                    let next_head = maker_order.next_idx;
                    maker_order.next_idx = header.next_free_node_idx;
                    header.next_free_node_idx = level.head;

                    level.head = next_head;
                    if next_head == 0 {
                        level.tail = 0;
                    }
                }
            }

            if taker_remaining > 0 {
                return Err(ProgramError::InvalidArgument); // saturated book depth limits
            }
        }
    }
    Ok(())
}
