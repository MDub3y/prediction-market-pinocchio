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

#[repr(C)]
pub struct PingMintArgs {
    pub name_len: u16,
    pub symbol_len: u16,
    pub uri_len: u16,
    pub rent_lamports: u64,
}

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
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() || !diagnostic_mint.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Unpack lengths from the first 14 bytes of the data stream
    if instruction_data.len() < 15 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Skip the first byte (the instruction discriminator '9')
    let payload = &instruction_data[1..];

    let name_len = u16::from_le_bytes(payload[0..2].try_into().unwrap()) as usize;
    let symbol_len = u16::from_le_bytes(payload[2..4].try_into().unwrap()) as usize;
    let uri_len = u16::from_le_bytes(payload[4..6].try_into().unwrap()) as usize;
    let rent_lamports = u64::from_le_bytes(payload[6..14].try_into().unwrap());

    let mut offset = 14;
    let name = core::str::from_utf8(&payload[offset..offset + name_len])
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    offset += name_len;

    let symbol = core::str::from_utf8(&payload[offset..offset + symbol_len])
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    offset += symbol_len;

    let uri = core::str::from_utf8(&payload[offset..offset + uri_len])
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    solana_program::msg!(
        "🔍 [Ping Target] Name: '{}', Symbol: '{}', URI: '{}'",
        name,
        symbol,
        uri
    );

    // Calculate the precise, unpadded byte length required by Token-2022
    // ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::MetadataPointer]) maps exactly to 234 bytes
    let total_account_space = 234 + 85 + name_len + symbol_len + uri_len;
    let aligned_space = (total_account_space + 7) & !7;

    solana_program::msg!(
        "📊 [Ping Sizing] Raw Space Needed: {}, Aligned Target Space Allocation: {}",
        total_account_space,
        aligned_space
    );

    // Stage 1: Provision the physical base storage account via System Program
    CreateAccount {
        from: payer,
        to: diagnostic_mint,
        lamports: rent_lamports,
        space: aligned_space as u64,
        owner: token_2022_program.address(),
    }
    .invoke()?;
    pinocchio_log::log!("✔ Base account storage initialized successfully.");

    // Stage 2: Initialize the Metadata Pointer Extension Layout
    InitializeMetadataPointer {
        mint: diagnostic_mint,
        authority: Some(payer.address()),
        metadata_address: Some(diagnostic_mint.address()),
        token_program: token_2022_program.address(),
    }
    .invoke()?;
    pinocchio_log::log!("✔ Extension metadata pointer layout bound.");

    // Stage 3: Initialize the base parameters of the token mint asset layout
    InitializeMint2 {
        mint: diagnostic_mint,
        decimals: 6,
        mint_authority: payer.address(),
        freeze_authority: Some(payer.address()),
        token_program: token_2022_program.address(),
    }
    .invoke()?;
    pinocchio_log::log!("✔ Core mint parameters mapped safely.");

    // Stage 4: Initialize variable-length Token Metadata fields within the account TLV blocks
    let spl_ix = spl_token_metadata_interface::instruction::initialize(
        token_2022_program.address(),
        diagnostic_mint.address(),
        payer.address(),
        diagnostic_mint.address(),
        payer.address(),
        name.to_string(),
        symbol.to_string(),
        uri.to_string(),
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
    pinocchio_log::log!(
        "🚀 [Alley Ping Success]: Full extension token creation lifecycle completed!"
    );

    Ok(())
}
