use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

mod clearance;
mod error;
mod state;

pub use clearance::{
    checks_pass, digest, encode, parse, signed_clearance, Clearance, CHECK_BUYER_AUTH, CHECK_CATEGORY,
    CHECK_CORRIDOR, CHECK_INTENT_SIG, CHECK_MANDATE, CHECK_MINT, CHECK_NONCE, CHECK_NOT_SELF,
    CHECK_REFUND_RATIO, CHECK_SCREENING, CHECK_VELOCITY, CHECK_VENDOR_AUTH, CHECK_VENDOR_REGISTERED,
    DECISION_ALLOW, DECISION_DENY, KIND_FUND, KIND_RELEASE, LEN, VERSION,
};
pub use error::LeashError;
pub use state::*;

#[cfg(test)]
mod tests;

declare_id!("8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd");

const DAY_SECONDS: i64 = 86_400;
const MIN_WINDOW_SECONDS: i64 = 60;
const MAX_WINDOW_SECONDS: i64 = 14 * DAY_SECONDS;

#[program]
pub mod leash {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        policy_signer: Pubkey,
        verifier: Pubkey,
        policy_version: u64,
        required_checks: u32,
    ) -> Result<()> {
        require!(policy_version > 0, LeashError::InvalidAmount);
        require!(verifier != policy_signer, LeashError::Unauthorized);
        require!(verifier != ctx.accounts.admin.key(), LeashError::Unauthorized);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.policy_signer = policy_signer;
        config.verifier = verifier;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.policy_version = policy_version;
        config.required_checks = required_checks;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn init_corridor(
        ctx: Context<InitCorridor>,
        from_country: [u8; 2],
        to_country: [u8; 2],
        enabled: bool,
        per_payment_cap: u64,
        daily_cap: u64,
        packet_threshold: u64,
    ) -> Result<()> {
        require_window_country(from_country, to_country)?;
        require!(per_payment_cap > 0 && daily_cap > 0, LeashError::InvalidAmount);
        let corridor = &mut ctx.accounts.corridor;
        corridor.from_country = from_country;
        corridor.to_country = to_country;
        corridor.enabled = enabled;
        corridor.per_payment_cap = per_payment_cap;
        corridor.daily_cap = daily_cap;
        corridor.daily_spent = 0;
        corridor.spent_day = 0;
        corridor.packet_threshold = packet_threshold;
        corridor.bump = ctx.bumps.corridor;
        Ok(())
    }

    pub fn set_corridor(
        ctx: Context<SetCorridor>,
        _from_country: [u8; 2],
        _to_country: [u8; 2],
        enabled: bool,
        per_payment_cap: u64,
        daily_cap: u64,
        packet_threshold: u64,
    ) -> Result<()> {
        require!(per_payment_cap > 0 && daily_cap > 0, LeashError::InvalidAmount);
        let corridor = &mut ctx.accounts.corridor;
        corridor.enabled = enabled;
        corridor.per_payment_cap = per_payment_cap;
        corridor.daily_cap = daily_cap;
        corridor.packet_threshold = packet_threshold;
        Ok(())
    }

    pub fn create_mandate(
        ctx: Context<CreateMandate>,
        mandate_id: u64,
        params: MandateParams,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(params.agent != ctx.accounts.owner.key(), LeashError::Unauthorized);
        require!(
            params.budget > 0 && params.per_payment_limit > 0,
            LeashError::InvalidAmount
        );
        require!(
            params.per_payment_limit <= params.budget,
            LeashError::InvalidAmount
        );
        require!(params.max_uses > 0, LeashError::InvalidAmount);
        require!(params.expires_at > now, LeashError::MandateExpired);
        require!(
            (MIN_WINDOW_SECONDS..=MAX_WINDOW_SECONDS).contains(&params.delivery_seconds),
            LeashError::InvalidWindow
        );
        require!(
            (MIN_WINDOW_SECONDS..=MAX_WINDOW_SECONDS).contains(&params.acceptance_seconds),
            LeashError::InvalidWindow
        );
        require!(
            !params.allowed_corridors.is_empty(),
            LeashError::CorridorNotAllowed
        );
        require!(
            params.allowed_corridors.len() <= 4,
            LeashError::TooManyCorridors
        );

        let mandate = &mut ctx.accounts.mandate;
        mandate.mandate_id = mandate_id;
        mandate.owner = ctx.accounts.owner.key();
        mandate.agent = params.agent;
        mandate.budget = params.budget;
        mandate.spent = 0;
        mandate.per_payment_limit = params.per_payment_limit;
        mandate.max_uses = params.max_uses;
        mandate.uses = 0;
        mandate.expires_at = params.expires_at;
        mandate.delivery_seconds = params.delivery_seconds;
        mandate.acceptance_seconds = params.acceptance_seconds;
        mandate.revoked = false;
        mandate.category = params.category;
        mandate.corridor_count = params.allowed_corridors.len() as u8;
        mandate.allowed_corridors = [CorridorId {
            from_country: [0, 0],
            to_country: [0, 0],
        }; 4];
        for (slot, corridor) in mandate
            .allowed_corridors
            .iter_mut()
            .zip(params.allowed_corridors.iter())
        {
            *slot = *corridor;
        }
        mandate.treasury_bump = ctx.bumps.treasury_authority;
        mandate.treasury_vault_bump = ctx.bumps.treasury_vault;
        mandate.bump = ctx.bumps.mandate;
        Ok(())
    }

    pub fn revoke_mandate(ctx: Context<RevokeMandate>, _mandate_id: u64) -> Result<()> {
        ctx.accounts.mandate.revoked = true;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, _mandate_id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, LeashError::InvalidAmount);
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.owner_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    pub fn withdraw(ctx: Context<Withdraw>, _mandate_id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, LeashError::InvalidAmount);
        require!(
            amount <= ctx.accounts.treasury_vault.amount,
            LeashError::InvalidAmount
        );
        let mandate_key = ctx.accounts.mandate.key();
        let bump = [ctx.accounts.mandate.treasury_bump];
        let seeds: &[&[u8]] = &[b"treasury", mandate_key.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.treasury_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.treasury_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    pub fn create_and_fund(
        ctx: Context<CreateAndFund>,
        payment_id: [u8; 32],
        mandate_id: u64,
        from_country: [u8; 2],
        to_country: [u8; 2],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (clearance, clearance_hash) = signed_clearance(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.policy_signer,
        )?;
        require_fresh(&clearance, now, &ctx.accounts.config)?;
        require!(clearance.kind == KIND_FUND, LeashError::InvalidClearance);
        require!(clearance.decision == DECISION_ALLOW, LeashError::InvalidClearance);
        require!(payment_id != [0u8; 32], LeashError::InvalidClearance);
        require!(clearance.payment_id == payment_id, LeashError::ClearanceMismatch);
        require!(
            clearance.mandate == ctx.accounts.mandate.key(),
            LeashError::ClearanceMismatch
        );
        require!(
            ctx.accounts.mandate.mandate_id == mandate_id,
            LeashError::ClearanceMismatch
        );
        require!(
            clearance.buyer == ctx.accounts.mandate.owner
                && clearance.buyer == ctx.accounts.owner.key(),
            LeashError::ClearanceMismatch
        );
        require!(
            clearance.vendor == ctx.accounts.vendor.key(),
            LeashError::ClearanceMismatch
        );
        require!(
            clearance.mint == ctx.accounts.mint.key(),
            LeashError::MintMismatch
        );
        require!(
            clearance.from_country == from_country && clearance.to_country == to_country,
            LeashError::ClearanceMismatch
        );
        require!(clearance.buyer != clearance.vendor, LeashError::SelfPayment);
        require!(
            ctx.accounts.agent.key() != clearance.vendor,
            LeashError::SelfPayment
        );
        require!(
            corridor_allowed(&ctx.accounts.mandate, from_country, to_country),
            LeashError::CorridorNotAllowed
        );
        if ctx.accounts.corridor.packet_threshold > 0
            && clearance.amount >= ctx.accounts.corridor.packet_threshold
        {
            require!(
                clearance.packet_hash != [0u8; 32],
                LeashError::PacketRequired
            );
        }

        let amount = clearance.amount;
        let mandate_key = ctx.accounts.mandate.key();
        let agent_key = ctx.accounts.agent.key();
        let delivery_seconds = ctx.accounts.mandate.delivery_seconds;
        commit_mandate(
            &mut ctx.accounts.mandate,
            amount,
            now,
            clearance.category,
        )?;
        commit_corridor(&mut ctx.accounts.corridor, amount, now)?;

        let deadline = now
            .checked_add(delivery_seconds)
            .ok_or_else(|| error!(LeashError::InvalidWindow))?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.payment_id = payment_id;
        escrow.mandate = mandate_key;
        escrow.buyer = clearance.buyer;
        escrow.agent = agent_key;
        escrow.vendor = clearance.vendor;
        escrow.mint = clearance.mint;
        escrow.amount = amount;
        escrow.from_country = from_country;
        escrow.to_country = to_country;
        escrow.category = clearance.category;
        escrow.purpose_code = clearance.purpose_code;
        escrow.invoice_hash = clearance.invoice_hash;
        escrow.invoice_amount = clearance.invoice_amount;
        escrow.invoice_currency = clearance.invoice_currency;
        escrow.state = EscrowState::Funded;
        escrow.fund_clearance_hash = clearance_hash;
        escrow.release_clearance_hash = [0u8; 32];
        escrow.created_at = now;
        escrow.delivery_deadline = deadline;
        escrow.acceptance_deadline = 0;
        escrow.receipt_hash = [0u8; 32];
        escrow.verification_hash = [0u8; 32];
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.escrow_vault;

        let mandate_key = ctx.accounts.mandate.key();
        let bump = [ctx.accounts.mandate.treasury_bump];
        let seeds: &[&[u8]] = &[b"treasury", mandate_key.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.treasury_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.treasury_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }

    pub fn submit_delivery(
        ctx: Context<SubmitDelivery>,
        _payment_id: [u8; 32],
        mandate_id: u64,
        receipt_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.escrow.state == EscrowState::Funded,
            LeashError::BadState
        );
        require!(
            now < ctx.accounts.escrow.delivery_deadline,
            LeashError::DeliveryLate
        );
        require!(receipt_hash != [0u8; 32], LeashError::BadReceipt);
        require!(
            ctx.accounts.mandate.mandate_id == mandate_id
                && ctx.accounts.mandate.key() == ctx.accounts.escrow.mandate,
            LeashError::ClearanceMismatch
        );
        let acceptance_deadline = now
            .checked_add(ctx.accounts.mandate.acceptance_seconds)
            .ok_or_else(|| error!(LeashError::InvalidWindow))?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.receipt_hash = receipt_hash;
        escrow.acceptance_deadline = acceptance_deadline;
        escrow.state = EscrowState::Delivered;
        Ok(())
    }

    pub fn verify_delivery(
        ctx: Context<VerifyDelivery>,
        _payment_id: [u8; 32],
        artifact: Vec<u8>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.escrow.state == EscrowState::Delivered,
            LeashError::BadState
        );
        require!(
            now < ctx.accounts.escrow.acceptance_deadline,
            LeashError::AcceptanceClosed
        );
        require!(
            artifact.len() >= RECEIPT_MAGIC.len() && artifact.len() <= MAX_ARTIFACT_LEN,
            LeashError::BadReceipt
        );
        require!(
            artifact.starts_with(RECEIPT_MAGIC),
            LeashError::BadReceipt
        );
        require!(
            digest(&artifact) == ctx.accounts.escrow.receipt_hash,
            LeashError::BadReceipt
        );
        let escrow = &mut ctx.accounts.escrow;
        escrow.verification_hash = digest(&artifact);
        escrow.state = EscrowState::Verified;
        Ok(())
    }

    /// Pay the vendor only after the mechanical verifier has accepted the receipt.
    pub fn release(ctx: Context<Release>, _payment_id: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (clearance, clearance_hash) = signed_clearance(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.policy_signer,
        )?;
        require_fresh(&clearance, now, &ctx.accounts.config)?;
        require!(clearance.kind == KIND_RELEASE, LeashError::InvalidClearance);
        require_same_payment(&clearance, &ctx.accounts.escrow)?;
        require!(
            ctx.accounts.escrow_vault.amount == ctx.accounts.escrow.amount,
            LeashError::InvalidAmount
        );

        if clearance.decision == DECISION_DENY {
            require!(
                matches!(
                    ctx.accounts.escrow.state,
                    EscrowState::Funded | EscrowState::Delivered | EscrowState::Verified
                ),
                LeashError::BadState
            );
            let escrow = &mut ctx.accounts.escrow;
            escrow.state = EscrowState::Disputed;
            escrow.release_clearance_hash = clearance_hash;
            return Ok(());
        }
        require!(clearance.decision == DECISION_ALLOW, LeashError::InvalidClearance);
        require!(
            ctx.accounts.escrow.state == EscrowState::Verified,
            LeashError::BadState
        );
        require!(
            now < ctx.accounts.escrow.acceptance_deadline,
            LeashError::AcceptanceClosed
        );
        require!(ctx.accounts.corridor.enabled, LeashError::CorridorBlocked);

        let amount = ctx.accounts.escrow.amount;
        let decimals = ctx.accounts.mint.decimals;
        ctx.accounts.escrow.state = EscrowState::Released;
        ctx.accounts.escrow.release_clearance_hash = clearance_hash;

        let payment_id = ctx.accounts.escrow.payment_id;
        let bump = [ctx.accounts.escrow.bump];
        let seeds: &[&[u8]] = &[b"escrow", payment_id.as_ref(), &bump];
        pay_and_close(
            ctx.accounts.token_program.key(),
            ctx.accounts.escrow_vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.vendor_ata.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            ctx.accounts.agent.to_account_info(),
            seeds,
            amount,
            decimals,
        )
    }

    pub fn refund(mut ctx: Context<Refund>, _payment_id: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        match ctx.accounts.escrow.state {
            EscrowState::Funded => {
                require!(
                    now >= ctx.accounts.escrow.delivery_deadline,
                    LeashError::RefundTooEarly
                );
            }
            EscrowState::Delivered | EscrowState::Verified => {
                require!(
                    now >= ctx.accounts.escrow.acceptance_deadline,
                    LeashError::RefundTooEarly
                );
            }
            _ => return err!(LeashError::BadState),
        }
        settle_refund(&mut ctx)
    }

    pub fn admin_refund(mut ctx: Context<AdminRefund>, _payment_id: [u8; 32]) -> Result<()> {
        require!(
            matches!(
                ctx.accounts.escrow.state,
                EscrowState::Funded
                    | EscrowState::Delivered
                    | EscrowState::Verified
                    | EscrowState::Disputed
            ),
            LeashError::BadState
        );
        settle_admin_refund(&mut ctx)
    }
}

