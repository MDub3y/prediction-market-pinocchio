use crate::state::{MarketState, MarketUserState, PlatformUserState};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};
use solana_instruction_view::{InstructionAccount, InstructionView, cpi::invoke};

pub fn process_claim_winnings(
    _program_id: &Address,
    accounts: &mut [AccountView],
    _instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let accounts_ptr = accounts.as_mut_ptr();
    let (
        user,
        market_pda,
        platform_user_state,
        market_user_state,
        winning_mint,
        user_token_account,
        token_program_2022,
    ) = unsafe {
        (
            &mut *accounts_ptr.add(0),
            &mut *accounts_ptr.add(1),
            &mut *accounts_ptr.add(2),
            &mut *accounts_ptr.add(3),
            &mut *accounts_ptr.add(4),
            &mut *accounts_ptr.add(5),
            &mut *accounts_ptr.add(6),
        )
    };

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let winning_mint_target = unsafe {
        let data = market_pda.borrow_unchecked();
        let state = MarketState::from_bytes(&data)?;

        if state.market_status != 2 || state.is_settled != 1 {
            return Err(ProgramError::InvalidArgument);
        }
        if state.winning_outcome == 0 {
            state.outcome_a_mint.clone()
        } else {
            state.outcome_b_mint.clone()
        }
    };

    if *winning_mint.address() != winning_mint_target {
        return Err(ProgramError::InvalidArgument);
    }

    let mut total_winnings_to_credit = 0u64;

    let external_balance = if user_token_account.data_len() > 0 {
        unsafe {
            let user_token_data = user_token_account.borrow_unchecked();
            u64::from_le_bytes(user_token_data[64..72].try_into().unwrap())
        }
    } else {
        0
    };

    if external_balance > 0 {
        let mut burn_payload = [0u8; 9];
        burn_payload[0] = 8; // Token-2022 Discriminator: Burn
        burn_payload[1..9].copy_from_slice(&external_balance.to_le_bytes());

        invoke(
            &InstructionView {
                program_id: token_program_2022.address(),
                accounts: &[
                    InstructionAccount::writable(user_token_account.address()),
                    InstructionAccount::writable(winning_mint.address()),
                    InstructionAccount::readonly(user.address()),
                ],
                data: &burn_payload,
            },
            &[&*user_token_account, &*winning_mint, &*user],
        )?;
        total_winnings_to_credit += external_balance;
    }

    unsafe {
        let mut m_data = market_user_state.borrow_unchecked_mut();
        let market_user = &mut *(m_data.as_mut_ptr() as *mut MarketUserState);

        if winning_mint_target == market_user.market_pda {
            if market_user.ot_a_balance > 0 {
                total_winnings_to_credit += market_user.ot_a_balance;
                market_user.ot_a_balance = 0;
            }
        } else {
            if market_user.ot_b_balance > 0 {
                total_winnings_to_credit += market_user.ot_b_balance;
                market_user.ot_b_balance = 0;
            }
        }
    }

    if total_winnings_to_credit == 0 {
        return Err(ProgramError::InsufficientFunds);
    }

    unsafe {
        let mut p_data = platform_user_state.borrow_unchecked_mut();
        let platform_user = &mut *(p_data.as_mut_ptr() as *mut PlatformUserState);
        platform_user.collateral_available += total_winnings_to_credit;
    }

    Ok(())
}
