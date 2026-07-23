extern crate alloc;
use alloc::string::ToString;

use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token_2022::instructions::{
    InitializeMint2, metadata_pointer::Initialize as InitializeMetadataPointer,
};
use solana_instruction_view::{InstructionAccount, InstructionView, cpi::invoke};

pub fn process_ping(
    _program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    pinocchio_log::log!("📡 [Alley Ping]: Commencing diagnostic isolation test execution loop...");

    let [
        payer,
        diagnostic_mint,
        system_program,
        token_2022_program,
        rent_sysvar,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() || !diagnostic_mint.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if instruction_data.len() < 15 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Slice off the first byte discriminator since the entrypoint passes the entire vector
    let payload = &instruction_data[1..];

    let name_len = u16::from_le_bytes(payload[0..2].try_into().unwrap()) as usize;
    let symbol_len = u16::from_le_bytes(payload[2..4].try_into().unwrap()) as usize;
    let uri_len = u16::from_le_bytes(payload[4..6].try_into().unwrap()) as usize;
    let rent_lamports = u64::from_le_bytes(payload[6..14].try_into().unwrap());

    let mut offset = 14;
    let name = core::str::from_utf8(&payload[offset..offset + name_len])
        .map_err(|_| ProgramError::InvalidInstructionData)?
        .to_string();
    offset += name_len;

    let symbol = core::str::from_utf8(&payload[offset..offset + symbol_len])
        .map_err(|_| ProgramError::InvalidInstructionData)?
        .to_string();
    offset += symbol_len;

    let uri = core::str::from_utf8(&payload[offset..offset + uri_len])
        .map_err(|_| ProgramError::InvalidInstructionData)?
        .to_string();

    // Token-2022 Perfect Aligned Allocation Footprint Formula
    let total_account_space = 234 + 85 + name_len + symbol_len + uri_len;
    let aligned_space = (total_account_space + 7) & !7;

    solana_program::msg!("📊 Aligned Space Allocation: {} bytes", aligned_space);

    // 1. Initialize Base Storage Account
    CreateAccount {
        from: payer,
        to: diagnostic_mint,
        lamports: rent_lamports,
        space: aligned_space as u64,
        owner: token_2022_program.address(),
    }
    .invoke()?;

    // 2. Initialize Metadata Pointer Extension
    InitializeMetadataPointer {
        mint: diagnostic_mint,
        authority: Some(payer.address()),
        metadata_address: Some(diagnostic_mint.address()),
        token_program: token_2022_program.address(),
    }
    .invoke()?;

    // 3. Initialize Base Mint State Parameters
    InitializeMint2 {
        mint: diagnostic_mint,
        decimals: 6,
        mint_authority: payer.address(),
        freeze_authority: Some(payer.address()),
        token_program: token_2022_program.address(),
    }
    .invoke()?;

    // 4. Initialize Variable Length Metadata inside TLV Blocks
    let spl_ix = spl_token_metadata_interface::instruction::initialize(
        token_2022_program.address(),
        diagnostic_mint.address(),
        payer.address(),
        diagnostic_mint.address(),
        payer.address(),
        name,
        symbol,
        uri,
    );

    let accounts_view = [
        InstructionAccount::writable(diagnostic_mint.address()),
        InstructionAccount::readonly(payer.address()),
        InstructionAccount::readonly(diagnostic_mint.address()),
        InstructionAccount::readonly(payer.address()),
    ];

    invoke(
        &InstructionView {
            program_id: token_2022_program.address(),
            accounts: &accounts_view,
            data: &spl_ix.data,
        },
        &[&*diagnostic_mint, &*payer, &*diagnostic_mint, &*payer],
    )?;

    pinocchio_log::log!("🚀 [Alley Ping Success]: Diagnostic token lifecycle completed!");
    Ok(())
}
