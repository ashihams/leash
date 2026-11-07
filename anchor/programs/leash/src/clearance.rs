use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;

use crate::LeashError;

pub const LEN: usize = 288;
pub const VERSION: u8 = 1;
pub const KIND_FUND: u8 = 1;
pub const KIND_RELEASE: u8 = 2;
pub const DECISION_DENY: u8 = 0;
pub const DECISION_ALLOW: u8 = 1;

pub const CHECK_BUYER_AUTH: u32 = 1 << 0;
pub const CHECK_VENDOR_AUTH: u32 = 1 << 1;
pub const CHECK_NONCE: u32 = 1 << 2;
pub const CHECK_INTENT_SIG: u32 = 1 << 3;
pub const CHECK_VENDOR_REGISTERED: u32 = 1 << 4;
pub const CHECK_MANDATE: u32 = 1 << 5;
pub const CHECK_CATEGORY: u32 = 1 << 6;
pub const CHECK_MINT: u32 = 1 << 7;
pub const CHECK_NOT_SELF: u32 = 1 << 8;
pub const CHECK_CORRIDOR: u32 = 1 << 9;
pub const CHECK_VELOCITY: u32 = 1 << 10;
pub const CHECK_SCREENING: u32 = 1 << 11;
pub const CHECK_REFUND_RATIO: u32 = 1 << 12;

const OFFSET_PAYMENT_ID: usize = 4;
const OFFSET_MANDATE: usize = 36;
const OFFSET_BUYER: usize = 68;
const OFFSET_VENDOR: usize = 100;
const OFFSET_MINT: usize = 132;
const OFFSET_AMOUNT: usize = 164;
const OFFSET_FROM: usize = 172;
const OFFSET_TO: usize = 174;
const OFFSET_CATEGORY: usize = 176;
const OFFSET_PURPOSE: usize = 178;
const OFFSET_INVOICE_HASH: usize = 180;
const OFFSET_INVOICE_AMOUNT: usize = 212;
const OFFSET_INVOICE_CURRENCY: usize = 220;
const OFFSET_POLICY_VERSION: usize = 224;
const OFFSET_ISSUED_AT: usize = 232;
const OFFSET_EXPIRES_AT: usize = 240;
const OFFSET_CHECKS_RUN: usize = 248;
const OFFSET_CHECKS_FAILED: usize = 252;
const OFFSET_PACKET_HASH: usize = 256;

#[derive(Clone, Debug)]
pub struct Clearance {
    pub version: u8,
    pub kind: u8,
    pub decision: u8,
    pub payment_id: [u8; 32],
    pub mandate: Pubkey,
    pub buyer: Pubkey,
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
    pub policy_version: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub checks_run: u32,
    pub checks_failed: u32,
    pub packet_hash: [u8; 32],
}

pub fn encode(clearance: &Clearance) -> [u8; LEN] {
    let mut out = [0u8; LEN];
    out[0] = clearance.version;
    out[1] = clearance.kind;
    out[2] = clearance.decision;
    write_bytes(&mut out, OFFSET_PAYMENT_ID, &clearance.payment_id);
    write_bytes(&mut out, OFFSET_MANDATE, clearance.mandate.as_ref());
    write_bytes(&mut out, OFFSET_BUYER, clearance.buyer.as_ref());
    write_bytes(&mut out, OFFSET_VENDOR, clearance.vendor.as_ref());
    write_bytes(&mut out, OFFSET_MINT, clearance.mint.as_ref());
    write_bytes(&mut out, OFFSET_AMOUNT, &clearance.amount.to_le_bytes());
    write_bytes(&mut out, OFFSET_FROM, &clearance.from_country);
    write_bytes(&mut out, OFFSET_TO, &clearance.to_country);
    write_bytes(&mut out, OFFSET_CATEGORY, &clearance.category.to_le_bytes());
    write_bytes(&mut out, OFFSET_PURPOSE, &clearance.purpose_code.to_le_bytes());
    write_bytes(&mut out, OFFSET_INVOICE_HASH, &clearance.invoice_hash);
    write_bytes(&mut out, OFFSET_INVOICE_AMOUNT, &clearance.invoice_amount.to_le_bytes());
    write_bytes(&mut out, OFFSET_INVOICE_CURRENCY, &clearance.invoice_currency);
    write_bytes(&mut out, OFFSET_POLICY_VERSION, &clearance.policy_version.to_le_bytes());
    write_bytes(&mut out, OFFSET_ISSUED_AT, &clearance.issued_at.to_le_bytes());
    write_bytes(&mut out, OFFSET_EXPIRES_AT, &clearance.expires_at.to_le_bytes());
    write_bytes(&mut out, OFFSET_CHECKS_RUN, &clearance.checks_run.to_le_bytes());
    write_bytes(&mut out, OFFSET_CHECKS_FAILED, &clearance.checks_failed.to_le_bytes());
    write_bytes(&mut out, OFFSET_PACKET_HASH, &clearance.packet_hash);
    out
}

