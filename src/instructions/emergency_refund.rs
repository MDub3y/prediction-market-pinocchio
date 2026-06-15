use crate::state::{MarketState, MarketUserState, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError, sysvars::clock::Clock};
use solana_instruction_view::{InstructionAccount, InstructionView, cpi::invoke};

pub fn process_emergency_refund(
    _program_id: &Address,
    accounts: &mut [AccountView],
    _instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let accounts_ptr = accounts.as_mut_ptr();
    let (
        user,
        market_pda,
        platform_user_state,
        market_user_state,
        outcome_a_mint,
        outcome_b_mint,
        user_ata_a,
        user_ata_b,
        token_program_2022,
        clock_sysvar,
    ) = unsafe {
        (
            &mut *accounts_ptr.add(0),
            &mut *accounts_ptr.add(1),
            &mut *accounts_ptr.add(2),
            &mut *accounts_ptr.add(3),
            &mut *accounts_ptr.add(4),
            &mut *accounts_ptr.add(5),
            &mut *accounts_ptr.add(6),
            &mut *accounts_ptr.add(7),
            &mut *accounts_ptr.add(8),
            &mut *accounts_ptr.add(9),
        )
    };

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;

        let clock_data = clock_sysvar.borrow_unchecked();
        let clock = &*(clock_data.as_ptr() as *const Clock);

        if state.is_settled != 0 || clock.unix_timestamp <= (state.settlement_deadline + 604_800) {
            return Err(ProgramError::InvalidArgument);
        }
    }

    let mut total_a = 0u64;
    let ext_a = if user_ata_a.data_len() > 0 {
        unsafe {
            let data_a = user_ata_a.borrow_unchecked();
            u64::from_le_bytes(data_a[64..72].try_into().unwrap())
        }
    } else {
        0
    };
    total_a += ext_a;

    let int_a = unsafe {
        (*(market_user_state.borrow_unchecked().as_ptr() as *const MarketUserState)).ot_a_balance
    };
    total_a += int_a;

    let mut total_b = 0u64;
    let ext_b = if user_ata_b.data_len() > 0 {
        unsafe {
            let data_b = user_ata_b.borrow_unchecked();
            u64::from_le_bytes(data_b[64..72].try_into().unwrap())
        }
    } else {
        0
    };
    total_b += ext_b;

    let int_b = unsafe {
        (*(market_user_state.borrow_unchecked().as_ptr() as *const MarketUserState)).ot_b_balance
    };
    total_b += int_b;

    let refund_amount = if total_a < total_b { total_a } else { total_b };
    if refund_amount == 0 {
        return Err(ProgramError::InsufficientFunds);
    }

    let mut remaining_a_to_burn = refund_amount;
    if ext_a > 0 && remaining_a_to_burn > 0 {
        let burn_ext_a = if remaining_a_to_burn < ext_a {
            remaining_a_to_burn
        } else {
            ext_a
        };
        let mut payload_a = [0u8; 9];
        payload_a[0] = 8;
        payload_a[1..9].copy_from_slice(&burn_ext_a.to_le_bytes());

        invoke(
            &InstructionView {
                program_id: token_program_2022.address(),
                accounts: &[
                    InstructionAccount::writable(user_ata_a.address()),
                    InstructionAccount::writable(outcome_a_mint.address()),
                    InstructionAccount::readonly(user.address()),
                ],
                data: &payload_a,
            },
            &[&*user_ata_a, &*outcome_a_mint, &*user],
        )?;
        remaining_a_to_burn -= burn_ext_a;
    }

    let mut remaining_b_to_burn = refund_amount;
    if ext_b > 0 && remaining_b_to_burn > 0 {
        let burn_ext_b = if remaining_b_to_burn < ext_b {
            remaining_b_to_burn
        } else {
            ext_b
        };
        let mut payload_b = [0u8; 9];
        payload_b[0] = 8;
        payload_b[1..9].copy_from_slice(&burn_ext_b.to_le_bytes());

        invoke(
            &InstructionView {
                program_id: token_program_2022.address(),
                accounts: &[
                    InstructionAccount::writable(user_ata_b.address()),
                    InstructionAccount::writable(outcome_b_mint.address()),
                    InstructionAccount::readonly(user.address()),
                ],
                data: &payload_b,
            },
            &[&*user_ata_b, &*outcome_b_mint, &*user],
        )?;
        remaining_b_to_burn -= burn_ext_b;
    }

    unsafe {
        let mut m_data = market_user_state.borrow_unchecked_mut();
        let market_user = &mut *(m_data.as_mut_ptr() as *mut MarketUserState);
        market_user.ot_a_balance -= remaining_a_to_burn;
        market_user.ot_b_balance -= remaining_b_to_burn;

        let mut p_data = platform_user_state.borrow_unchecked_mut();
        let platform_user = &mut *(p_data.as_mut_ptr() as *mut PlatformUserState);
        platform_user.collateral_available += refund_amount;
    }

    Ok(())
}
