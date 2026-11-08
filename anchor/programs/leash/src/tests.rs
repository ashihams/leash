use crate::{
    CorridorId, Escrow, EscrowState, MandateParams, ID as PROGRAM_ID, CHECK_BUYER_AUTH,
    DECISION_ALLOW, DECISION_DENY, KIND_FUND, KIND_RELEASE, LEN, VERSION,
};
use anchor_lang::prelude::borsh::{to_vec, BorshSerialize};
use anchor_lang::prelude::AccountDeserialize;
use anchor_lang::system_program;
use ed25519_dalek::Signer as DalekSigner;
use litesvm::LiteSVM;
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};

const SOL: u64 = 1_000_000_000;
const NOW: i64 = 1_700_000_000;
const BUDGET: u64 = 200_000_000;
const LIMIT: u64 = 150_000_000;
const PAYMENT: u64 = 100_000_000;
const MANDATE_ID: u64 = 7;
const FROM: [u8; 2] = *b"US";
const TO: [u8; 2] = *b"US";
const REQUIRED: u32 = (1 << 12) - 1;

const TOKEN_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ED25519_PROGRAM: Pubkey =
    Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS: Pubkey =
    Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    vendor: Keypair,
    policy: Keypair,
    verifier: Keypair,
    mint: Pubkey,
    mandate: Pubkey,
}

trait Pack: BorshSerialize {
    fn pack(&self) -> Vec<u8> {
        to_vec(self).unwrap()
    }
}

impl<T: BorshSerialize> Pack for T {}

fn discriminator(name: &str) -> [u8; 8] {
    let hash = solana_sha256_hasher::hash(format!("global:{name}").as_bytes()).to_bytes();
    hash[..8].try_into().unwrap()
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &PROGRAM_ID).0
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn payment_id(tag: u8) -> [u8; 32] {
    let mut id = [4u8; 32];
    id[0] = tag;
    id
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let tx = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        signers,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

#[track_caller]
fn must(
    result: Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>,
) {
    if let Err(err) = result {
        panic!("{:?}\n{}", err.err, err.meta.pretty_logs());
    }
}

fn assert_msg(err: litesvm::types::FailedTransactionMetadata, message: &str) {
    let logs = err.meta.pretty_logs();
    assert!(logs.contains(message), "{:?}\n{logs}", err.err);
}

fn set_time(svm: &mut LiteSVM, now: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = now;
    svm.set_sysvar(&clock);
}

fn ix(name: &str, args: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = discriminator(name).to_vec();
    data.extend(args);
    Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data,
    }
}

fn ed25519_ix(message: &[u8], signer: &Keypair) -> Instruction {
    let secret = signer.to_bytes();
    let seed: [u8; 32] = secret[..32].try_into().unwrap();
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let signature = DalekSigner::sign(&signing, message);
    let ix = solana_ed25519_program::new_ed25519_instruction_with_signature(
        message,
        &signature.to_bytes(),
        signer.pubkey().as_array(),
    );
    Instruction {
        program_id: ED25519_PROGRAM,
        accounts: vec![],
        data: ix.data,
    }
}

fn create_account_ix(payer: &Pubkey, new_account: &Pubkey, lamports: u64, space: u64, owner: &Pubkey) -> Instruction {
    let mut data = vec![0, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: system_program::ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*new_account, true),
        ],
        data,
    }
}

fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![],
    }
}

