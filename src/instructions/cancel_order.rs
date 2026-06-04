use crate::state::{CancelOrderArgs, MarketState, MarketTier, OrderBookView, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub fn process_cancel_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [user, market_pda, platform_user_state, orderbook, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = CancelOrderArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
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
        let mut book_data = orderbook.borrow_unchecked_mut();
        let mut view = OrderBookView::load(book_data.as_mut_ptr(), tier);

        let target_node_idx = args.order_node_idx as usize;
        if target_node_idx >= view.orders.len() {
            return Err(ProgramError::InvalidArgument);
        }

        let node_user_seat_idx = view.orders[target_node_idx].user_seat_idx;
        let node_next_idx = view.orders[target_node_idx].next_idx;
        let node_quantity = view.orders[target_node_idx].quantity;
        let node_order_id = view.orders[target_node_idx].order_id;

        let maker_seat = &mut view.seats[node_user_seat_idx as usize];

        if maker_seat.wallet != *user.address() || node_order_id != args.order_id {
            return Err(ProgramError::InvalidArgument);
        }

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

        let mut user_data = platform_user_state.borrow_unchecked_mut();
        let user_mut = &mut *(user_data.as_mut_ptr() as *mut PlatformUserState);

        if args.side == 0 {
            let refund_collateral = node_quantity * (args.price as u64);
            maker_seat.collateral_locked -= refund_collateral;
            user_mut.collateral_available += refund_collateral;
        } else {
            if args.outcome == 0 {
                maker_seat.ot_a_locked -= node_quantity;
                maker_seat.ot_a_claimable += node_quantity;
            } else {
                maker_seat.ot_b_locked -= node_quantity;
                maker_seat.ot_b_claimable += node_quantity;
            }
        }

        let mut_node = &mut view.orders[target_node_idx];
        mut_node.quantity = 0;
        mut_node.order_id = 0;
        mut_node.user_seat_idx = 0;
        mut_node.next_idx = view.header.next_free_node_idx;
        view.header.next_free_node_idx = args.order_node_idx;
    }

    Ok(())
}