const RECEIPT_MAGIC: &[u8] = b"DLV1";
const MAX_ARTIFACT_LEN: usize = 256;

fn require_window_country(from_country: [u8; 2], to_country: [u8; 2]) -> Result<()> {
    require!(
        country_ok(from_country) && country_ok(to_country),
        LeashError::InvalidClearance
    );
    Ok(())
}

fn country_ok(country: [u8; 2]) -> bool {
    country[0] != 0 && country[1] != 0
}

fn require_fresh(clearance: &Clearance, now: i64, config: &Config) -> Result<()> {
    require!(clearance.version == VERSION, LeashError::InvalidClearance);
    require!(clearance.issued_at <= now, LeashError::InvalidClearance);
    require!(now < clearance.expires_at, LeashError::ExpiredClearance);
    require!(
        clearance.policy_version == config.policy_version,
        LeashError::PolicyVersionMismatch
    );
    require!(
        checks_pass(clearance, config.required_checks),
        LeashError::ChecksFailed
    );
    require!(
        clearance.invoice_amount == clearance.amount,
        LeashError::FxMismatch
    );
    require!(
        clearance.invoice_currency == *b"USD\0",
        LeashError::FxMismatch
    );
    require!(clearance.invoice_hash != [0u8; 32], LeashError::InvalidClearance);
    require!(clearance.amount > 0, LeashError::InvalidAmount);
    require!(
        country_ok(clearance.from_country) && country_ok(clearance.to_country),
        LeashError::InvalidClearance
    );
    Ok(())
}

