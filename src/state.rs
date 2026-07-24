use pinocchio::{Address, error::ProgramError};

pub const NULL_ADDRESS: Address = Address::new_from_array([0u8; 32]);

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
    pub oracle_authority: Address,
    pub market_id: u64,
    pub settlement_deadline: i64,
    pub collateral_vault: Address,
    pub outcome_a_mint: Address,
    pub outcome_b_mint: Address,
    pub collateral_mint: Address,
    pub orderbook_a: Address,
    pub orderbook_b: Address,
    pub accumulated_platform_fees: u64, // 50% Share
    pub accumulated_creator_fees: u64,  // 10% Share
    pub fee_rate_bps: u16,              // E.g., 500 bps = 5% Taker Fee Rate
    pub tier: u8,
    pub is_settled: u8,
    pub winning_outcome: u8,
    pub market_status: u8,
    pub bump: u8,
    pub padding: [u8; 2],
}

impl MarketState {
    pub const LEN: usize = 296;

    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}

#[repr(C)]
pub struct PlatformUserState {
    pub wallet: Address,
    pub collateral_available: u64,
    pub bump: u8,
    pub padding: [u8; 7],
}

impl PlatformUserState {
    pub const LEN: usize = 41;

    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}

#[repr(C)]
pub struct MarketUserState {
    pub wallet: Address,
    pub market_pda: Address,
    pub platform_user_state: Address,
    pub ot_a_balance: u64,
    pub ot_b_balance: u64,
    pub collateral_claimable: u64, // destination for makre rebate rewards
    pub bump: u8,
    pub padding: [u8; 7],
}

impl MarketUserState {
    pub const LEN: usize = 128;
    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(bytes.as_ptr() as *const Self) })
    }
}

#[repr(C, packed)]
#[derive(Clone, Copy, Default)]
pub struct PriceLevel {
    pub head: u32,
    pub tail: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy, Default)]
pub struct OrderNode {
    pub user_seat_idx: u32,
    pub quantity: u64,
    pub next_idx: u32,
    pub order_id: u64,
}

#[repr(C, packed)]
#[derive(Default)]
pub struct TraderSeat {
    pub market_user_state: Address,
    pub collateral_locked: u64,
    pub ot_a_locked: u64,
    pub ot_b_locked: u64,
}

#[repr(C, packed)]
pub struct OrderBookHeader {
    pub market_state_pda: Address,
    pub total_allocated_seats: u32,
    pub next_free_node_idx: u32,
    pub outcome_index: u8,
    pub padding: [u8; 3],
}

pub const SMALL_SEATS: usize = 128;
pub const SMALL_ORDERS: usize = 512;

pub const MEDIUM_SEATS: usize = 1024;
pub const MEDIUM_ORDERS: usize = 4096;

pub const LARGE_SEATS: usize = 4096;
pub const LARGE_ORDERS: usize = 16384;

pub fn calculate_orderbook_space(tier: MarketTier) -> usize {
    let header_size = core::mem::size_of::<OrderBookHeader>();
    let directory_size = core::mem::size_of::<PriceLevel>() * 100 * 2;

    let (seats, orders) = match tier {
        MarketTier::Small => (SMALL_SEATS, SMALL_ORDERS),
        MarketTier::Medium => (MEDIUM_SEATS, MEDIUM_ORDERS),
        MarketTier::Large => (LARGE_SEATS, LARGE_ORDERS),
    };

    header_size
        + directory_size
        + (core::mem::size_of::<TraderSeat>() * seats)
        + (core::mem::size_of::<OrderNode>() * orders)
}

pub struct OrderBookView<'a> {
    pub header: &'a mut OrderBookHeader,
    pub directory: &'a mut [PriceLevel],
    pub seats: &'a mut [TraderSeat],
    pub orders: &'a mut [OrderNode],
}

impl<'a> OrderBookView<'a> {
    pub unsafe fn load(ptr: *mut u8, tier: MarketTier) -> Self {
        unsafe {
            let max_seats = match tier {
                MarketTier::Small => SMALL_SEATS,
                MarketTier::Medium => MEDIUM_SEATS,
                MarketTier::Large => LARGE_SEATS,
            };
            let max_orders = match tier {
                MarketTier::Small => SMALL_ORDERS,
                MarketTier::Medium => MEDIUM_ORDERS,
                MarketTier::Large => LARGE_ORDERS,
            };

            let offset_dir = core::mem::size_of::<OrderBookHeader>();
            let offset_seats = offset_dir + (core::mem::size_of::<PriceLevel>() * 200);
            let offset_orders = offset_seats + (core::mem::size_of::<TraderSeat>() * max_seats);

            Self {
                header: &mut *(ptr as *mut OrderBookHeader),
                directory: core::slice::from_raw_parts_mut(
                    ptr.add(offset_dir) as *mut PriceLevel,
                    200,
                ),
                seats: core::slice::from_raw_parts_mut(
                    ptr.add(offset_seats) as *mut TraderSeat,
                    max_seats,
                ),
                orders: core::slice::from_raw_parts_mut(
                    ptr.add(offset_orders) as *mut OrderNode,
                    max_orders,
                ),
            }
        }
    }
}

