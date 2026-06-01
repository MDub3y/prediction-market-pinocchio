use pinocchio::{Address, error::ProgramError};

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum MarketTier {
    Small = 0,
    Medium = 1,
    Large = 2,
}

impl MarketTier {
    pub fn from_u8(val: u8) -> Result<Self, ProgramError> {
        match val {
            0 => Ok(MarketTier::Small),
            1 => Ok(MarketTier::Medium),
            2 => Ok(MarketTier::Large),
            _ => Err(ProgramError::InvalidArgument),
        }
    }
}

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
pub struct DepositCollateralArgs {
    pub amount: u64,
    pub bump_user_position: u8,
}

impl DepositCollateralArgs {
    pub const LEN: usize = 9;

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        let amount = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let bump_user_position = bytes[8];
        Ok(Self {
            amount,
            bump_user_position,
        })
    }
}

#[repr(C)]
pub struct PlaceOrderArgs {
    pub outcome: u8,
    pub side: u8,
    pub order_type: u8,
    pub price: u8,
    pub quantity: u64,
    pub order_id: u64,
    pub bump_order_page: u8,
    pub num_pages: u8,
}

impl PlaceOrderArgs {
    pub const LEN: usize = 22;

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        let outcome = bytes[0];
        let side = bytes[1];
        let order_type = bytes[2];
        let price = bytes[3];
        let quantity = u64::from_le_bytes(bytes[4..12].try_into().unwrap());
        let order_id = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
        let bump_order_page = bytes[20];
        let num_pages = bytes[21];

        Ok(Self {
            outcome,
            side,
            order_type,
            price,
            quantity,
            order_id,
            bump_order_page,
            num_pages,
        })
    }
}