pub fn parse(data: &[u8]) -> Result<Clearance> {
    require!(data.len() == LEN, LeashError::InvalidClearance);
    require!(data[3] == 0, LeashError::InvalidClearance);
    Ok(Clearance {
        version: data[0],
        kind: data[1],
        decision: data[2],
        payment_id: read_array(data, OFFSET_PAYMENT_ID)?,
        mandate: Pubkey::from(read_array::<32>(data, OFFSET_MANDATE)?),
        buyer: Pubkey::from(read_array::<32>(data, OFFSET_BUYER)?),
        vendor: Pubkey::from(read_array::<32>(data, OFFSET_VENDOR)?),
        mint: Pubkey::from(read_array::<32>(data, OFFSET_MINT)?),
        amount: u64::from_le_bytes(read_array(data, OFFSET_AMOUNT)?),
        from_country: read_array(data, OFFSET_FROM)?,
        to_country: read_array(data, OFFSET_TO)?,
        category: u16::from_le_bytes(read_array(data, OFFSET_CATEGORY)?),
        purpose_code: u16::from_le_bytes(read_array(data, OFFSET_PURPOSE)?),
        invoice_hash: read_array(data, OFFSET_INVOICE_HASH)?,
        invoice_amount: u64::from_le_bytes(read_array(data, OFFSET_INVOICE_AMOUNT)?),
        invoice_currency: read_array(data, OFFSET_INVOICE_CURRENCY)?,
        policy_version: u64::from_le_bytes(read_array(data, OFFSET_POLICY_VERSION)?),
        issued_at: i64::from_le_bytes(read_array(data, OFFSET_ISSUED_AT)?),
        expires_at: i64::from_le_bytes(read_array(data, OFFSET_EXPIRES_AT)?),
        checks_run: u32::from_le_bytes(read_array(data, OFFSET_CHECKS_RUN)?),
        checks_failed: u32::from_le_bytes(read_array(data, OFFSET_CHECKS_FAILED)?),
        packet_hash: read_array(data, OFFSET_PACKET_HASH)?,
    })
}

pub fn digest(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

pub fn checks_pass(clearance: &Clearance, required: u32) -> bool {
    (clearance.checks_run & required) == required && (clearance.checks_failed & required) == 0
}

pub fn signed_clearance(sysvar: &AccountInfo, policy_signer: &Pubkey) -> Result<(Clearance, [u8; 32])> {
    let current = solana_instructions_sysvar::load_current_index_checked(sysvar)
        .map_err(|_| error!(LeashError::MissingClearance))?;
    require!(current > 0, LeashError::MissingClearance);
    let ix = solana_instructions_sysvar::load_instruction_at_checked((current - 1) as usize, sysvar)
        .map_err(|_| error!(LeashError::MissingClearance))?;
    require!(
        ix.program_id == solana_sdk_ids::ed25519_program::ID,
        LeashError::MissingClearance
    );

    let data = &ix.data;
    require!(data.len() >= 16 && data[0] == 1 && data[1] == 0, LeashError::InvalidClearance);
    let pubkey_ix = read_u16(data, 8)?;
    let message_offset = read_u16(data, 10)?;
    let message_len = read_u16(data, 12)?;
    let message_ix = read_u16(data, 14)?;
    let signature_ix = read_u16(data, 4)?;
    require!(
        signature_ix == u16::MAX && pubkey_ix == u16::MAX && message_ix == u16::MAX,
        LeashError::InvalidClearance
    );
    require!(message_len as usize == LEN, LeashError::InvalidClearance);

    let pubkey = slice_at(data, read_u16(data, 6)?, 32)?;
    require!(pubkey == policy_signer.as_ref(), LeashError::MissingClearance);
    let message = slice_at(data, message_offset, LEN)?;
    let clearance = parse(message)?;
    Ok((clearance, digest(message)))
}

fn write_bytes(out: &mut [u8], offset: usize, bytes: &[u8]) {
    out[offset..offset + bytes.len()].copy_from_slice(bytes);
}

fn read_array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    let bytes = data
        .get(offset..offset + N)
        .ok_or_else(|| error!(LeashError::InvalidClearance))?;
    let mut out = [0u8; N];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(read_array(data, offset)?))
}

fn slice_at(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    let start = offset as usize;
    let end = start
        .checked_add(len)
        .ok_or_else(|| error!(LeashError::InvalidClearance))?;
    data.get(start..end)
        .ok_or_else(|| error!(LeashError::InvalidClearance))
}
