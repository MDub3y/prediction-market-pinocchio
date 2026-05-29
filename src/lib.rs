#![no_std]

use pinocchio::{
    AccountView, Address, ProgramResult, error::ProgramError, no_allocator, nostd_panic_handler,
    program_entrypoint,
};

pub mod instructions;
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
        0 => instructions::create_market::process_create_market(
            program_id,
            accounts,
            instruction_data,
        ),
        _ => Err(ProgramError::InvalidInstructionData),
    };

    Ok(())
}
