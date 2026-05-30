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
    pub accumulated_fees: u64,
    pub is_settled: u8,
    pub market_status: u8,
    pub bump: u8,
}

impl MarketState {
    pub const LEN: usize = 187;

    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}

#[repr(C)]
pub struct CreateMarketArgs {
    pub market_id: u64,
    pub settlement_deadline: i64,
    pub bump_ot_a: u8,
    pub bump_ot_b: u8,
}

impl CreateMarketArgs {
    pub const LEN: usize = 18;

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }

        let market_id = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let settlement_deadline = i64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let bump_ot_a = bytes[16];
        let bump_ot_b = bytes[17];

        Ok(Self {
            market_id,
            settlement_deadline,
            bump_ot_a,
            bump_ot_b,
        })
    }
}

#[repr(C)]
pub struct UserMarketPosition {
    pub user_wallet: Address,
    pub market_pda: Address,
    pub collateral_available: u64,
    pub collateral_locked: u64,
    pub ot_a_available: u64,
    pub ot_a_locked: u64,
    pub ot_b_available: u64,
    pub ot_b_locked: u64,
    pub bump: u8,
}

impl UserMarketPosition {
    pub const LEN: usize = 113;

    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}

#[repr(C)]
#[derive(Clone)]
pub struct Order {
    pub user_position: Address,
    pub quantity: u64,
    pub order_id: u64,
}

#[repr(C)]
pub struct OrderPage {
    pub head: u32,
    pub tail: u32,
    pub price: u8,
    pub side: u8,
    pub outcome: u8,
    pub padding: u8,
    pub orders: [Order; 100],
}

impl OrderPage {
    pub const LEN: usize = 4812;
    pub const MAX_ORDERS: u32 = 100;

    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}