fn require_same_payment(clearance: &Clearance, escrow: &Escrow) -> Result<()> {
    require!(
        clearance.payment_id == escrow.payment_id,
        LeashError::ClearanceMismatch
    );
    require!(clearance.mandate == escrow.mandate, LeashError::ClearanceMismatch);
    require!(clearance.buyer == escrow.buyer, LeashError::ClearanceMismatch);
    require!(clearance.vendor == escrow.vendor, LeashError::ClearanceMismatch);
    require!(clearance.mint == escrow.mint, LeashError::MintMismatch);
    require!(clearance.amount == escrow.amount, LeashError::ClearanceMismatch);
    require!(
        clearance.from_country == escrow.from_country && clearance.to_country == escrow.to_country,
        LeashError::ClearanceMismatch
    );
    require!(
        clearance.category == escrow.category && clearance.purpose_code == escrow.purpose_code,
        LeashError::ClearanceMismatch
    );
    require!(
        clearance.invoice_hash == escrow.invoice_hash
            && clearance.invoice_amount == escrow.invoice_amount,
        LeashError::ClearanceMismatch
    );
    require!(
        clearance.invoice_currency == escrow.invoice_currency,
        LeashError::FxMismatch
    );
    Ok(())
}

fn corridor_allowed(mandate: &Mandate, from_country: [u8; 2], to_country: [u8; 2]) -> bool {
    let count = (mandate.corridor_count as usize).min(mandate.allowed_corridors.len());
    mandate.allowed_corridors[..count]
        .iter()
        .any(|corridor| corridor.from_country == from_country && corridor.to_country == to_country)
}

