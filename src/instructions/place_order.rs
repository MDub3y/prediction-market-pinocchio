use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

use crate::state::{MarketState, OrderPage, PlaceOrderArgs, UserMarketPosition};

const FEE_BASIS_POINTS: u64 = 20;

pub fn process_place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        user,
        market_pda,
        user_market_position,
        system_program,
        remaining_accounts @ ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = PlaceOrderArgs::from_bytes(instruction_data)?;

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    unsafe {
        let data = user_market_position.borrow_unchecked();
        let pos = UserMarketPosition::from_bytes(&data)?;
        if pos.user_wallet != *user.address() || pos.market_pda != *market_pda.address() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    if (args.num_pages as usize) > remaining_accounts.len() {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (pages, makers) = remaining_accounts.split_at_mut(args.num_pages as usize);

    if args.order_type == 0 {
        if pages.is_empty() {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let target_page = &mut pages[0];

        let price_slice = [args.price];
        let side_slice = [args.side];
        let outcome_slice = [args.outcome];
        let bump_slice = [args.bump_order_page];

        let page_raw_seeds: &[&[u8]] = &[
            b"order_page",
            market_pda.address().as_ref(),
            &outcome_slice,
            &side_slice,
            &price_slice,
            &bump_slice,
        ];
        let expected_page_address = Address::create_program_address(page_raw_seeds, program_id)
            .map_err(|_| ProgramError::InvalidSeeds)?;

        if target_page.address() != &expected_page_address {
            return Err(ProgramError::InvalidSeeds);
        }

        if target_page.data_len() == 0 {
            let page_signer_seeds = [
                Seed::from(b"order_page"),
                Seed::from(market_pda.address().as_ref()),
                Seed::from(outcome_slice.as_ref()),
                Seed::from(side_slice.as_ref()),
                Seed::from(price_slice.as_ref()),
                Seed::from(bump_slice.as_ref()),
            ];
            let page_signer = Signer::from(&page_signer_seeds);

            CreateAccount {
                from: user,
                to: target_page,
                lamports: target_page.lamports(),
                space: OrderPage::LEN as u64,
                owner: program_id,
            }
            .invoke_signed(&[page_signer])?;

            unsafe {
                let mut data_slice = target_page.borrow_unchecked_mut();
                let page_mut = &mut *(data_slice.as_mut_ptr() as *mut OrderPage);
                page_mut.head = 0;
                page_mut.tail = 0;
                page_mut.price = args.price;
                page_mut.side = args.side;
                page_mut.outcome = args.outcome;
                page_mut.padding = 0;
            }
        }

        unsafe {
            let mut pos_data = user_market_position.borrow_unchecked_mut();
            let pos_mut = &mut *(pos_data.as_mut_ptr() as *mut UserMarketPosition);

            if args.side == 0 {
                let total_cost = args.quantity * (args.price as u64);
                if pos_mut.collateral_available < total_cost {
                    return Err(ProgramError::InsufficientFunds);
                }
                pos_mut.collateral_available -= total_cost;
                pos_mut.collateral_locked += total_cost;
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
        }

        unsafe {
            let mut page_data = target_page.borrow_unchecked_mut();
            let page_mut = &mut *(page_data.as_mut_ptr() as *mut OrderPage);

            let current_tail = page_mut.tail;
            let next_tail = (current_tail + 1) % OrderPage::MAX_ORDERS;

            if next_tail == page_mut.head {
                return Err(ProgramError::InvalidArgument);
            }

            let order_slot = &mut page_mut.orders[current_tail as usize];
            order_slot.user_position = user_market_position.address().clone();
            order_slot.quantity = args.quantity;
            order_slot.order_id = args.order_id;

            page_mut.tail = next_tail;
        }
    } else {
        let mut taker_remaining_qty = args.quantity;
        let mut last_processed_price: Option<u8> = None;

        unsafe {
            let mut market_data = market_pda.borrow_unchecked_mut();
            let market_mut = &mut *(market_data.as_mut_ptr() as *mut MarketState);

            let mut taker_pos_data = user_market_position.borrow_unchecked_mut();
            let taker_pos_mut = &mut *(taker_pos_data.as_mut_ptr() as *mut UserMarketPosition);

            for page_account in pages.iter_mut() {
                if taker_remaining_qty == 0 {
                    break;
                }

                if page_account.data_len() == 0 {
                    continue;
                }

                let mut page_data = page_account.borrow_unchecked_mut();
                let page_mut = &mut *(page_data.as_mut_ptr() as *mut OrderPage);

                if page_mut.outcome != args.outcome {
                    return Err(ProgramError::InvalidArgument);
                }
                if args.side == 0 && page_mut.side != 1 {
                    return Err(ProgramError::InvalidArgument);
                }
                if args.side == 1 && page_mut.side != 0 {
                    return Err(ProgramError::InvalidArgument);
                }

                if let Some(prev_price) = last_processed_price {
                    if args.side == 0 && page_mut.price < prev_price {
                        return Err(ProgramError::InvalidArgument);
                    }
                    if args.side == 1 && page_mut.price > prev_price {
                        return Err(ProgramError::InvalidArgument);
                    }
                }
                last_processed_price = Some(page_mut.price);

                while taker_remaining_qty > 0 && page_mut.head != page_mut.tail {
                    let current_head = page_mut.head as usize;
                    let maker_order = &mut page_mut.orders[current_head];

                    let mut maker_account_found = false;
                    for account in makers.iter_mut() {
                        if account.address() == &maker_order.user_position {
                            maker_account_found = true;

                            let mut maker_pos_data = account.borrow_unchecked_mut();
                            let maker_pos_mut =
                                &mut *(maker_pos_data.as_mut_ptr() as *mut UserMarketPosition);

                            let match_qty = if taker_remaining_qty < maker_order.quantity {
                                taker_remaining_qty
                            } else {
                                maker_order.quantity
                            };

                            let collateral_value = match_qty * (page_mut.price as u64);
                            let fee_deduction = (collateral_value * FEE_BASIS_POINTS) / 10_000;
                            let net_collateral = collateral_value - fee_deduction;

                            if args.side == 0 {
                                // Taker is Buyer (Bid) vs Maker resting Seller (Ask)
                                if taker_pos_mut.collateral_available < collateral_value {
                                    return Err(ProgramError::InsufficientFunds);
                                }

                                if page_mut.outcome == 0 {
                                    maker_pos_mut.ot_a_locked -= match_qty;
                                } else {
                                    maker_pos_mut.ot_b_locked -= match_qty;
                                }
                                maker_pos_mut.collateral_available += net_collateral;

                                taker_pos_mut.collateral_available -= collateral_value;
                                if page_mut.outcome == 0 {
                                    taker_pos_mut.ot_a_available += match_qty;
                                } else {
                                    taker_pos_mut.ot_b_available += match_qty;
                                }
                            } else {
                                // Taker is Seller (Ask) vs Maker resting Buyer (Bid)
                                if page_mut.outcome == 0 {
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

                                maker_pos_mut.collateral_locked -= collateral_value;
                                if page_mut.outcome == 0 {
                                    maker_pos_mut.ot_a_available += match_qty;
                                } else {
                                    maker_pos_mut.ot_b_available += match_qty;
                                }

                                taker_pos_mut.collateral_available += net_collateral;
                            }

                            market_mut.accumulated_fees += fee_deduction;

                            taker_remaining_qty -= match_qty;
                            maker_order.quantity -= match_qty;

                            if maker_order.quantity == 0 {
                                page_mut.head = (page_mut.head + 1) % OrderPage::MAX_ORDERS;
                            }
                            break;
                        }
                    }

                    if !maker_account_found {
                        return Err(ProgramError::NotEnoughAccountKeys);
                    }
                }
            }
        }

        if taker_remaining_qty > 0 {
            return Err(ProgramError::InvalidArgument);
        }
    }
    Ok(())
}
