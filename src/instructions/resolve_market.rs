use crate::state::MarketState;
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

pub const TXLINE_PROGRAM_ID: Address = Address::new_from_array([
    0x56, 0x5c, 0x64, 0x1d, 0x93, 0x76, 0x82, 0xd8, 0x92, 0x4f, 0x6b, 0xec, 0x7f, 0x18, 0xda, 0x3d,
    0x42, 0x13, 0xaa, 0xd5, 0x76, 0x1b, 0x81, 0x98, 0x6e, 0x34, 0x7a, 0x22, 0xbc, 0x15, 0xee, 0x1a,
]);

pub fn process_resolve_market(
    _program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [keeper_signer, market_pda, txline_data_account, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !keeper_signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if txline_data_account.owner() != &TXLINE_PROGRAM_ID {
        return Err(ProgramError::InvalidAccountOwner);
    }

    let txline_raw_data = unsafe { txline_data_account.borrow_unchecked() };

    let target_match_id = u64::from_le_bytes(txline_raw_data[0..8].try_into().unwrap());
    let match_is_completed = txline_raw_data[8]; // 1 = Match Finished, 0 = In Progress
    let verified_winning_index = txline_raw_data[9]; // 0 = Home/Yes, 1 = Away/No

    if match_is_completed != 1 {
        return Err(ProgramError::Custom(301)); // Match has not concluded yet
    }

    unsafe {
        let data_mut = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_mut.as_mut_ptr() as *mut MarketState);

        if state_mut.market_status != 1 || state_mut.is_settled != 0 {
            return Err(ProgramError::InvalidArgument);
        }

        if state_mut.market_id != target_match_id {
            return Err(ProgramError::Custom(302));
        }

        state_mut.is_settled = 1;
        state_mut.winning_outcome = verified_winning_index;
        state_mut.market_status = 2; // Move state variable flag to Settled
    }

    pinocchio_log::log!(
        "🎉 [Alley]: Market finalized trustlessly via verifiable data receipt parameters!"
    );
    Ok(())
}
