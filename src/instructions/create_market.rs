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

use crate::state::{CreateMarketArgs, MarketState, MarketTier, derive_collateral_vault};

pub fn process_create_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    pinocchio_log::log!("📦 [Alley]: Commencing full Create Market initialization pipeline...");

    let [
        creator,
        market_pda,
        outcome_a_mint,
        outcome_b_mint,
        collateral_mint,
        _system_program,
        token_program,
        oracle_authority_acc,
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

    let index_b = [1u8];
    let bump_b = [args.bump_ot_b];
    let ot_b_seeds = [
        Seed::from(b"mint"),
        Seed::from(market_pda.address().as_ref()),
        Seed::from(&index_b),
        Seed::from(&bump_b),
    ];

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

    // Token-2022's `InitializeMint2` rejects the mint unless its account length is
    // *exactly* `ExtensionType::try_calculate_account_len::<Mint>(&extensions)` for
    // whatever extensions are already written into the account at that point in time.
    // At this stage in the pipeline only the MetadataPointer extension has been
    // initialized (the variable-length TokenMetadata TLV entry is appended later, via
    // `alloc_and_serialize_variable_len_extension`, which reallocs the account itself).
    // So the space passed to `CreateAccount` must match that fixed-size layout exactly.
    //
    // The TLV region does NOT start right after the 82-byte Mint struct: Token-2022
    // places `AccountType` (and everything after it) at the fixed offset `Account::LEN`
    // (165 bytes) for every base state (Mint, Account, Multisig alike), so that a
    // program can distinguish an extended Mint/Account/Multisig purely by length. So:
    //   165 (Account::LEN, not Mint::LEN) + 1 (AccountType) + 4 (TLV header)
    //     + 64 (MetadataPointer: authority(32) + metadata_address(32)) = 234
    // Any value that doesn't equal this exact figure causes `InitializeMint2` (or even
    // the metadata-pointer `Initialize` CPI before it) to fail with `InvalidAccountData`,
    // regardless of metadata string length. The account is still funded (via
    // `args.mint_rent`, computed client-side) for its eventual larger size once the
    // TokenMetadata extension is appended and the account reallocated, so no additional
    // lamport top-up is required later in this instruction.
    const BASE_MINT_LEN: u64 = 82;
    const BASE_ACCOUNT_LEN: u64 = 165; // Token-2022's fixed TLV offset for every base state
    const ACCOUNT_TYPE_LEN: u64 = 1;
    const TLV_HEADER_LEN: u64 = 4;
    const METADATA_POINTER_EXTENSION_LEN: u64 = 64; // authority(32) + metadata_address(32)
    const METADATA_POINTER_MINT_LEN: u64 =
        BASE_ACCOUNT_LEN + ACCOUNT_TYPE_LEN + TLV_HEADER_LEN + METADATA_POINTER_EXTENSION_LEN;

    let dynamic_mint_space_a = if args.has_custom_meta == 1 {
        METADATA_POINTER_MINT_LEN
    } else {
        BASE_MINT_LEN
    };
    let dynamic_mint_space_b = if args.has_custom_meta == 1 {
        METADATA_POINTER_MINT_LEN
    } else {
        BASE_MINT_LEN
    };

    // 1. Initialize Market Configurations PDA
    CreateAccount {
        from: creator,
        to: market_pda,
        lamports: args.market_rent,
        space: market_state_rent_space,
        owner: program_id,
    }
    .invoke_signed(&[state_signer])?;
    pinocchio_log::log!("market pda created!");

    // 2. Initialize Outcomes Ledger Accounts with exactly 240 bytes
    CreateAccount {
        from: creator,
        to: outcome_a_mint,
        lamports: args.mint_rent,
        space: dynamic_mint_space_a,
        owner: token_program.address(),
    }
    .invoke_signed(&[Signer::from(&ot_a_seeds)])?;
    pinocchio_log::log!("mint a created!");

    CreateAccount {
        from: creator,
        to: outcome_b_mint,
        lamports: args.mint_rent,
        space: dynamic_mint_space_b,
        owner: token_program.address(),
    }
    .invoke_signed(&[Signer::from(&ot_b_seeds)])?;
    pinocchio_log::log!("mint b created!");

    if args.has_custom_meta == 1 {
        // 3. Initialize Extension Metadata Pointers
        InitializeMetadataPointer {
            mint: outcome_a_mint,
            authority: Some(market_pda.address()),
            metadata_address: Some(outcome_a_mint.address()),
            token_program: token_program.address(),
        }
        .invoke()?;
        pinocchio_log::log!("pointer a initialized");

        InitializeMetadataPointer {
            mint: outcome_b_mint,
            authority: Some(market_pda.address()),
            metadata_address: Some(outcome_b_mint.address()),
            token_program: token_program.address(),
        }
        .invoke()?;
        pinocchio_log::log!("pointer b initialized");
    }

    // 4. Initialize Mints parameters (this now completes successfully)
    InitializeMint2 {
        mint: outcome_a_mint,
        decimals: 6,
        mint_authority: creator.address(),
        freeze_authority: Some(market_pda.address()),
        token_program: token_program.address(),
    }
    .invoke()?;
    pinocchio_log::log!("init a complete");

    InitializeMint2 {
        mint: outcome_b_mint,
        decimals: 6,
        mint_authority: creator.address(),
        freeze_authority: Some(market_pda.address()),
        token_program: token_program.address(),
    }
    .invoke()?;
    pinocchio_log::log!("init b complete");

    if args.has_custom_meta == 1 {
        // 5. Initialize Token Metadata strings (Token-2022 expands account sizes dynamically)
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
            InstructionAccount::readonly_signer(creator.address()),
        ];
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &accounts_view_a,
                data: &spl_ix_a.data,
            },
            &[&*outcome_a_mint, &*market_pda, &*outcome_a_mint, &*creator],
        )?;
        pinocchio_log::log!("metadata TLV layout a initialized");

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
            InstructionAccount::readonly_signer(creator.address()),
        ];
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &accounts_view_b,
                data: &spl_ix_b.data,
            },
            &[&*outcome_b_mint, &*market_pda, &*outcome_b_mint, &*creator],
        )?;
        pinocchio_log::log!("metadata TLV layout b initialized");

        // 6. Transfer Mint Management Privileges permanently over to the Market PDA
        let mut rotate_payload = [0u8; 35];
        rotate_payload[0] = 6; // SetAuthority
        rotate_payload[1] = 0; // MintTokens
        rotate_payload[2] = 1; // Option::Some
        rotate_payload[3..35].copy_from_slice(market_pda.address().as_ref());

        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &[
                    InstructionAccount::writable(outcome_a_mint.address()),
                    InstructionAccount::readonly_signer(creator.address()),
                ],
                data: &rotate_payload,
            },
            &[&*outcome_a_mint, &*creator],
        )?;
        invoke(
            &InstructionView {
                program_id: token_program.address(),
                accounts: &[
                    InstructionAccount::writable(outcome_b_mint.address()),
                    InstructionAccount::readonly_signer(creator.address()),
                ],
                data: &rotate_payload,
            },
            &[&*outcome_b_mint, &*creator],
        )?;
        pinocchio_log::log!("mint management rights rotated to market pda");
    }

    // 7. Serialize On-Chain Primitive Fields
    unsafe {
        let data_slice = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_slice.as_mut_ptr() as *mut MarketState);
        state_mut.creator = creator.address().clone();
        // Trusted-keeper oracle model: whichever pubkey is passed as
        // `oracle_authority_acc` is the only signer that can ever resolve this specific
        // market (see resolve_market.rs). Doesn't need to be a signer here — only at
        // resolution time.
        state_mut.oracle_authority = oracle_authority_acc.address().clone();
        state_mut.market_id = args.market_id;
        state_mut.settlement_deadline = args.settlement_deadline;
        // The vault is global (shared across every market) — derived, not passed in, so
        // it's guaranteed to match exactly what deposit_collateral computes and lazily
        // creates. See derive_collateral_vault's doc comment.
        state_mut.collateral_vault = derive_collateral_vault(program_id, collateral_mint.address());
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
