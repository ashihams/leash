use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub policy_signer: Pubkey,
    pub verifier: Pubkey,
    pub usdc_mint: Pubkey,
    pub policy_version: u64,
    pub required_checks: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub struct CorridorId {
    pub from_country: [u8; 2],
    pub to_country: [u8; 2],
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub mandate_id: u64,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub budget: u64,
    pub spent: u64,
    pub per_payment_limit: u64,
    pub max_uses: u32,
    pub uses: u32,
    pub expires_at: i64,
    pub delivery_seconds: i64,
    pub acceptance_seconds: i64,
    pub revoked: bool,
    pub category: u16,
    pub corridor_count: u8,
    pub allowed_corridors: [CorridorId; 4],
    pub treasury_bump: u8,
    pub treasury_vault_bump: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateParams {
    pub agent: Pubkey,
    pub budget: u64,
    pub per_payment_limit: u64,
    pub max_uses: u32,
    pub expires_at: i64,
    pub delivery_seconds: i64,
    pub acceptance_seconds: i64,
    pub category: u16,
    pub allowed_corridors: Vec<CorridorId>,
}

#[account]
#[derive(InitSpace)]
pub struct Corridor {
    pub from_country: [u8; 2],
    pub to_country: [u8; 2],
    pub enabled: bool,
    pub per_payment_cap: u64,
    pub daily_cap: u64,
    pub daily_spent: u64,
    pub spent_day: i64,
    pub packet_threshold: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Funded,
    Delivered,
    Verified,
    Releasable,
    Released,
    Refunded,
    Disputed,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub payment_id: [u8; 32],
    pub mandate: Pubkey,
    pub buyer: Pubkey,
    pub agent: Pubkey,
    pub vendor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub from_country: [u8; 2],
    pub to_country: [u8; 2],
    pub category: u16,
    pub purpose_code: u16,
    pub invoice_hash: [u8; 32],
    pub invoice_amount: u64,
    pub invoice_currency: [u8; 4],
    pub state: EscrowState,
    pub fund_clearance_hash: [u8; 32],
    pub release_clearance_hash: [u8; 32],
    pub created_at: i64,
    pub delivery_deadline: i64,
    pub acceptance_deadline: i64,
    pub receipt_hash: [u8; 32],
    pub verification_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}
