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
#[derive(Copy, Clone)]
pub struct MarketSizeParams {
    pub max_bids: u32,
    pub max_asks: u32,
    pub max_seats: u32,
    pub tier_flag: u8,
    pub padding: [u8; 3],
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
    pub orderbook_a: Address,
    pub orderbook_b: Address,
    pub accumulated_fees: u64,
    pub size_params: MarketSizeParams,
    pub is_settled: u8,
    pub market_status: u8,
    pub bump: u8,
    pub padding: u8,
}

impl MarketState {
    pub const LEN: usize = 268;

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
pub struct PriceLevel {
    pub head: u32,
    pub tail: u32,
}

#[repr(C)]
#[derive(Clone)]
pub struct OrderNode {
    pub user_seat_idx: u32,
    pub quantity: u64,
    pub next_idx: u32,
    pub order_id: u64,
}

#[repr(C)]
#[derive(Clone, Default)]
pub struct TraderSeat {
    pub wallet: Address,
    pub collateral_claimable: u64,
    pub shares_claimable: u64,
}

#[repr(C)]
pub struct OrderBookHeader {
    pub market_state_pda: Address,
    pub total_allocated_seats: u32,
    pub next_free_node_idx: u32,
    pub outcome_index: u8,
    pub padding: [u8; 3],
}

pub const SMALL_SEATS: usize = 128;
pub const SMALL_ORDERS: usize = 256;

pub const MEDIUM_SEATS: usize = 1024;
pub const MEDIUM_ORDERS: usize = 2048;

pub const LARGE_SEATS: usize = 4096;
pub const LARGE_ORDERS: usize = 8192;

pub fn calculate_orderbook_space(tier: MarketTier) -> usize {
    let header_size = core::mem::size_of::<OrderBookHeader>();
    let directory_size = core::mem::size_of::<PriceLevel>() * 100 * 2;

    let (seats, orders) = match tier {
        MarketTier::Small => (SMALL_SEATS, SMALL_ORDERS * 2),
        MarketTier::Medium => (MEDIUM_SEATS, MEDIUM_ORDERS * 2),
        MarketTier::Large => (LARGE_SEATS, LARGE_ORDERS * 2),
    };

    let seats_pool_size = core::mem::size_of::<TraderSeat>() * seats;
    let orders_pool_size = core::mem::size_of::<OrderNode>() * orders;

    header_size + directory_size + seats_pool_size + orders_pool_size
}

#[repr(C)]
pub struct CreateMarketArgs {
    pub market_id: u64,
    pub settlement_deadline: i64,
    pub bump_ot_a: u8,
    pub bump_ot_b: u8,
    pub tier: u8,
}

impl CreateMarketArgs {
    pub const LEN: usize = 19;

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        let market_id = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let settlement_deadline = i64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let bump_ot_a = bytes[16];
        let bump_ot_b = bytes[17];
        let tier = bytes[18];
        Ok(Self {
            market_id,
            settlement_deadline,
            bump_ot_a,
            bump_ot_b,
            tier,
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
