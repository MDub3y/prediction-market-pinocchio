macro_rules! alley_log {
    ($message:literal, $($arg:tt)*) => {
        #[cfg(target_os = "solana")]
        pinocchio_log::log!($message, $($arg)*);
        #[cfg(not(target_os = "solana"))]
        core::pinocchio::log::println!($message, $($arg)*);
    };
    ($message:literal) => {
        #[cfg(target_os = "solana")]
        pinocchio_log::log!($message);
        #[cfg(not(target_os = "solana"))]
        core::pinocchio::log::println!($message);
    };
}
