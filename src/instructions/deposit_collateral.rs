use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::state::{DepositCollateralArgs, PlatformUserState};

pub fn process_deposit_collateral(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        user,
        platform_user_state,
        user_token_account,
        collateral_vault,
        _system_program,
        token_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = DepositCollateralArgs::from_bytes(instruction_data)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // The Transfer CPI below is hardcoded to the legacy Token program (`pinocchio_token`),
    // so the passed `token_program` account MUST actually be it — otherwise the client
    // has a mint/vault under a different token program than the one this instruction can
    // ever move funds through, which used to fail confusingly deep inside the CPI instead
    // of with a clear error here.
    if token_program.address() != &pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let state_raw_seeds: &[&[u8]] = &[
        b"user_state",
        user.address().as_ref(),
        &[args.bump_user_state],
    ];
    let expected_state_pda = Address::create_program_address(state_raw_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if platform_user_state.address() != &expected_state_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    if platform_user_state.data_len() == 0 {
        let label = b"user_state";
        let bump_slice = [args.bump_user_state];
        let state_signer_seeds = [
            Seed::from(label.as_ref()),
            Seed::from(user.address().as_ref()),
            Seed::from(bump_slice.as_ref()),
        ];

        CreateAccount {
            from: user,
            to: platform_user_state,
            lamports: 1_500_000,
            space: PlatformUserState::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&state_signer_seeds)])?;

        unsafe {
            let data_slice = platform_user_state.borrow_unchecked_mut();
            let pos_mut = &mut *(data_slice.as_mut_ptr() as *mut PlatformUserState);
            pos_mut.wallet = user.address().clone();
            pos_mut.collateral_available = 0;
            pos_mut.bump = args.bump_user_state;
        }
    }

    Transfer::new(user_token_account, collateral_vault, user, args.amount).invoke()?;

    unsafe {
        let data_slice = platform_user_state.borrow_unchecked_mut();
        let pos_mut = &mut *(data_slice.as_mut_ptr() as *mut PlatformUserState);
        pos_mut.collateral_available += args.amount;
    }

    Ok(())
}
