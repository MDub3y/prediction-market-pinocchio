use crate::state::{MarketState, MarketTier, OrderBookView, PlaceOrderArgs, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

const FEE_BASIS_POINTS: u64 = 20;

pub fn process_place_order(
    _program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [user, market_pda, platform_user_state, orderbook, ..] = accounts else {
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
        MarketTier::from_u8(state.tier)?
    };

    unsafe {
        let book_data = orderbook.borrow_unchecked_mut();
        let view = OrderBookView::load(book_data.as_mut_ptr(), tier);

        if view.header.market_state_pda != *market_pda.address() {
            return Err(ProgramError::InvalidArgument);
        }

        let mut seat_idx: Option<usize> = None;
        let mut available_tombstone_idx: Option<usize> = None;

        for i in 0..(view.header.total_allocated_seats as usize) {
            if view.seats[i].wallet == *user.address() {
                seat_idx = Some(i);
                break;
            }
            if view.seats[i].wallet == Address::default() && available_tombstone_idx.is_none() {
                available_tombstone_idx = Some(i);
            }
        }

        let needs_seat = args.order_type == 0 || args.side == 0;

        if seat_idx.is_none() && needs_seat {
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

            view.seats[target_seat_slot].wallet = user.address().clone();
            view.seats[target_seat_slot].collateral_locked = 0;
            view.seats[target_seat_slot].ot_a_locked = 0;
            view.seats[target_seat_slot].ot_b_locked = 0;
            view.seats[target_seat_slot].collateral_claimable = 0;
            view.seats[target_seat_slot].ot_a_claimable = 0;
            view.seats[target_seat_slot].ot_b_claimable = 0;
            seat_idx = Some(target_seat_slot);
        }

        let directory_index = (args.side as usize * 100) + args.price as usize;

        let seats_ptr = view.seats.as_mut_ptr();

        if args.order_type == 0 {
            let active_seat_idx = seat_idx.unwrap() as u32;
            let free_idx = view.header.next_free_node_idx;
            if free_idx == 0 {
                return Err(ProgramError::Custom(203));
            }

            let user_data = platform_user_state.borrow_unchecked_mut();
            let user_mut = &mut *(user_data.as_mut_ptr() as *mut PlatformUserState);

            let maker_seat = &mut *seats_ptr.add(active_seat_idx as usize);

            if args.side == 0 {
                let cost = args.quantity * (args.price as u64);
                if user_mut.collateral_available < cost {
                    return Err(ProgramError::InsufficientFunds);
                }
                user_mut.collateral_available -= cost;
                maker_seat.collateral_locked += cost;
            } else {
                if args.outcome == 0 {
                    if maker_seat.ot_a_claimable < args.quantity {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    maker_seat.ot_a_claimable -= args.quantity;
                    maker_seat.ot_a_locked += args.quantity;
                } else {
                    if maker_seat.ot_b_claimable < args.quantity {
                        return Err(ProgramError::InsufficientFunds);
                    }
                    maker_seat.ot_b_claimable -= args.quantity;
                    maker_seat.ot_b_locked += args.quantity;
                }
            }

            view.header.next_free_node_idx = view.orders[free_idx as usize].next_idx;

            let new_node = &mut view.orders[free_idx as usize];
            new_node.user_seat_idx = active_seat_idx;
            new_node.quantity = args.quantity;
            new_node.order_id = args.order_id;
            new_node.next_idx = 0;

            let level = &mut view.directory[directory_index];
            if level.tail == 0 {
                level.head = free_idx;
                level.tail = free_idx;
            } else {
                view.orders[level.tail as usize].next_idx = free_idx;
                level.tail = free_idx;
            }
        } else {
            let counter_side = if args.side == 0 { 1 } else { 0 };
            let mut taker_remaining = args.quantity;

            let market_state_data = market_pda.borrow_unchecked_mut();
            let market_mut = &mut *(market_state_data.as_mut_ptr() as *mut MarketState);

            let taker_data = platform_user_state.borrow_unchecked_mut();
            let taker_mut = &mut *(taker_data.as_mut_ptr() as *mut PlatformUserState);

            if counter_side == 0 {
                for current_price in (args.price as usize..=99).rev() {
                    if taker_remaining == 0 {
                        break;
                    }

                    let target_dir_index = current_price;
                    let level = &mut view.directory[target_dir_index];

                    while taker_remaining > 0 && level.head != 0 {
                        let head_node_idx = level.head as usize;
                        let maker_order = &mut view.orders[head_node_idx];
                        let maker_seat = &mut *seats_ptr.add(maker_order.user_seat_idx as usize);

                        let match_qty = if taker_remaining < maker_order.quantity {
                            taker_remaining
                        } else {
                            maker_order.quantity
                        };

                        let trade_collateral = match_qty * (current_price as u64);
                        let fee = (trade_collateral * FEE_BASIS_POINTS) / 10_000;
                        let net_collateral = trade_collateral - fee;

                        let s_idx = seat_idx.ok_or(ProgramError::InsufficientFunds)?;
                        let taker_seat = &mut *seats_ptr.add(s_idx);

                        if args.outcome == 0 {
                            if taker_seat.ot_a_claimable < match_qty {
                                return Err(ProgramError::InsufficientFunds);
                            }
                            taker_seat.ot_a_claimable -= match_qty;
                            maker_seat.ot_a_claimable += match_qty;
                        } else {
                            if taker_seat.ot_b_claimable < match_qty {
                                return Err(ProgramError::InsufficientFunds);
                            }
                            taker_seat.ot_b_claimable -= match_qty;
                            maker_seat.ot_b_claimable += match_qty;
                        }

                        maker_seat.collateral_locked -= trade_collateral;
                        taker_mut.collateral_available += net_collateral;

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
                    }
                }
            } else {
                for current_price in 1..=args.price as usize {
                    if taker_remaining == 0 {
                        break;
                    }

                    let target_dir_index = 100 + current_price;
                    let level = &mut view.directory[target_dir_index];

                    while taker_remaining > 0 && level.head != 0 {
                        let head_node_idx = level.head as usize;
                        let maker_order = &mut view.orders[head_node_idx];
                        let maker_seat = &mut *seats_ptr.add(maker_order.user_seat_idx as usize);

                        let match_qty = if taker_remaining < maker_order.quantity {
                            taker_remaining
                        } else {
                            maker_order.quantity
                        };

                        let trade_collateral = match_qty * (current_price as u64);
                        let fee = (trade_collateral * FEE_BASIS_POINTS) / 10_000;
                        let net_collateral = trade_collateral - fee;

                        if taker_mut.collateral_available < trade_collateral {
                            return Err(ProgramError::InsufficientFunds);
                        }

                        maker_seat.collateral_claimable += net_collateral;
                        taker_mut.collateral_available -= trade_collateral;

                        let s_idx = seat_idx.unwrap();
                        let taker_seat = &mut *seats_ptr.add(s_idx);
                        if args.outcome == 0 {
                            taker_seat.ot_a_claimable += match_qty;
                        } else {
                            taker_seat.ot_b_claimable += match_qty;
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
                    }
                }
            }

            if taker_remaining > 0 {
                return Err(ProgramError::InvalidArgument);
            }
        }
    }

    Ok(())
}
