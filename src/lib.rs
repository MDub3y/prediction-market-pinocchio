#![no_std]

use pinocchio::{
    AccountView, Address, ProgramResult, error::ProgramError, no_allocator, nostd_panic_handler,
    program_entrypoint,
};

pub mod instructions;
pub mod log;
pub mod state;

program_entrypoint!(process_instruction);
nostd_panic_handler!();
no_allocator!();

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match discriminator {
        0 => instructions::create_market::process_create_market(program_id, accounts, rest),
        1 => instructions::initialize_orderbooks::process_initialize_orderbooks(
            program_id, accounts, rest,
        ),
        2 => {
            instructions::deposit_collateral::process_deposit_collateral(program_id, accounts, rest)
        }
        3 => instructions::place_order::process_place_order(program_id, accounts, rest),

        4 => instructions::cancel_order::process_cancel_order(program_id, accounts, rest),
        5 => instructions::claim_funds::process_claim_funds(program_id, accounts, rest),

        6 => instructions::resolve_market::process_resolve_market(program_id, accounts, rest),
        7 => instructions::claim_winning::process_claim_winnings(program_id, accounts, rest),
        8 => instructions::emergency_refund::process_emergency_refund(program_id, accounts, rest),

        9 => instructions::ping::process_ping(program_id, accounts, instruction_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
