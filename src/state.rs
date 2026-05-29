use pinocchio::{Address, error::ProgramError};

#[repr(C)]
pub struct MarketState {
    pub creator: Address,
    pub market_id: u64,
    pub settlement_deadline: i64,
    pub collateral_vault: Address,
    pub outcome_a_mint: Address,
    pub outcome_b_mint: Address,
    pub collateral_mint: Address,
    pub is_settled: u8,
    pub market_status: u8,
    pub bump: u8,
}

impl MarketState {
    pub const LEN: usize = 179;

    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}
