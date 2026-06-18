use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    error::ProgramError,
};
use pinocchio_associated_token_account::instructions::Create as CreateAssociatedTokenAccount;
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token_2022::instructions::InitializeMint2;

use solana_instruction_view::{InstructionAccount, InstructionView, cpi::invoke};

use crate::state::{CreateMarketArgs, MarketState, MarketTier};

pub struct InitializeMetadataPointer<'a> {
    pub mint: &'a AccountView,
    pub authority: &'a Address,
    pub metadata_address: &'a Address,
}

impl<'a> InitializeMetadataPointer<'a> {
    pub fn invoke(&self, token_prorgam_2022: &Address) -> ProgramResult {
        let mut data = [0u8; 68];
        data[0] = 39; // extension gruop discriminator: Metadata Pointer
        data[1] = 0; // sub-instruction discriminator: Initialize

        data[2] = 1;
        data[3..35].copy_from_slice(self.authority.as_ref());

        data[35] = 1;
        data[36..68].copy_from_slice(self.metadata_address.as_ref());

        let account_meta = InstructionAccount::writable(self.mint.address());
        let instruction = InstructionView {
            program_id: token_prorgam_2022,
            accounts: core::slice::from_ref(&account_meta),
            data: &data,
        };

        invoke(&instruction, &[self.mint])
    }
}

pub fn process_create_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [
        creator,
        market_pda,
        collateral_vault,
        outcome_a_mint,
        outcome_b_mint,
        collateral_mint,
        system_program,
        token_program,
        _associated_token_program,
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

    let market_id_bytes = args.market_id.to_le_bytes();
    let (expected_market_pda, market_bump) =
        Address::find_program_address(&[b"market", market_id_bytes.as_ref()], program_id);
    if expected_market_pda != *market_pda.address() {
        return Err(ProgramError::InvalidSeeds);
    }

    let ot_a_raw_seeds: &[&[u8]] = &[
        b"mint",
        market_pda.address().as_ref(),
        &[0],
        &[args.bump_ot_a],
    ];
    let expected_mint_ot_a = Address::create_program_address(ot_a_raw_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if outcome_a_mint.address() != &expected_mint_ot_a {
        return Err(ProgramError::InvalidSeeds);
    }

    let ot_b_raw_seeds: &[&[u8]] = &[
        b"mint",
        market_pda.address().as_ref(),
        &[1],
        &[args.bump_ot_b],
    ];
    let expected_mint_ot_b = Address::create_program_address(ot_b_raw_seeds, program_id)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if outcome_b_mint.address() != &expected_mint_ot_b {
        return Err(ProgramError::InvalidSeeds);
    }

    let (expected_vault, _) = Address::find_program_address(
        &[
            market_pda.address().as_ref(),
            token_program.address().as_ref(),
            collateral_mint.address().as_ref(),
        ],
        &pinocchio_associated_token_account::ID,
    );
    if collateral_vault.address() != &expected_vault {
        return Err(ProgramError::InvalidArgument);
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

    CreateAccount {
        from: creator,
        to: market_pda,
        lamports: market_pda.lamports(),
        space: MarketState::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[state_signer])?;

    CreateAccount {
        from: creator,
        to: outcome_a_mint,
        lamports: outcome_a_mint.lamports(),
        space: 151,
        owner: token_program.address(),
    }
    .invoke_signed(&[Signer::from(&ot_a_seeds)])?;

    InitializeMetadataPointer {
        mint: outcome_a_mint,
        authority: market_pda.address(),
        metadata_address: market_pda.address(),
    }
    .invoke(token_program.address())?;

    InitializeMint2 {
        mint: outcome_a_mint,
        decimals: 6,
        mint_authority: market_pda.address(),
        freeze_authority: Some(market_pda.address()),
        token_program: token_program.address(),
    }
    .invoke()?;

    CreateAccount {
        from: creator,
        to: outcome_b_mint,
        lamports: outcome_b_mint.lamports(),
        space: 151,
        owner: token_program.address(),
    }
    .invoke_signed(&[Signer::from(&ot_b_seeds)])?;

    InitializeMetadataPointer {
        mint: outcome_b_mint,
        authority: market_pda.address(),
        metadata_address: market_pda.address(),
    }
    .invoke(token_program.address())?;

    InitializeMint2 {
        mint: outcome_b_mint,
        decimals: 6,
        mint_authority: market_pda.address(),
        freeze_authority: Some(market_pda.address()),
        token_program: token_program.address(),
    }
    .invoke()?;

    CreateAssociatedTokenAccount {
        funding_account: creator,
        account: collateral_vault,
        wallet: market_pda,
        mint: collateral_mint,
        system_program,
        token_program,
    }
    .invoke()?;

    unsafe {
        let data_slice = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_slice.as_mut_ptr() as *mut MarketState);
        state_mut.creator = creator.address().clone();
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
        state_mut.market_status = 0;
        state_mut.bump = market_bump;
    }

    Ok(())
}
