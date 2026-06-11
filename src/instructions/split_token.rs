use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_token::instructions::MintTo;

use crate::state::{MarketState, PlatformUserState, SplitTokensArgs};

pub fn process_split_token(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        user,
        market_pda,
        platform_user_state,
        outcome_a_mint,
        outcome_b_mint,
        user_outcome_a,
        user_outcome_b,
        _token_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = SplitTokensArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let market_bump = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        if state.is_settled != 0 {
            return Err(ProgramError::InvalidArgument);
        }
        state.bump
    };

    let state_bump = unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
        if state.collateral_available < args.amount {
            return Err(ProgramError::InsufficientFunds);
        }
        state.bump
    };

    let bump_slice = [state_bump];
    let expected_state_seeds: &[&[u8]] = &[b"user_state", user.address().as_ref(), &bump_slice];
    let expected_state_pda = Address::create_program_address(expected_state_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;

    if platform_user_state.address() != &expected_state_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
        if state.collateral_available < args.amount {
            return Err(ProgramError::InsufficientFunds);
        }
    }

    unsafe {
        let user_data_mut = platform_user_state.borrow_unchecked_mut();
        let state_mut = &mut *(user_data_mut.as_mut_ptr() as *mut PlatformUserState);
        state_mut.collateral_available -= args.amount;
    }

    let market_id_bytes = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        state.market_id.to_le_bytes()
    };

    let market_seeds = [
        Seed::from(b"market"),
        Seed::from(market_id_bytes.as_ref()),
        Seed::from(core::slice::from_ref(&market_bump)),
    ];
    let market_signer = Signer::from(&market_seeds);

    MintTo::new(outcome_a_mint, user_outcome_a, market_pda, args.amount)
        .invoke_signed(&[market_signer.clone()])?;

    MintTo::new(outcome_b_mint, user_outcome_b, market_pda, args.amount)
        .invoke_signed(&[market_signer])?;

    Ok(())
}
