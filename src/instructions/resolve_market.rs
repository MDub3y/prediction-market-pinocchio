use crate::state::MarketState;
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub fn process_resolve_market(
    _program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [oracle_signer, market_pda, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !oracle_signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let winning_outcome = *instruction_data
        .first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    if winning_outcome > 1 {
        return Err(ProgramError::InvalidArgument);
    }

    // Mutate the on-chain state to lock down trading and enable redemption channels
    unsafe {
        let mut data_mut = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_mut.as_mut_ptr() as *mut MarketState);

        if state_mut.market_status != 1 || state_mut.is_settled != 0 {
            return Err(ProgramError::InvalidArgument);
        }

        // Verify the caller matches the designated oracle authority
        if state_mut.oracle_authority != *oracle_signer.address() {
            return Err(ProgramError::IncorrectAuthority);
        }

        state_mut.is_settled = 1;
        state_mut.winning_outcome = winning_outcome;
        state_mut.market_status = 2; // Mutate status to 2 (Settled)
    }

    Ok(())
}
