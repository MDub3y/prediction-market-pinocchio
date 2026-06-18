use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token_2022::instructions::InitializeMint2;

pub fn process_ping(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let message_bytes = &instruction_data[1..];
    if let Ok(message_str) = core::str::from_utf8(message_bytes) {
        // Log the message dynamic input sent from the frontend!
        pinocchio_log::log!("Frontend Message: {}", message_str);
    } else {
        pinocchio_log::log!("Failed to parse custom message string.");
    }

    pinocchio_log::log!("Starting Complex Account Creation");

    let [
        payer,
        new_system_account,
        pda_account,
        mint_account,
        system_program,
        token_2022_program,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    pinocchio_log::log!("Step 1: creating generic system account...");
    let lamports_for_sys = 2_000_000;

    CreateAccount {
        from: payer,
        to: new_system_account,
        lamports: lamports_for_sys,
        space: 32,
        owner: program_id,
    }
    .invoke()?;

    pinocchio_log::log!("Step 2: initializing PDA account...");
    let lamports_for_pda = 1_500_000;

    let seed_str = b"example_pda_seed";

    let (expected_pda, bump) = Address::find_program_address(&[seed_str], program_id);
    if pda_account.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let bump_binding = [bump];

    let signer_seeds = &[Seed::from(seed_str), Seed::from(&bump_binding)];

    CreateAccount {
        from: payer,
        to: pda_account,
        lamports: lamports_for_pda,
        space: 64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(signer_seeds)])?;

    pinocchio_log::log!("Step 3: Creating Mint & Assigning PDA Authority...");

    let lamports_for_mint = 2_500_000;

    CreateAccount {
        from: payer,
        to: mint_account,
        lamports: lamports_for_mint,
        space: 82,
        owner: token_2022_program.address(),
    }
    .invoke()?;

    InitializeMint2 {
        mint: mint_account,
        mint_authority: pda_account.address(),
        freeze_authority: None,
        decimals: 9,
        token_program: token_2022_program.address(),
    }
    .invoke()?;

    pinocchio_log::log!("All operations executed succcessfully!");

    Ok(())
}
