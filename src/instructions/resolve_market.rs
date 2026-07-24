use crate::state::{MarketState, ResolveMarketArgs};
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError};

/// Minimal trusted-keeper oracle model: the pubkey recorded as a market's
/// `oracle_authority` (set once, at `create_market` time, from the
/// `oracle_authority_acc` account) is the only party that can ever resolve that
/// market. The keeper verifies the real-world event result off-chain and signs
/// this instruction with the winning outcome.
///
/// This intentionally keeps the on-chain trust surface to a single signer check.
/// Swapping in a decentralized oracle (Switchboard, Pyth, UMA, a DAO vote, a
/// multisig, etc.) later only requires changing what `oracle_authority` is set to
/// at market-creation time (e.g. a program-owned PDA that itself enforces
/// multi-party attestation) — the check here (`keeper_signer == oracle_authority`
/// and `keeper_signer.is_signer()`) does not need to change.
pub fn process_resolve_market(
    _program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [keeper_signer, market_pda, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !keeper_signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let args = ResolveMarketArgs::from_bytes(instruction_data)?;
    if args.winning_outcome > 1 {
        return Err(ProgramError::InvalidArgument);
    }

    unsafe {
        let data_mut = market_pda.borrow_unchecked_mut();
        let state_mut = &mut *(data_mut.as_mut_ptr() as *mut MarketState);

        if state_mut.market_status != 1 || state_mut.is_settled != 0 {
            return Err(ProgramError::InvalidArgument);
        }

        if keeper_signer.address() != &state_mut.oracle_authority {
            return Err(ProgramError::IncorrectAuthority);
        }

        state_mut.is_settled = 1;
        state_mut.winning_outcome = args.winning_outcome;
        state_mut.market_status = 2; // Move state variable flag to Settled
    }

    pinocchio_log::log!("🎉 [Alley]: Market resolved by its configured oracle authority.");
    Ok(())
}