fn commit_mandate(mandate: &mut Mandate, amount: u64, now: i64, category: u16) -> Result<()> {
    require!(!mandate.revoked, LeashError::MandateRevoked);
    require!(now < mandate.expires_at, LeashError::MandateExpired);
    require!(
        amount <= mandate.per_payment_limit,
        LeashError::PaymentLimitExceeded
    );
    require!(category == mandate.category, LeashError::ClearanceMismatch);
    let spent = mandate
        .spent
        .checked_add(amount)
        .ok_or_else(|| error!(LeashError::BudgetExceeded))?;
    require!(spent <= mandate.budget, LeashError::BudgetExceeded);
    require!(mandate.uses < mandate.max_uses, LeashError::UseLimitReached);
    mandate.spent = spent;
    mandate.uses = mandate
        .uses
        .checked_add(1)
        .ok_or_else(|| error!(LeashError::UseLimitReached))?;
    Ok(())
}

fn commit_corridor(corridor: &mut Corridor, amount: u64, now: i64) -> Result<()> {
    require!(corridor.enabled, LeashError::CorridorBlocked);
    require!(
        amount <= corridor.per_payment_cap,
        LeashError::PaymentLimitExceeded
    );
    let day = now
        .checked_div(DAY_SECONDS)
        .ok_or_else(|| error!(LeashError::InvalidAmount))?;
    if corridor.spent_day != day {
        corridor.spent_day = day;
        corridor.daily_spent = 0;
    }
    let next = corridor
        .daily_spent
        .checked_add(amount)
        .ok_or_else(|| error!(LeashError::DailyCapExceeded))?;
    require!(next <= corridor.daily_cap, LeashError::DailyCapExceeded);
    corridor.daily_spent = next;
    Ok(())
}