#[repr(C)]
pub struct CreateMarketArgs {
    pub market_id: u64,
    pub settlement_deadline: i64,
    pub market_rent: u64,
    pub mint_rent: u64,
    pub bump_ot_a: u8,
    pub bump_ot_b: u8,
    pub tier: u8,
    pub has_custom_meta: u8,
    pub name_a_len: u16,
    pub symbol_a_len: u16,
    pub name_b_len: u16,
    pub symbol_b_len: u16,
    pub uri_a_len: u16,
    pub uri_b_len: u16,
}

impl CreateMarketArgs {
    pub const LEN: usize = 48;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            market_id: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
            settlement_deadline: i64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            market_rent: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            mint_rent: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
            bump_ot_a: bytes[32],
            bump_ot_b: bytes[33],
            tier: bytes[34],
            has_custom_meta: bytes[35],
            name_a_len: u16::from_le_bytes(bytes[36..38].try_into().unwrap()),
            symbol_a_len: u16::from_le_bytes(bytes[38..40].try_into().unwrap()),
            name_b_len: u16::from_le_bytes(bytes[40..42].try_into().unwrap()),
            symbol_b_len: u16::from_le_bytes(bytes[42..44].try_into().unwrap()),
            uri_a_len: u16::from_le_bytes(bytes[44..46].try_into().unwrap()),
            uri_b_len: u16::from_le_bytes(bytes[46..48].try_into().unwrap()),
        })
    }
}

// Not required after client-side generated keypairs
/* #[repr(C)]
pub struct InitializeOrderBookArgs {
    pub bump_book_a: u8,
    pub bump_book_b: u8,
}

impl InitializeOrderBookArgs {
    pub const LEN: usize = 2;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            bump_book_a: bytes[0],
            bump_book_b: bytes[1],
        })
    }
} */

#[repr(C)]
pub struct DepositCollateralArgs {
    pub amount: u64,
    pub bump_user_state: u8,
}

impl DepositCollateralArgs {
    pub const LEN: usize = 9;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            amount: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
            bump_user_state: bytes[8],
        })
    }
}

// all kinds of orders will be resolved through place_order
/* #[repr(C)]
pub struct SplitTokensArgs {
    pub amount: u64,
}

impl SplitTokensArgs {
    pub const LEN: usize = 8;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            amount: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        })
    }
}

#[repr(C)]
pub struct MergeTokensArgs {
    pub amount: u64,
}

impl MergeTokensArgs {
    pub const LEN: usize = 8;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            amount: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        })
    }
} */

#[repr(C)]
pub struct PlaceOrderArgs {
    pub outcome: u8,
    pub side: u8,
    pub order_type: u8, // 0 = Limit, 1 = Market, 2 = Split, 3 = Merge
    pub price: u8,
    pub quantity: u64,
    pub order_id: u64,
    pub bump_market_user: u8, // passed dynamically from client layout
}

impl PlaceOrderArgs {
    pub const LEN: usize = 21;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            outcome: bytes[0],
            side: bytes[1],
            order_type: bytes[2],
            price: bytes[3],
            quantity: u64::from_le_bytes(bytes[4..12].try_into().unwrap()),
            order_id: u64::from_le_bytes(bytes[12..20].try_into().unwrap()),
            bump_market_user: bytes[20],
        })
    }
}

#[repr(C)]
pub struct CancelOrderArgs {
    pub outcome: u8,
    pub side: u8,
    pub price: u8,
    pub order_node_idx: u32,
    pub order_id: u64,
}

impl CancelOrderArgs {
    pub const LEN: usize = 15;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            outcome: bytes[0],
            side: bytes[1],
            price: bytes[2],
            order_node_idx: u32::from_le_bytes(bytes[3..7].try_into().unwrap()),
            order_id: u64::from_le_bytes(bytes[7..15].try_into().unwrap()),
        })
    }
}

#[repr(C)]
pub struct ClaimFundsArgs {
    pub outcome: u8,
}

impl ClaimFundsArgs {
    pub const LEN: usize = 1;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self { outcome: bytes[0] })
    }
}

#[repr(C)]
pub struct ResolveMarketArgs {
    pub winning_outcome: u8,
}

impl ResolveMarketArgs {
    pub const LEN: usize = 1;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < Self::LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            winning_outcome: bytes[0],
        })
    }
}