fn token_amount(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let data = svm.get_account(account).expect("token account").data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn load_escrow(svm: &LiteSVM, payment: &[u8; 32]) -> Escrow {
    let account = svm.get_account(&pda(&[b"escrow", payment])).expect("escrow");
    let mut data: &[u8] = &account.data;
    Escrow::try_deserialize(&mut data).expect("escrow data")
}

fn clearance(
    env: &Env,
    kind: u8,
    decision: u8,
    payment: [u8; 32],
    amount: u64,
    vendor: Pubkey,
    mint: Pubkey,
) -> crate::Clearance {
    crate::Clearance {
        version: VERSION,
        kind,
        decision,
        payment_id: payment,
        mandate: env.mandate,
        buyer: env.owner.pubkey(),
        vendor,
        mint,
        amount,
        from_country: FROM,
        to_country: TO,
        category: 7,
        purpose_code: 1001,
        invoice_hash: [9u8; 32],
        invoice_amount: amount,
        invoice_currency: *b"USD\0",
        policy_version: 1,
        issued_at: NOW,
        expires_at: NOW + 600,
        checks_run: REQUIRED,
        checks_failed: 0,
        packet_hash: [0u8; 32],
    }
}

fn fund_ix(env: &Env, payment: [u8; 32], vendor: &Pubkey) -> Instruction {
    let mut args = Vec::new();
    args.extend(payment.pack());
    args.extend(MANDATE_ID.pack());
    args.extend(FROM.pack());
    args.extend(TO.pack());
    ix(
        "create_and_fund",
        args,
        vec![
            AccountMeta::new(env.agent.pubkey(), true),
            AccountMeta::new_readonly(env.owner.pubkey(), false),
            AccountMeta::new(env.mandate, false),
            AccountMeta::new_readonly(pda(&[b"config"]), false),
            AccountMeta::new(pda(&[b"corridor", &FROM, &TO]), false),
            AccountMeta::new_readonly(pda(&[b"treasury", env.mandate.as_ref()]), false),
            AccountMeta::new(pda(&[b"treasury-vault", env.mandate.as_ref()]), false),
            AccountMeta::new(pda(&[b"escrow", &payment]), false),
            AccountMeta::new(pda(&[b"escrow-vault", &payment]), false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(*vendor, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    )
}

fn release_ix(env: &Env, payment: [u8; 32], vendor: &Pubkey) -> Instruction {
    ix(
        "release",
        payment.pack(),
        vec![
            AccountMeta::new(env.agent.pubkey(), true),
            AccountMeta::new(pda(&[b"escrow", &payment]), false),
            AccountMeta::new(pda(&[b"escrow-vault", &payment]), false),
            AccountMeta::new_readonly(pda(&[b"config"]), false),
            AccountMeta::new_readonly(pda(&[b"corridor", &FROM, &TO]), false),
            AccountMeta::new_readonly(*vendor, false),
            AccountMeta::new(ata(vendor, &env.mint), false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
    )
}

fn refund_ix(env: &Env, payment: [u8; 32]) -> Instruction {
    ix(
        "refund",
        payment.pack(),
        vec![
            AccountMeta::new(env.owner.pubkey(), true),
            AccountMeta::new(pda(&[b"escrow", &payment]), false),
            AccountMeta::new(pda(&[b"escrow-vault", &payment]), false),
            AccountMeta::new(ata(&env.owner.pubkey(), &env.mint), false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
    )
}

fn delivery_artifact() -> Vec<u8> {
    b"DLV1north-studio-logo".to_vec()
}

fn delivery_hash() -> [u8; 32] {
    solana_sha256_hasher::hash(&delivery_artifact()).to_bytes()
}

fn submit_delivery_ix(env: &Env, payment: [u8; 32], receipt_hash: [u8; 32]) -> Instruction {
    let mut args = payment.pack();
    args.extend(MANDATE_ID.pack());
    args.extend(receipt_hash.pack());
    ix(
        "submit_delivery",
        args,
        vec![
            AccountMeta::new_readonly(env.vendor.pubkey(), true),
            AccountMeta::new_readonly(env.owner.pubkey(), false),
            AccountMeta::new_readonly(env.mandate, false),
            AccountMeta::new(pda(&[b"escrow", &payment]), false),
        ],
    )
}

fn verify_ix(env: &Env, payment: [u8; 32], artifact: &[u8]) -> Instruction {
    let mut args = payment.pack();
    args.extend(artifact.pack());
    ix(
        "verify_delivery",
        args,
        vec![
            AccountMeta::new_readonly(env.verifier.pubkey(), true),
            AccountMeta::new_readonly(pda(&[b"config"]), false),
            AccountMeta::new(pda(&[b"escrow", &payment]), false),
        ],
    )
}

fn mark_delivered(env: &mut Env, payment: [u8; 32]) {
    let receipt = delivery_hash();
    let ix = submit_delivery_ix(env, payment, receipt);
    must(send(&mut env.svm, &env.vendor, &[ix], &[&env.vendor]));
}

fn mark_verified(env: &mut Env, payment: [u8; 32]) {
    let artifact = delivery_artifact();
    let ix = verify_ix(env, payment, &artifact);
    must(send(&mut env.svm, &env.verifier, &[ix], &[&env.verifier]));
}

fn fund(
    env: &mut Env,
    signed: &crate::Clearance,
    vendor: Pubkey,
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let message = crate::encode(signed);
    let ed = ed25519_ix(&message, &env.policy);
    let funding = fund_ix(env, signed.payment_id, &vendor);
    send(&mut env.svm, &env.agent, &[ed, funding], &[&env.agent])
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(PROGRAM_ID, include_bytes!("../../../target/deploy/leash.so"))
        .unwrap();
    let owner = Keypair::new();
    let agent = Keypair::new();
    let vendor = Keypair::new();
    let policy = Keypair::new();
    let verifier = Keypair::new();
    let mint = Keypair::new();
    svm.airdrop(&owner.pubkey(), 20 * SOL).unwrap();
    svm.airdrop(&agent.pubkey(), 20 * SOL).unwrap();
    svm.airdrop(&vendor.pubkey(), 2 * SOL).unwrap();
    svm.airdrop(&verifier.pubkey(), 2 * SOL).unwrap();

    let mint_rent = svm.minimum_balance_for_rent_exemption(82);
    let mut init_mint = vec![20, 6];
    init_mint.extend(owner.pubkey().as_ref());
    init_mint.push(0);
    must(send(
        &mut svm,
        &owner,
        &[
            create_account_ix(&owner.pubkey(), &mint.pubkey(), mint_rent, 82, &TOKEN_PROGRAM),
            Instruction {
                program_id: TOKEN_PROGRAM,
                accounts: vec![AccountMeta::new(mint.pubkey(), false)],
                data: init_mint,
            },
        ],
        &[&owner, &mint],
    ));
    must(send(
        &mut svm,
        &owner,
        &[create_ata_ix(&owner.pubkey(), &owner.pubkey(), &mint.pubkey())],
        &[&owner],
    ));
    must(send(
        &mut svm,
        &owner,
        &[create_ata_ix(&owner.pubkey(), &vendor.pubkey(), &mint.pubkey())],
        &[&owner],
    ));
    let mut mint_to = vec![7];
    mint_to.extend_from_slice(&BUDGET.to_le_bytes());
    must(send(
        &mut svm,
        &owner,
        &[Instruction {
            program_id: TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(mint.pubkey(), false),
                AccountMeta::new(ata(&owner.pubkey(), &mint.pubkey()), false),
                AccountMeta::new_readonly(owner.pubkey(), true),
            ],
            data: mint_to,
        }],
        &[&owner],
    ));

    let mut initialize = policy.pubkey().pack();
    initialize.extend(verifier.pubkey().pack());
    initialize.extend(1u64.pack());
    initialize.extend(REQUIRED.pack());
    must(send(
        &mut svm,
        &owner,
        &[ix(
            "initialize",
            initialize,
            vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new(pda(&[b"config"]), false),
                AccountMeta::new_readonly(mint.pubkey(), false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )],
        &[&owner],
    ));

    let mut corridor_args = Vec::new();
    corridor_args.extend(FROM.pack());
    corridor_args.extend(TO.pack());
    corridor_args.extend(true.pack());
    corridor_args.extend(LIMIT.pack());
    corridor_args.extend(BUDGET.pack());
    corridor_args.extend(0u64.pack());
    must(send(
        &mut svm,
        &owner,
        &[ix(
            "init_corridor",
            corridor_args,
            vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(pda(&[b"config"]), false),
                AccountMeta::new(pda(&[b"corridor", &FROM, &TO]), false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )],
        &[&owner],
    ));

    let mandate = pda(&[b"mandate", owner.pubkey().as_ref(), &MANDATE_ID.to_le_bytes()]);
    let params = MandateParams {
        agent: agent.pubkey(),
        budget: BUDGET,
        per_payment_limit: LIMIT,
        max_uses: 4,
        expires_at: NOW + 86_400,
        delivery_seconds: 3_600,
        acceptance_seconds: 3_600,
        category: 7,
        allowed_corridors: vec![CorridorId {
            from_country: FROM,
            to_country: TO,
        }],
    };
    let mut mandate_args = MANDATE_ID.pack();
    mandate_args.extend(params.pack());
    must(send(
        &mut svm,
        &owner,
        &[ix(
            "create_mandate",
            mandate_args,
            vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new(mandate, false),
                AccountMeta::new_readonly(pda(&[b"treasury", mandate.as_ref()]), false),
                AccountMeta::new(pda(&[b"treasury-vault", mandate.as_ref()]), false),
                AccountMeta::new_readonly(mint.pubkey(), false),
                AccountMeta::new_readonly(pda(&[b"config"]), false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )],
        &[&owner],
    ));

    let mut deposit_args = MANDATE_ID.pack();
    deposit_args.extend(BUDGET.pack());
    must(send(
        &mut svm,
        &owner,
        &[ix(
            "deposit",
            deposit_args,
            vec![
                AccountMeta::new_readonly(owner.pubkey(), true),
                AccountMeta::new_readonly(mandate, false),
                AccountMeta::new(ata(&owner.pubkey(), &mint.pubkey()), false),
                AccountMeta::new(pda(&[b"treasury-vault", mandate.as_ref()]), false),
                AccountMeta::new_readonly(mint.pubkey(), false),
                AccountMeta::new_readonly(pda(&[b"config"]), false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            ],
        )],
        &[&owner],
    ));

    set_time(&mut svm, NOW);
    Env {
        svm,
        owner,
        agent,
        vendor,
        policy,
        verifier,
        mint: mint.pubkey(),
        mandate,
    }
}

#[test]
fn clearance_layout_is_fixed_at_288_bytes() {
    let owner = Keypair::new().pubkey();
    let vendor = Keypair::new().pubkey();
    let mint = Keypair::new().pubkey();
    let mandate = Keypair::new().pubkey();
    let sample = crate::Clearance {
        version: VERSION,
        kind: KIND_FUND,
        decision: DECISION_ALLOW,
        payment_id: payment_id(1),
        mandate,
        buyer: owner,
        vendor,
        mint,
        amount: PAYMENT,
        from_country: FROM,
        to_country: TO,
        category: 7,
        purpose_code: 1001,
        invoice_hash: [9u8; 32],
        invoice_amount: PAYMENT,
        invoice_currency: *b"USD\0",
        policy_version: 1,
        issued_at: NOW,
        expires_at: NOW + 600,
        checks_run: CHECK_BUYER_AUTH,
        checks_failed: 0,
        packet_hash: [1u8; 32],
    };
    let bytes = crate::encode(&sample);
    assert_eq!(bytes.len(), LEN);
    assert_eq!(u64::from_le_bytes(bytes[164..172].try_into().unwrap()), PAYMENT);
    let parsed = crate::parse(&bytes).unwrap();
    assert_eq!(parsed.vendor, vendor);
    let mut tampered = bytes;
    tampered[100] ^= 1;
    assert_ne!(crate::parse(&tampered).unwrap().vendor, vendor);
}

#[test]
fn compromised_agent_full_budget_proposal_cannot_fund() {
    // Same attacker and full-budget proposal as POST /agent/run simulation.
    // Test-only signing deliberately attempts to bypass the HTTP gate so the
    // deployed program must enforce its own existing boundaries as well.
    let mut env = setup();
    let attacker = Pubkey::from_str_const("2VwugjK6VhAJmsP8kKr71PZvjEPiqdN3snNW1v5bMXzn");
    env.svm.airdrop(&attacker, SOL).unwrap();
    let vault = pda(&[b"treasury-vault", env.mandate.as_ref()]);
    let before = token_amount(&env.svm, &vault);
    let denied = clearance(&env, KIND_FUND, DECISION_DENY, payment_id(90), BUDGET, attacker, env.mint);
    assert!(fund(&mut env, &denied, attacker).is_err());
    assert!(env.svm.get_account(&pda(&[b"escrow", &denied.payment_id])).is_none());

    let forced_allow = clearance(&env, KIND_FUND, DECISION_ALLOW, payment_id(91), BUDGET, attacker, env.mint);
    assert_msg(fund(&mut env, &forced_allow, attacker).unwrap_err(), "PAYMENT_LIMIT_EXCEEDED");
    assert!(env.svm.get_account(&pda(&[b"escrow", &forced_allow.payment_id])).is_none());
    assert_eq!(token_amount(&env.svm, &vault), before);
    assert!(env.svm.get_account(&ata(&attacker, &env.mint)).is_none());
}

#[test]
fn funds_releases_and_rejects_a_second_release() {
    let mut env = setup();
    let payment = payment_id(1);
    let vendor = env.vendor.pubkey();
    let signed = clearance(&env, KIND_FUND, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    must(fund(&mut env, &signed, vendor));
    assert_eq!(token_amount(&env.svm, &pda(&[b"treasury-vault", env.mandate.as_ref()])), BUDGET - PAYMENT);
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Funded);

    let release_clearance = clearance(&env, KIND_RELEASE, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    let message = crate::encode(&release_clearance);
    let ed = ed25519_ix(&message, &env.policy);
    let release = release_ix(&env, payment, &vendor);
    assert_msg(
        send(&mut env.svm, &env.agent, &[ed, release], &[&env.agent]).unwrap_err(),
        "BAD_STATE",
    );

    env.svm.expire_blockhash();
    mark_delivered(&mut env, payment);
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Delivered);
    let bad = b"DLV1not-the-receipt".to_vec();
    let bad_ix = verify_ix(&env, payment, &bad);
    assert_msg(
        send(&mut env.svm, &env.verifier, &[bad_ix], &[&env.verifier]).unwrap_err(),
        "BAD_RECEIPT",
    );
    mark_verified(&mut env, payment);
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Verified);

    env.svm.expire_blockhash();
    let ed = ed25519_ix(&message, &env.policy);
    let release = release_ix(&env, payment, &vendor);
    must(send(&mut env.svm, &env.agent, &[ed, release], &[&env.agent]));
    assert_eq!(token_amount(&env.svm, &ata(&vendor, &env.mint)), PAYMENT);
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Released);

    env.svm.expire_blockhash();
    let ed = ed25519_ix(&message, &env.policy);
    let release = release_ix(&env, payment, &vendor);
    let again = send(&mut env.svm, &env.agent, &[ed, release], &[&env.agent]);
    assert!(again.is_err(), "a second release must fail");
}

#[test]
fn swapped_vendor_amount_mint_mandate_and_corridor_fail() {
    let mut env = setup();
    let payment = payment_id(2);
    let vendor = env.vendor.pubkey();
    let mut signed = clearance(&env, KIND_FUND, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    let other_vendor = Keypair::new().pubkey();
    let err = fund(&mut env, &signed, other_vendor).unwrap_err();
    assert_msg(err, "CLEARANCE_MISMATCH");

    let message = crate::encode(&signed);
    let mut tampered = ed25519_ix(&message, &env.policy);
    let message_offset = u16::from_le_bytes(tampered.data[10..12].try_into().unwrap()) as usize;
    tampered.data[message_offset + 164] ^= 0xff;
    let funding = fund_ix(&env, payment, &vendor);
    let err = send(&mut env.svm, &env.agent, &[tampered, funding], &[&env.agent]);
    assert!(err.is_err(), "changed amount must fail");

    signed.mint = Keypair::new().pubkey();
    assert_msg(fund(&mut env, &signed, vendor).unwrap_err(), "MINT_MISMATCH");

    signed.mint = env.mint;
    signed.mandate = Keypair::new().pubkey();
    assert_msg(fund(&mut env, &signed, vendor).unwrap_err(), "CLEARANCE_MISMATCH");

    signed.mandate = env.mandate;
    signed.from_country = *b"IN";
    assert_msg(fund(&mut env, &signed, vendor).unwrap_err(), "CLEARANCE_MISMATCH");
}

#[test]
fn missing_expired_over_limit_and_revoked_clearances_fail() {
    let mut env = setup();
    let payment = payment_id(3);
    let vendor = env.vendor.pubkey();
    let signed = clearance(&env, KIND_FUND, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    let funding = fund_ix(&env, payment, &vendor);
    let err = send(&mut env.svm, &env.agent, &[funding], &[&env.agent]).unwrap_err();
    assert_msg(err, "MISSING_CLEARANCE");

    let mut expired = signed.clone();
    expired.issued_at = NOW - 10;
    expired.expires_at = NOW - 1;
    assert_msg(fund(&mut env, &expired, vendor).unwrap_err(), "EXPIRED_CLEARANCE");

    let mut too_big = signed.clone();
    too_big.amount = LIMIT + 1;
    too_big.invoice_amount = LIMIT + 1;
    assert_msg(fund(&mut env, &too_big, vendor).unwrap_err(), "PAYMENT_LIMIT_EXCEEDED");

    let revoke_args = MANDATE_ID.pack();
    must(send(
        &mut env.svm,
        &env.owner,
        &[ix(
            "revoke_mandate",
            revoke_args,
            vec![
                AccountMeta::new_readonly(env.owner.pubkey(), true),
                AccountMeta::new(env.mandate, false),
            ],
        )],
        &[&env.owner],
    ));
    assert_msg(fund(&mut env, &signed, vendor).unwrap_err(), "MANDATE_REVOKED");
}

#[test]
fn disabled_corridor_blocks_release_and_owner_can_refund_after_deadline() {
    let mut env = setup();
    let payment = payment_id(4);
    let vendor = env.vendor.pubkey();
    let signed = clearance(&env, KIND_FUND, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    must(fund(&mut env, &signed, vendor));
    mark_delivered(&mut env, payment);
    mark_verified(&mut env, payment);

    let mut update = Vec::new();
    update.extend(FROM.pack());
    update.extend(TO.pack());
    update.extend(false.pack());
    update.extend(LIMIT.pack());
    update.extend(BUDGET.pack());
    update.extend(0u64.pack());
    must(send(
        &mut env.svm,
        &env.owner,
        &[ix(
            "set_corridor",
            update,
            vec![
                AccountMeta::new_readonly(env.owner.pubkey(), true),
                AccountMeta::new_readonly(pda(&[b"config"]), false),
                AccountMeta::new(pda(&[b"corridor", &FROM, &TO]), false),
            ],
        )],
        &[&env.owner],
    ));

    let release_clearance = clearance(&env, KIND_RELEASE, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    let message = crate::encode(&release_clearance);
    let ed = ed25519_ix(&message, &env.policy);
    let release = release_ix(&env, payment, &vendor);
    let err = send(&mut env.svm, &env.agent, &[ed, release], &[&env.agent]).unwrap_err();
    assert_msg(err, "CORRIDOR_BLOCKED");
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Verified);

    let refund = refund_ix(&env, payment);
    assert_msg(send(&mut env.svm, &env.owner, &[refund], &[&env.owner]).unwrap_err(), "REFUND_TOO_EARLY");
    set_time(&mut env.svm, NOW + 3_600);
    env.svm.expire_blockhash();
    let refund = refund_ix(&env, payment);
    must(send(&mut env.svm, &env.owner, &[refund], &[&env.owner]));
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Refunded);
    assert_eq!(token_amount(&env.svm, &ata(&env.owner.pubkey(), &env.mint)), PAYMENT);
    let mandate_account = env.svm.get_account(&env.mandate).unwrap();
    let mut data: &[u8] = &mandate_account.data;
    let mandate = crate::Mandate::try_deserialize(&mut data).unwrap();
    assert_eq!(mandate.spent, PAYMENT);
}

#[test]
fn signed_deny_disputes_and_admin_refunds_without_restoring_budget() {
    let mut env = setup();
    let payment = payment_id(5);
    let vendor = env.vendor.pubkey();
    let signed = clearance(&env, KIND_FUND, DECISION_ALLOW, payment, PAYMENT, vendor, env.mint);
    must(fund(&mut env, &signed, vendor));
    let deny = clearance(&env, KIND_RELEASE, DECISION_DENY, payment, PAYMENT, vendor, env.mint);
    let message = crate::encode(&deny);
    let ed = ed25519_ix(&message, &env.policy);
    let release = release_ix(&env, payment, &vendor);
    must(send(&mut env.svm, &env.agent, &[ed, release], &[&env.agent]));
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Disputed);

    must(send(
        &mut env.svm,
        &env.owner,
        &[ix(
            "admin_refund",
            payment.pack(),
            vec![
                AccountMeta::new(env.owner.pubkey(), true),
                AccountMeta::new_readonly(pda(&[b"config"]), false),
                AccountMeta::new(pda(&[b"escrow", &payment]), false),
                AccountMeta::new(pda(&[b"escrow-vault", &payment]), false),
                AccountMeta::new_readonly(env.owner.pubkey(), false),
                AccountMeta::new(ata(&env.owner.pubkey(), &env.mint), false),
                AccountMeta::new_readonly(env.mint, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
            ],
        )],
        &[&env.owner],
    ));
    assert_eq!(load_escrow(&env.svm, &payment).state, EscrowState::Refunded);
    let mandate_account = env.svm.get_account(&env.mandate).unwrap();
    let mut data: &[u8] = &mandate_account.data;
    assert_eq!(crate::Mandate::try_deserialize(&mut data).unwrap().spent, PAYMENT);
}
