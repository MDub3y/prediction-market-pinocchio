use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

use crate::state::{Order, OrderPage, PlaceOrderArgs, UserMarketPosition};

pub fn process_place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        user,
        market_pda,
        user_market_position,
        order_page,
        _system_program,
        ..,
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

    if order_page.address() != &expected_page_address {
        return Err(ProgramError::InvalidSeeds);
    }

    if order_page.data_len() == 0 {
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
            to: order_page,
            lamports: order_page.lamports(),
            space: OrderPage::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[page_signer])?;

        unsafe {
            let mut data_slice = order_page.borrow_unchecked_mut();
            let page_mut = &mut *(data_slice.as_mut_ptr() as *mut OrderPage);
            page_mut.head = 0;
            page_mut.tail = 0;
            page_mut.price = args.price;
            page_mut.side = args.side;
            page_mut.outcome = args.outcome;
            page_mut.padding = 0;
        }
    }

    if args.order_type == 0 {
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
            let mut page_data = order_page.borrow_unchecked_mut();
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
        return Err(ProgramError::Custom(101));
    }

    Ok(())
}