fn pay_and_close<'info>(
    token_program: Pubkey,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    rent_destination: AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: from.clone(),
                mint,
                to,
                authority: authority.clone(),
            },
            &[seeds],
        ),
        amount,
        decimals,
    )?;
    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: from,
            destination: rent_destination,
            authority,
        },
        &[seeds],
    ))?;
    Ok(())
}

fn settle_refund(ctx: &mut Context<Refund>) -> Result<()> {
    let amount = ctx.accounts.escrow.amount;
    let decimals = ctx.accounts.mint.decimals;
    require!(
        ctx.accounts.escrow_vault.amount == amount,
        LeashError::InvalidAmount
    );
    ctx.accounts.escrow.state = EscrowState::Refunded;
    let payment_id = ctx.accounts.escrow.payment_id;
    let bump = [ctx.accounts.escrow.bump];
    let seeds: &[&[u8]] = &[b"escrow", payment_id.as_ref(), &bump];
    pay_and_close(
        ctx.accounts.token_program.key(),
        ctx.accounts.escrow_vault.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.buyer_ata.to_account_info(),
        ctx.accounts.escrow.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        seeds,
        amount,
        decimals,
    )
}

fn settle_admin_refund(ctx: &mut Context<AdminRefund>) -> Result<()> {
    let amount = ctx.accounts.escrow.amount;
    let decimals = ctx.accounts.mint.decimals;
    require!(
        ctx.accounts.escrow_vault.amount == amount,
        LeashError::InvalidAmount
    );
    ctx.accounts.escrow.state = EscrowState::Refunded;
    let payment_id = ctx.accounts.escrow.payment_id;
    let bump = [ctx.accounts.escrow.bump];
    let seeds: &[&[u8]] = &[b"escrow", payment_id.as_ref(), &bump];
    pay_and_close(
        ctx.accounts.token_program.key(),
        ctx.accounts.escrow_vault.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.buyer_ata.to_account_info(),
        ctx.accounts.escrow.to_account_info(),
        ctx.accounts.admin.to_account_info(),
        seeds,
        amount,
        decimals,
    )
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(from_country: [u8; 2], to_country: [u8; 2])]
pub struct InitCorridor<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + Corridor::INIT_SPACE,
        seeds = [b"corridor", from_country.as_ref(), to_country.as_ref()],
        bump
    )]
    pub corridor: Account<'info, Corridor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(from_country: [u8; 2], to_country: [u8; 2])]
