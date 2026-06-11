use crate::state::{MarketState, MergeTokensArgs, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};
use pinocchio_token::instructions::Burn;

pub fn process_merge_token(
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

    let args = MergeTokensArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;
        if state.is_settled != 0 {
            return Err(ProgramError::InvalidArgument);
        }
    }

    let state_bump = unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
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

    Burn::new(user_outcome_a, outcome_a_mint, user, args.amount).invoke()?;
    Burn::new(user_outcome_b, outcome_b_mint, user, args.amount).invoke()?;

    unsafe {
        let user_data_mut = platform_user_state.borrow_unchecked_mut();
        let state_mut = &mut *(user_data_mut.as_mut_ptr() as *mut PlatformUserState);
        state_mut.collateral_available += args.amount;
    }

    Ok(())
}
