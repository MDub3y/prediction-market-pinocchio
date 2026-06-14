use crate::state::{
    MarketUserState, PlatformUserState,
};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub fn process_claim_funds(
    program_id: &Address,
    accounts: &mut [AccountView],
    _instruction_data: &[u8],
) -> ProgramResult {
    let [user, platform_user_state, market_user_state, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if platform_user_state.data_len() < PlatformUserState::LEN
        || market_user_state.data_len() < MarketUserState::LEN
    {
        return Err(ProgramError::InvalidAccountData);
    }

    let platform_bump = unsafe {
        let user_data = platform_user_state.borrow_unchecked();
        let state = PlatformUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address() {
            return Err(ProgramError::IncorrectAuthority);
        }
        state.bump
    };
    let p_bump_slice = [platform_bump];
    let expected_platform_pda = Address::create_program_address(
        &[b"user_state", user.address().as_ref(), &p_bump_slice],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;

    if platform_user_state.address() != &expected_platform_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let market_user_bump = unsafe {
        let user_data = market_user_state.borrow_unchecked();
        let state = MarketUserState::from_bytes(&user_data)?;
        if state.wallet != *user.address()
            || state.platform_user_state != *platform_user_state.address()
        {
            return Err(ProgramError::IncorrectAuthority);
        }
        state.bump
    };

    let market_pda_address = unsafe {
        let user_data = market_user_state.borrow_unchecked();
        MarketUserState::from_bytes(&user_data)?.market_pda.clone()
    };

    let m_bump_slice = [market_user_bump];
    let expected_market_user_pda = Address::create_program_address(
        &[
            b"market_user",
            market_pda_address.as_ref(),
            user.address().as_ref(),
            &m_bump_slice,
        ],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;

    if market_user_state.address() != &expected_market_user_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    unsafe {
        let market_data_mut = market_user_state.borrow_unchecked_mut();
        let market_state_mut = &mut *(market_data_mut.as_mut_ptr() as *mut MarketUserState);

        let claimable_amount = market_state_mut.collateral_claimable;
        if claimable_amount > 0 {
            let platform_data_mut = platform_user_state.borrow_unchecked_mut();
            let platform_state_mut =
                &mut *(platform_data_mut.as_mut_ptr() as *mut PlatformUserState);

            platform_state_mut.collateral_available += claimable_amount;
            market_state_mut.collateral_claimable = 0;
        }
    }

    Ok(())
}
