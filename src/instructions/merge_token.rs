use crate::state::{MarketState, MergeTokensArgs, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};
use pinocchio_token::instructions::Burn;

pub fn process_merge_tokens(
    _program_id: &Address,
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

    unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
    }

    Burn::new(outcome_a_mint, user_outcome_a, user, args.amount).invoke()?;
    Burn::new(outcome_b_mint, user_outcome_b, user, args.amount).invoke()?;

    unsafe {
        let user_data_mut = platform_user_state.borrow_unchecked_mut();
        let state_mut = &mut *(user_data_mut.as_mut_ptr() as *mut PlatformUserState);
        state_mut.collateral_available += args.amount;
    }

    Ok(())
}
