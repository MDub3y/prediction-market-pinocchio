pub mod limit;
pub mod market;
pub mod merge;
pub mod split;

use crate::state::{MarketState, MarketUserState, PlaceOrderArgs};
use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

pub fn process_place_order(
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
        system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::MissingRequiredSignature);
    };

    let args = PlaceOrderArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // 1. AUTO-INITIALIZATION: Instantiate MarketUserState if it does not exist yet
    if market_user_state.data_len() == 0 {
        let bump_slice = [args.bump_market_user];
        let pda_signer_seeds = [
            Seed::from(b"market_user"),
            Seed::from(market_pda.address().as_ref()),
            Seed::from(user.address().as_ref()),
            Seed::from(&bump_slice),
        ];

        CreateAccount {
            from: user,
            to: market_user_state,
            lamports: market_user_state.lamports(),
            space: MarketUserState::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&pda_signer_seeds)])?;

        unsafe {
            let user_data_mut = market_user_state.borrow_unchecked_mut();
            let state_mut = &mut *(user_data_mut.as_mut_ptr() as *mut MarketUserState);
            state_mut.wallet = user.address().clone();
            state_mut.market_pda = market_pda.address().clone();
            state_mut.platform_user_state = platform_user_state.address().clone();
            state_mut.ot_a_balance = 0;
            state_mut.ot_b_balance = 0;
            state_mut.collateral_claimable = 0;
            state_mut.bump = args.bump_market_user;
        }
    }

    match args.order_type {
        0 => limit::execute_limit_order(accounts, &args),
        1 => market::execute_market_order(accounts, &args),
        2 => split::execute_split_operation(accounts, &args),
        3 => merge::execute_merge_operation(accounts, &args),
        _ => Err(ProgramError::InvalidArgument),
    }
}
