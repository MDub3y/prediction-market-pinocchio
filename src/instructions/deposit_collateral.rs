use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::state::{DepositCollateralArgs, UserMarketPosition};

pub fn process_deposit_collateral(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        user,
        market_pda,
        user_market_position,
        user_token_account,
        collateral_vault,
        _system_program,
        _token_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = DepositCollateralArgs::from_bytes(instruction_data)?;

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let position_raw_seeds: &[&[u8]] = &[
        b"user_position",
        market_pda.address().as_ref(),
        user.address().as_ref(),
        &[args.bump_user_position],
    ];
    let expected_position_pda = Address::create_program_address(position_raw_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;

    if user_market_position.address() != &expected_position_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    if user_market_position.data_len() == 0 {
        let label = b"user_position";
        let bump_slice = [args.bump_user_position];

        let position_signer_seeds = [
            Seed::from(label.as_ref()),
            Seed::from(market_pda.address().as_ref()),
            Seed::from(user.address().as_ref()),
            Seed::from(bump_slice.as_ref()),
        ];
        let position_signer = Signer::from(&position_signer_seeds);

        CreateAccount {
            from: user,
            to: user_market_position,
            lamports: user_market_position.lamports(),
            space: UserMarketPosition::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[position_signer])?;

        unsafe {
            let mut data_slice = user_market_position.borrow_unchecked_mut();
            let pos_mut = &mut *(data_slice.as_mut_ptr() as *mut UserMarketPosition);
            pos_mut.user_wallet = user.address().clone();
            pos_mut.market_pda = market_pda.address().clone();
            pos_mut.collateral_available = 0;
            pos_mut.collateral_locked = 0;
            pos_mut.ot_a_available = 0;
            pos_mut.ot_a_locked = 0;
            pos_mut.ot_b_available = 0;
            pos_mut.ot_b_locked = 0;
            pos_mut.bump = args.bump_user_position;
        }
    }

    Transfer::new(user_token_account, collateral_vault, user, args.amount).invoke()?;

    unsafe {
        let mut data_slice = user_market_position.borrow_unchecked_mut();
        let pos_mut = &mut *(data_slice.as_mut_ptr() as *mut UserMarketPosition);
        pos_mut.collateral_available += args.amount;
    }

    Ok(())
}