pub struct SetCorridor<'info> {
    #[account(address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"corridor", from_country.as_ref(), to_country.as_ref()],
        bump = corridor.bump
    )]
    pub corridor: Account<'info, Corridor>,
}

#[derive(Accounts)]
#[instruction(mandate_id: u64)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [b"mandate", owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: PDA signer for the treasury token vault. It holds no data.
    #[account(seeds = [b"treasury", mandate.key().as_ref()], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        seeds = [b"treasury-vault", mandate.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = treasury_authority
    )]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub mint: Account<'info, Mint>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(mandate_id: u64)]
pub struct RevokeMandate<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"mandate", owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,
}

#[derive(Accounts)]
#[instruction(mandate_id: u64)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"mandate", owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner
    )]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"treasury-vault", mandate.key().as_ref()],
        bump = mandate.treasury_vault_bump,
        token::mint = mint
    )]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub mint: Account<'info, Mint>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(mandate_id: u64)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"mandate", owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: PDA signer recorded on the mandate.
    #[account(seeds = [b"treasury", mandate.key().as_ref()], bump = mandate.treasury_bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"treasury-vault", mandate.key().as_ref()],
        bump = mandate.treasury_vault_bump,
        token::mint = mint,
        token::authority = treasury_authority
    )]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub mint: Account<'info, Mint>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32], mandate_id: u64, from_country: [u8; 2], to_country: [u8; 2])]
