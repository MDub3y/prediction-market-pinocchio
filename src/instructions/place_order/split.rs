use crate::{
    errors::AlleyError,
    state::{MarketUserState, PlaceOrderArgs, PlatformUserState},
};
use pinocchio::{AccountView, ProgramResult, error::ProgramError};

pub fn execute_split_operation(
    accounts: &mut [AccountView],
    args: &PlaceOrderArgs,
) -> ProgramResult {
    let [_, _, platform_user_state, market_user_state, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    unsafe {
        let p_data = platform_user_state.borrow_unchecked_mut();
        let platform_state = &mut *(p_data.as_mut_ptr() as *mut PlatformUserState);
        if platform_state.collateral_available < args.quantity {
            return Err(AlleyError::InsufficientCollateral.into());
        }
        platform_state.collateral_available -= args.quantity;
    }

    unsafe {
        let m_data = market_user_state.borrow_unchecked_mut();
        let market_user = &mut *(m_data.as_mut_ptr() as *mut MarketUserState);
        market_user.ot_a_balance += args.quantity;
        market_user.ot_b_balance += args.quantity;
    }

    Ok(())
}
