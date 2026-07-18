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

use crate::state::{CreateMarketArgs, MarketState, MarketTier};

// Token-2022 Structural Layout Byte Dimensions
const MINT_BASE_SPACE: usize = 82;
const EXTENSIONS_PADDING_AND_OFFSET: usize = 84;
const METADATA_POINTER_SIZE: usize = 68; // Type(2) + Length(2) + Auth(32) + Addr(32)
const METADATA_EXTENSION_BASE_SIZE: usize = 80; // Header + Core Field Mappings Base

pub fn calculate_space(
    enable_meta: bool,
    name_len: usize,
    symbol_len: usize,
    uri_len: usize,
) -> usize {
    if !enable_meta {
        return MINT_BASE_SPACE;
    }
    let extension_size =
        METADATA_POINTER_SIZE + METADATA_EXTENSION_BASE_SIZE + name_len + symbol_len + uri_len;
    let total = MINT_BASE_SPACE + EXTENSIONS_PADDING_AND_OFFSET + extension_size;
    (total + 7) & !7 // Enforce strict 8-byte boundary alignment
}

pub fn process_create_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    pinocchio_log::log!("📦 [Alley]: Commencing full Create Market initialization pipeline...");

    let [
        creator,
        market_pda,
        collateral_vault,
        outcome_a_mint,
        outcome_b_mint,
        collateral_mint,
        _system_program,
        token_program,
        _associated_token_program,
        _oracle_authority_acc,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let args = CreateMarketArgs::from_bytes(instruction_data)?;
    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let _tier = MarketTier::from_u8(args.tier)?;

    // Parse Variable Length Metadata Strings from Sliced instruction_data Stream
    let mut offset = CreateMarketArgs::LEN;

    let name_a = if args.name_a_len > 0 {
        let bytes = &instruction_data[offset..offset + args.name_a_len as usize];
        offset += args.name_a_len as usize;
        core::str::from_utf8(bytes).map_err(|_| ProgramError::InvalidInstructionData)?
    } else {
        ""
    };

    let symbol_a = if args.symbol_a_len > 0 {
        let bytes = &instruction_data[offset..offset + args.symbol_a_len as usize];
        offset += args.symbol_a_len as usize;
        core::str::from_utf8(bytes).map_err(|_| ProgramError::InvalidInstructionData)?
    } else {
        ""
    };

    let name_b = if args.name_b_len > 0 {
        let bytes = &instruction_data[offset..offset + args.name_b_len as usize];
        offset += args.name_b_len as usize;
        core::str::from_utf8(bytes).map_err(|_| ProgramError::InvalidInstructionData)?
    } else {
        ""
    };

    let symbol_b = if args.symbol_b_len > 0 {
        let bytes = &instruction_data[offset..offset + args.symbol_b_len as usize];
        offset += args.symbol_b_len as usize;
        core::str::from_utf8(bytes).map_err(|_| ProgramError::InvalidInstructionData)?
    } else {
        ""
    };

    let uri_a = if args.uri_a_len > 0 {
        let bytes = &instruction_data[offset..offset + args.uri_a_len as usize];
        offset += args.uri_a_len as usize;
        core::str::from_utf8(bytes).map_err(|_| ProgramError::InvalidInstructionData)?
    } else {
        ""
    };

    let uri_b = if args.uri_b_len > 0 {
        let bytes = &instruction_data[offset..offset + args.uri_b_len as usize];
        core::str::from_utf8(bytes).map_err(|_| ProgramError::InvalidInstructionData)?
    } else {
        ""
    };

    let market_id_bytes = args.market_id.to_le_bytes();
    let (expected_market_pda, market_bump) =
        Address::find_program_address(&[b"market", market_id_bytes.as_ref()], program_id);
    if expected_market_pda != *market_pda.address() {
        return Err(ProgramError::InvalidSeeds);
    }

    let index_a = [0u8];
    let bump_a = [args.bump_ot_a];
    let ot_a_seeds = [
        Seed::from(b"mint"),
        Seed::from(market_pda.address().as_ref()),
        Seed::from(&index_a),
        Seed::from(&bump_a),
    ];
    let signer_a = Signer::from(&ot_a_seeds);

    let index_b = [1u8];
    let bump_b = [args.bump_ot_b];
    let ot_b_seeds = [
        Seed::from(b"mint"),
        Seed::from(market_pda.address().as_ref()),
        Seed::from(&index_b),
        Seed::from(&bump_b),
    ];
    let signer_b = Signer::from(&ot_b_seeds);

    let state_bump_slice = core::slice::from_ref(&market_bump);
    let state_seeds = [
        Seed::from(b"market"),
        Seed::from(market_id_bytes.as_ref()),
        Seed::from(state_bump_slice),
    ];
    let state_signer = Signer::from(&state_seeds);

    let dynamic_strings_overhead = if args.has_custom_meta == 1 {
        (args.name_a_len as u64)
            + (args.symbol_a_len as u64)
            + (args.name_b_len as u64)
            + (args.symbol_b_len as u64)
            + (args.uri_a_len as u64)
            + (args.uri_b_len as u64)
    } else {
        0
    };

    let market_state_rent_space = MarketState::LEN as u64 + dynamic_strings_overhead;

    let space_a = calculate_space(
        args.has_custom_meta == 1,
        args.name_a_len as usize,
        args.symbol_a_len as usize,
        args.uri_a_len as usize,
    );
    let space_b = calculate_space(
        args.has_custom_meta == 1,
        args.name_b_len as usize,
        args.symbol_b_len as usize,
        args.uri_b_len as usize,
    );

    // 1. Initialize Market Configurations PDA
    CreateAccount {
        from: creator,
        to: market_pda,
        lamports: args.market_rent,
        space: market_state_rent_space,
        owner: program_id,
    }
    .invoke_signed(&[state_signer])?;

    // 2. Initialize Outcomes Ledger Accounts
    CreateAccount {
        from: creator,
        to: outcome_a_mint,
        lamports: args.mint_rent,
        space: space_a as u64,
        owner: token_program.address(),
    }
    .invoke_signed(&[signer_a])?;
    CreateAccount {
        from: creator,
        to: outcome_b_mint,
        lamports: args.mint_rent,
        space: space_b as u64,
        owner: token_program.address(),
    }
    .invoke_signed(&[signer_b])?;

    if args.has_custom_meta == 1 {
        // Initialize Extension Metadata Pointers
        InitializeMetadataPointer {
            mint: outcome_a_mint,
            authority: Some(market_pda.address()),
            metadata_address: Some(outcome_a_mint.address()),
            token_program: token_program.address(),
        }
        .invoke()?;
        InitializeMetadataPointer {
            mint: outcome_b_mint,
            authority: Some(market_pda.address()),
            metadata_address: Some(outcome_b_mint.address()),
            token_program: token_program.address(),
        }
        .invoke()?;
    }

    // Initialize Mints targeting the active signing Creator wallet as temporary manager
    InitializeMint2 {
        mint: outcome_a_mint,
        decimals: 6,
        mint_authority: creator.address(),
        freeze_authority: Some(market_pda.address()),
        token_program: token_program.address(),
    }
    .invoke()?;
    InitializeMint2 {
        mint: outcome_b_mint,
        decimals: 6,
        mint_authority: creator.address(),
        freeze_authority: Some(market_pda.address()),
        token_program: token_program.address(),
    }
    .invoke()?;

    if args.has_custom_meta == 1 {
        // Execute Metadata Layout Formats using the official standard interface
        let spl_ix_a = spl_token_metadata_interface::instruction::initialize(
            token_program.address(),
            outcome_a_mint.address(),
            market_pda.address(),
            outcome_a_mint.address(),
            creator.address(),
            name_a.to_string(),
            symbol_a.to_string(),
            uri_a.to_string(),
        );
        let accounts_view_a = [
            InstructionAccount::writable(outcome_a_mint.address()),
            InstructionAccount::readonly(market_pda.address()),
            InstructionAccount::readonly(outcome_a_mint.address()),
            InstructionAccount::readonly(creator.address()),
        ];
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &accounts_view_a,
                data: &spl_ix_a.data,
            },
            &[&*outcome_a_mint, &*market_pda, &*outcome_a_mint, &*creator],
        )?;

        let spl_ix_b = spl_token_metadata_interface::instruction::initialize(
            token_program.address(),
            outcome_b_mint.address(),
            market_pda.address(),
            outcome_b_mint.address(),
            creator.address(),
            name_b.to_string(),
            symbol_b.to_string(),
            uri_b.to_string(),
        );
        let accounts_view_b = [
            InstructionAccount::writable(outcome_b_mint.address()),
            InstructionAccount::readonly(market_pda.address()),
            InstructionAccount::readonly(outcome_b_mint.address()),
            InstructionAccount::readonly(creator.address()),
        ];
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &accounts_view_b,
                data: &spl_ix_b.data,
            },
            &[&*outcome_b_mint, &*market_pda, &*outcome_b_mint, &*creator],
        )?;

        // Rotate Mint Authority from Creator over to the persistent Market PDA contract
        let mut rotate_payload = [0u8; 35];
        rotate_payload[0] = 6; // Discriminator 6: SetAuthority
        rotate_payload[1] = 0; // AuthorityType: MintTokens
        rotate_payload[2] = 1; // Option::Some
        rotate_payload[3..35].copy_from_slice(market_pda.address().as_ref());

        let rotate_accounts = [
            InstructionAccount::writable(outcome_a_mint.address()),
            InstructionAccount::readonly(creator.address()),
        ];
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &rotate_accounts,
                data: &rotate_payload,
            },
            &[&*outcome_a_mint, &*creator],
        )?;

        let rotate_accounts_b = [
            InstructionAccount::writable(outcome_b_mint.address()),
            InstructionAccount::readonly(creator.address()),
        ];
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &rotate_accounts_b,
                data: &rotate_payload,
            },
            &[&*outcome_b_mint, &*creator],
        )?;
    }

    // Bare-Metal Memory Field Mapping Serialization
    unsafe {
        let data_slice = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_slice.as_mut_ptr() as *mut MarketState);
        state_mut.creator = creator.address().clone();
        state_mut.oracle_authority = crate::instructions::resolve_market::TXLINE_PROGRAM_ID.clone();
        state_mut.market_id = args.market_id;
        state_mut.settlement_deadline = args.settlement_deadline;
        state_mut.collateral_vault = collateral_vault.address().clone();
        state_mut.outcome_a_mint = outcome_a_mint.address().clone();
        state_mut.outcome_b_mint = outcome_b_mint.address().clone();
        state_mut.collateral_mint = collateral_mint.address().clone();
        state_mut.orderbook_a = Address::default();
        state_mut.orderbook_b = Address::default();
        state_mut.accumulated_platform_fees = 0;
        state_mut.accumulated_creator_fees = 0;
        state_mut.fee_rate_bps = 500;
        state_mut.tier = args.tier;
        state_mut.is_settled = 0;
        state_mut.winning_outcome = 0;
        state_mut.market_status = 0;
        state_mut.bump = market_bump;
    }

    Ok(())
}