pub struct CreateAndFund<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    /// CHECK: Mandate owner. Used as a PDA seed and checked against the signed clearance.
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"mandate", owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = agent
    )]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [b"corridor", from_country.as_ref(), to_country.as_ref()],
        bump = corridor.bump
    )]
    pub corridor: Box<Account<'info, Corridor>>,
    /// CHECK: PDA signer recorded on the mandate.
    #[account(seeds = [b"treasury", mandate.key().as_ref()], bump = mandate.treasury_bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"treasury-vault", mandate.key().as_ref()],
        bump = mandate.treasury_vault_bump,
        token::mint = mint,
        token::authority = treasury_authority
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = agent,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", payment_id.as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        init,
        payer = agent,
        seeds = [b"escrow-vault", payment_id.as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: Vendor payout wallet. It must match the signed clearance.
    pub vendor: UncheckedAccount<'info>,
    /// CHECK: Instructions sysvar. The address constraint binds it.
    #[account(address = pubkey!("Sysvar1nstructions1111111111111111111111111"))]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32], mandate_id: u64)]
pub struct SubmitDelivery<'info> {
    #[account(address = escrow.vendor)]
    pub vendor: Signer<'info>,
    /// CHECK: Mandate owner. Used only as the mandate PDA seed.
    pub owner: UncheckedAccount<'info>,
    #[account(
        seeds = [b"mandate", owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump = mandate.bump
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        seeds = [b"escrow", payment_id.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct VerifyDelivery<'info> {
    #[account(address = config.verifier)]
    pub verifier: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"escrow", payment_id.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct Release<'info> {
    #[account(mut, address = escrow.agent)]
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", payment_id.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        mut,
        seeds = [b"escrow-vault", payment_id.as_ref()],
        bump = escrow.vault_bump,
        token::mint = mint,
        token::authority = escrow
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [b"corridor", escrow.from_country.as_ref(), escrow.to_country.as_ref()],
        bump = corridor.bump
    )]
    pub corridor: Box<Account<'info, Corridor>>,
    /// CHECK: Vendor payout wallet recorded on the escrow.
    #[account(address = escrow.vendor)]
    pub vendor: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vendor
    )]
    pub vendor_ata: Box<Account<'info, TokenAccount>>,
    #[account(address = escrow.mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: Instructions sysvar. The address constraint binds it.
    #[account(address = pubkey!("Sysvar1nstructions1111111111111111111111111"))]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct Refund<'info> {
    #[account(mut, address = escrow.buyer)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", payment_id.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [b"escrow-vault", payment_id.as_ref()],
        bump = escrow.vault_bump,
        token::mint = mint,
        token::authority = escrow
    )]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = buyer
    )]
    pub buyer_ata: Account<'info, TokenAccount>,
    #[account(address = escrow.mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct AdminRefund<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"escrow", payment_id.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [b"escrow-vault", payment_id.as_ref()],
        bump = escrow.vault_bump,
        token::mint = mint,
        token::authority = escrow
    )]
    pub escrow_vault: Account<'info, TokenAccount>,
    /// CHECK: Buyer recorded on the escrow. Rent and tokens return to this wallet.
    #[account(address = escrow.buyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = buyer
    )]
    pub buyer_ata: Account<'info, TokenAccount>,
    #[account(address = escrow.mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
