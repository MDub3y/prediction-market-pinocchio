use pinocchio::error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum AlleyError {
    /// 0x0 - Global platform account profile has not been created via deposit yet
    PlatformUserNotInitialized = 0,
    /// 0x1 - User does not have enough collateral liquid cash in their ledger
    InsufficientCollateral = 1,
    /// 0x2 - Interaction blocked because the targeted market has been finalized
    MarketAlreadySettled = 2,
    /// 0x3 - Price parameter must reside strictly between 1 and 99 cents
    InvalidPriceBounds = 3,
    /// 0x4 - Tried to merge or sell more outcome shares than currently owned
    InsufficientOutcomeTokens = 4,
    /// 0x5 - explicit market depth liquidity exception variant
    InsufficientBookLiquidity = 5,
}

impl From<AlleyError> for ProgramError {
    #[inline(always)]
    fn from(error: AlleyError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
