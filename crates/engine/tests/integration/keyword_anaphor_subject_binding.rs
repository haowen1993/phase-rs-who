//! Subject binding for the keyword-presence anaphor — "If it doesn't have
//! <keyword>, …" (Kang Prime, Jhoira of the Ghitu, Suspend, Delay, Momentum
//! Rumbler, …).
//!
//! `it` is an ANAPHOR to the object introduced by the preceding instruction, by
//! the ability's cost, or by the trigger condition — never to the ability's
//! source. Which rule supplies the referent depends on the binding class:
//!
//!   * CR 608.2c — a referent introduced by a PRECEDING INSTRUCTION of the same
//!     effect. "Read the whole text and apply the rules of English to the text":
//!     `it` in "Put two time counters on that card. If it doesn't have suspend"
//!     is the nonland card the earlier sentence exiled (Kang Prime, Suspend,
//!     Delay, Doom's Time Platform).
//!   * CR 608.2k — a referent previously referred to by the ability's COST or
//!     TRIGGER CONDITION, which keeps pointing at that object even after its
//!     characteristics change (Jhoira of the Ghitu's cost-paid card; Momentum
//!     Rumbler's attacking creature).
//!
//! The parser used to lower it to
//! `AbilityCondition::SourceLacksKeyword`, whose evaluator reads
//! `ability.source_id`, so the gate was unconditionally TRUE for every card
//! whose `it` is not the source. The observable symptom is a redundant grant
//! onto a card that already has the keyword, which clobbers the card's PRINTED
//! keyword parameters: `off_zone_characteristics::upsert_keyword_contribution`
//! replaces a same-kind contribution unless the keyword is a summing keyword,
//! and `Keyword::instances_must_coexist` does not list Suspend. A card exiled
//! with printed `Suspend 4—{U}` came back as `Suspend 0—{}`.
//!
//! One module per RUNTIME BINDING CLASS, because the referent lives in a
//! different slot per clause shape. Note the two distinct condition-evaluation
//! seams in `game::effects::resolve_chain_body`:
//!
//!   * the SUB-ABILITY gate, which passes the PARENT node as the condition
//!     ability — used by `injected_target` and `declared_stack_target` below;
//!   * the TOP-LEVEL gate, which passes the RESOLVING node itself — used by
//!     `top_level_trigger_source` below, and by no other module here. That is
//!     where an intervening-"if" condition is rechecked on resolution
//!     (CR 603.4 + CR 608.2a).
//!
//! The cost-paid binding class (Jhoira of the Ghitu) is covered in
//! `crates/engine/src/game/casting_tests.rs`, next to the pre-existing
//! activation-pipeline test it must not regress.

use engine::game::combat::AttackTarget;
use engine::game::keywords::{effective_suspend_cost, object_has_effective_keyword_kind};
use engine::game::scenario::{GameRunner, GameScenario, P0, P1};
use engine::types::actions::GameAction;
use engine::types::counter::CounterType;
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::keywords::{Keyword, KeywordKind};
use engine::types::mana::{ManaCost, ManaCostShard};
use engine::types::zones::Zone;
use engine::types::Phase;

/// Verbatim Oracle text (reminder text elided — it is stripped before dispatch).
const KANG_PRIME: &str = "Flying\nWhenever Kang Prime enters or attacks, exile cards \
    from the top of your library until you exile a nonland card. Put two time counters \
    on that card. If it doesn't have suspend, it gains suspend.";

const MOMENTUM_RUMBLER: &str = "Whenever this creature attacks, if it doesn't have \
    first strike, put a first strike counter on it.\nWhenever this creature attacks, \
    if it has first strike, it gains double strike until end of turn.";

const SUSPEND_CARD: &str = "Exile target creature and put two time counters on it. \
    If it doesn't have suspend, it gains suspend.";

/// `{U}` — the printed suspend cost the redundant grant used to clobber to `{0}`.
fn blue_mana_cost() -> ManaCost {
    ManaCost::Cost {
        shards: vec![ManaCostShard::Blue],
        generic: 0,
    }
}

/// Printed `Suspend 4—{U}` — the parameters the redundant grant used to clobber.
fn printed_suspend_four_blue() -> Keyword {
    Keyword::Suspend {
        count: 4,
        cost: blue_mana_cost(),
    }
}

/// Drive the pipeline to the ONE terminal state these scenarios may end in: an
/// empty stack at a priority window.
///
/// Every other exit is a test failure, not a stopping condition. An action
/// error, an unanticipated prompt, or running out of steps all mean the chain
/// under test never resolved — and the assertions downstream are written so a
/// stalled game passes them for the wrong reason: a card still sitting in the
/// library trivially has no suspend, no time counters, and is not the source.
/// Returning quietly from here would turn every one of them into coverage
/// theatre, so each non-terminal exit panics with the state that caused it.
fn settle(runner: &mut GameRunner) {
    for _ in 0..60 {
        match runner.state().waiting_for.clone() {
            WaitingFor::OrderTriggers { .. } => {
                engine::game::triggers::drain_order_triggers_with_identity(runner.state_mut());
            }
            WaitingFor::TriggerTargetSelection { .. } | WaitingFor::TargetSelection { .. } => {
                runner
                    .choose_first_legal_target()
                    .expect("a pending target selection must offer a legal target");
            }
            WaitingFor::Priority { .. } => {
                if runner.state().stack.is_empty() {
                    return;
                }
                runner
                    .act(GameAction::PassPriority)
                    .expect("passing priority on a non-empty stack must be legal");
            }
            other => panic!("unexpected prompt while settling the stack: {other:?}"),
        }
    }
    panic!(
        "the stack never emptied within 60 steps (waiting_for = {:?}, stack depth = {})",
        runner.state().waiting_for,
        runner.state().stack.len(),
    );
}

/// Binding class 1 — the referent is INJECTED into the parent's `targets` by the
/// producing instruction (`ExileFromTopUntil` stamps the hit onto the sub-chain).
/// Evaluated at the sub-ability gate with the `PutCounter` parent as the
/// condition ability. Kang Prime and The Tenth Doctor share this shape.
mod injected_target {
    use super::*;

    fn kang_scenario(library_card_has_printed_suspend: bool) -> (GameRunner, ObjectIdPair) {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);

        let kang = scenario
            .add_creature_from_oracle(P0, "Kang Prime", 3, 5, KANG_PRIME)
            .id();

        let mut builder = scenario.add_spell_to_library_top(P0, "Exiled Sorcery", false);
        if library_card_has_printed_suspend {
            builder.with_keyword(printed_suspend_four_blue());
        }
        let exiled = builder.id();

        (scenario.build(), ObjectIdPair { kang, exiled })
    }

    struct ObjectIdPair {
        kang: ObjectId,
        exiled: ObjectId,
    }

    /// THE FIX. CR 608.2c + CR 702.62a: `it` is the card the PRECEDING
    /// instruction exiled, and that card already has printed `Suspend 4—{U}`, so
    /// the gate must be FALSE and no grant may fire.
    ///
    /// Revert-fail: with `SourceLacksKeyword`, the gate reads Kang Prime (which
    /// never has suspend), fires the grant, and
    /// `upsert_keyword_contribution` overwrites the printed contribution with
    /// the granted `Suspend { count: 0, cost: {} }` — so
    /// `effective_off_zone_keyword` returns `Suspend 0—{}` and this assertion
    /// fails.
    #[test]
    fn natively_suspended_exiled_card_keeps_its_printed_parameters() {
        let (mut runner, ids) = kang_scenario(true);

        runner.advance_to_combat();
        runner
            .declare_attackers(&[(ids.kang, AttackTarget::Player(P1))])
            .expect("Kang Prime must be able to attack");
        settle(&mut runner);

        // Reach-guard: the chain actually ran — the card left the library for
        // exile and took its two time counters (CR 122.1).
        assert_eq!(
            runner.state().objects[&ids.exiled].zone,
            Zone::Exile,
            "the nonland card must be exiled by ExileFromTopUntil"
        );
        assert_eq!(
            runner.state().objects[&ids.exiled]
                .counters
                .get(&CounterType::Time)
                .copied(),
            Some(2),
            "CR 122.1: the exiled card must carry two time counters"
        );

        // CR 702.62a: "Suspend N—[cost]" — the printed parameters must survive.
        assert_eq!(
            effective_suspend_cost(runner.state(), ids.exiled),
            Some(blue_mana_cost()),
            "the anaphor must read the EXILED CARD: it already has suspend, so no \
             redundant grant may clobber its printed Suspend 4—{{U}} down to {{0}}"
        );
    }

    /// Positive sibling — the gate is not vacuously false. A card WITHOUT
    /// printed suspend still gains it (CR 702.62a), so the fix narrows the gate
    /// rather than disabling it.
    #[test]
    fn exiled_card_without_suspend_still_gains_it() {
        let (mut runner, ids) = kang_scenario(false);

        runner.advance_to_combat();
        runner
            .declare_attackers(&[(ids.kang, AttackTarget::Player(P1))])
            .expect("Kang Prime must be able to attack");
        settle(&mut runner);

        assert_eq!(
            runner.state().objects[&ids.exiled].zone,
            Zone::Exile,
            "the nonland card must be exiled by ExileFromTopUntil"
        );
        assert_eq!(
            runner.state().objects[&ids.exiled]
                .counters
                .get(&CounterType::Time)
                .copied(),
            Some(2),
            "CR 122.1: the exiled card must carry two time counters"
        );
        assert!(
            object_has_effective_keyword_kind(runner.state(), ids.exiled, KeywordKind::Suspend),
            "a card with no printed suspend must still gain it"
        );
    }

    /// Hostile fixture — no legal referent. With an empty library the
    /// `ExileFromTopUntil` finds no nonland hit, so the gated sub-chain never
    /// runs: no panic, no grant, and Kang Prime itself must not be touched.
    #[test]
    fn no_nonland_hit_grants_nothing_and_does_not_touch_the_source() {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let kang = scenario
            .add_creature_from_oracle(P0, "Kang Prime", 3, 5, KANG_PRIME)
            .id();
        let mut runner = scenario.build();

        runner.advance_to_combat();
        runner
            .declare_attackers(&[(kang, AttackTarget::Player(P1))])
            .expect("Kang Prime must be able to attack");
        settle(&mut runner);

        assert!(
            !object_has_effective_keyword_kind(runner.state(), kang, KeywordKind::Suspend),
            "the ability's SOURCE must never be the anaphor's referent"
        );
        assert_eq!(
            runner.state().objects[&kang]
                .counters
                .get(&CounterType::Time)
                .copied()
                .unwrap_or(0),
            0,
            "no time counters may land on the source"
        );
    }
}

/// Binding class 2 — the condition sits on the TOP-LEVEL `execute` node, so the
/// resolving node itself is the condition ability. Its `targets` are empty (a
/// `SelfRef`-slotted `PutCounter` declares no choosable slot), so the subject
/// resolves through `TargetMatchesFilter`'s `TriggeringSource` fallback against
/// the singleton `AttackersDeclared` event.
///
/// Momentum Rumbler is the only corpus card on this seam, and it is the
/// REGRESSION TRIPWIRE: its `it` really is the trigger source, so behavior must
/// be identical before and after the lowering change.
mod top_level_trigger_source {
    use super::*;

    fn first_strike_counters(runner: &GameRunner, id: ObjectId) -> u32 {
        runner.state().objects[&id]
            .counters
            .get(&CounterType::Keyword(KeywordKind::FirstStrike))
            .copied()
            .unwrap_or(0)
    }

    /// CR 603.4 + CR 608.2a: the "if it doesn't have first strike" clause is an
    /// intervening "if", rechecked as the ability resolves. With no first
    /// strike the gate is true and the counter is placed.
    #[test]
    fn attacker_without_first_strike_gets_the_counter() {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let rumbler = scenario
            .add_creature_from_oracle(P0, "Momentum Rumbler", 4, 4, MOMENTUM_RUMBLER)
            .id();
        let mut runner = scenario.build();

        runner.advance_to_combat();
        runner
            .declare_attackers(&[(rumbler, AttackTarget::Player(P1))])
            .expect("Momentum Rumbler must be able to attack");
        settle(&mut runner);

        assert_eq!(
            first_strike_counters(&runner, rumbler),
            1,
            "CR 122.1: the attacker must receive exactly one first strike counter"
        );
        // Deliberately NOT asserted here: whether the card's second trigger also
        // grants double strike. Both attack triggers go on the stack together and
        // CR 603.3b lets their controller order them, so the affirmative twin
        // sees first strike only if it resolves after this one. That ordering is
        // untouched by this change; the affirmative twin's own gate is pinned in
        // `attacker_with_first_strike_gets_no_counter`, where first strike is
        // present before either trigger resolves.
    }

    /// Negative branch — a printed first strike makes the gate false, so no
    /// counter is placed. Paired with the positive case above, so neither
    /// assertion is vacuous.
    #[test]
    fn attacker_with_first_strike_gets_no_counter() {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let rumbler = {
            let mut builder =
                scenario.add_creature_from_oracle(P0, "Momentum Rumbler", 4, 4, MOMENTUM_RUMBLER);
            builder.first_strike();
            builder.id()
        };
        let mut runner = scenario.build();

        runner.advance_to_combat();
        runner
            .declare_attackers(&[(rumbler, AttackTarget::Player(P1))])
            .expect("Momentum Rumbler must be able to attack");
        settle(&mut runner);

        assert_eq!(
            first_strike_counters(&runner, rumbler),
            0,
            "an attacker that already has first strike must not receive the counter"
        );
        assert!(
            object_has_effective_keyword_kind(runner.state(), rumbler, KeywordKind::DoubleStrike),
            "reach-guard: the affirmative twin still fires, proving the trigger ran"
        );
    }

    /// Hostile fixture, seam-critical. `TriggeringSource` resolves only because
    /// `matching_attack_events` narrows every non-batched attack trigger to a
    /// SINGLETON `AttackersDeclared`, satisfying `extract_source_from_event`'s
    /// one-attacker guard. Attacking with a second creature must not collapse
    /// that narrowing — if it ever does, the condition fails closed and the
    /// counter silently stops being placed.
    #[test]
    fn multi_attacker_declaration_still_binds_the_triggering_source() {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let rumbler = scenario
            .add_creature_from_oracle(P0, "Momentum Rumbler", 4, 4, MOMENTUM_RUMBLER)
            .id();
        let ally = scenario.add_creature(P0, "Runeclaw Bear", 2, 2).id();
        let mut runner = scenario.build();

        runner.advance_to_combat();
        runner
            .declare_attackers(&[
                (rumbler, AttackTarget::Player(P1)),
                (ally, AttackTarget::Player(P1)),
            ])
            .expect("both creatures must be able to attack");
        settle(&mut runner);

        assert_eq!(
            first_strike_counters(&runner, rumbler),
            1,
            "the per-attacker event narrowing must survive a multi-attacker declaration"
        );
        assert_eq!(
            first_strike_counters(&runner, ally),
            0,
            "the counter must land on the trigger's own source, not on a co-attacker"
        );
    }
}

/// Binding class 3 — the referent is a DECLARED stack target, propagated into
/// the sub-chain's `targets`. Evaluated at the sub-ability gate. The card
/// "Suspend" shares this shape with Delay, Doom's Time Platform and Soovril.
mod declared_stack_target {
    use super::*;

    fn cast_suspend_at(printed_suspend: bool) -> (GameRunner, ObjectId, ObjectId) {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let victim = {
            let mut builder = scenario.add_creature(P1, "Grizzly Bear", 2, 2);
            if printed_suspend {
                builder.with_keyword(printed_suspend_four_blue());
            }
            builder.id()
        };
        let spell = scenario
            .add_spell_to_hand_from_oracle(P0, "Suspend", true, SUSPEND_CARD)
            .id();
        let mut runner = scenario.build();
        let outcome = runner.cast(spell).target_objects(&[victim]).resolve();
        drop(outcome);
        (runner, spell, victim)
    }

    /// Positive branch — a plain creature card exiled by "Suspend" gains
    /// suspend (CR 702.62a) and carries two time counters (CR 122.1).
    #[test]
    fn exiled_creature_without_suspend_gains_it() {
        let (runner, _spell, victim) = cast_suspend_at(false);

        assert_eq!(
            runner.state().objects[&victim].zone,
            Zone::Exile,
            "the targeted creature must be exiled"
        );
        assert_eq!(
            runner.state().objects[&victim]
                .counters
                .get(&CounterType::Time)
                .copied(),
            Some(2),
            "CR 122.1: the exiled card must carry two time counters"
        );
        assert!(
            object_has_effective_keyword_kind(runner.state(), victim, KeywordKind::Suspend),
            "the exiled card must gain suspend"
        );
    }

    /// Negative branch — the declared target already has printed
    /// `Suspend 4—{U}`, so the gate is false and the printed parameters survive.
    ///
    /// Revert-fail: with `SourceLacksKeyword` the gate reads the Suspend SPELL,
    /// which never has suspend, so the grant fires and clobbers the parameters.
    #[test]
    fn exiled_creature_with_printed_suspend_keeps_its_parameters() {
        let (runner, _spell, victim) = cast_suspend_at(true);

        assert_eq!(
            runner.state().objects[&victim].zone,
            Zone::Exile,
            "reach-guard: the targeted creature must actually be exiled"
        );
        assert_eq!(
            effective_suspend_cost(runner.state(), victim),
            Some(blue_mana_cost()),
            "CR 702.62a: the declared target's printed Suspend 4—{{U}} must survive, \
             not be clobbered to {{0}} by a redundant grant"
        );
    }
}

/// Binding class 4 — the referent is picked DURING RESOLUTION (Amy's Home, The
/// Eleventh Doctor). The pick reaches neither the grant's condition slot nor
/// `ResolvedAbility.targets`, so BOTH halves of the clause are re-anchored onto
/// the tracked set the pick publishes, with the keyword test folded into the set
/// selector:
///
/// ```text
/// TrackedSetFiltered { filter: Typed[WithoutKeywordKind Suspend],
///                      caused_by: Some(Exiled) }
/// ```
///
/// That is the `Card.IsRemembered+withoutSuspend` composition Forge's own script
/// for the card uses, expressed with the engine's existing parts — a per-member
/// predicate over the set, so no separate condition is left to misbind to the
/// trigger source (which, for a combat-damage trigger, is the Doctor itself) and
/// no printed `Suspend N—{cost}` can be clobbered down to `{0}`.
///
/// Two runtime seams had to carry that shape, and each is pinned by its own test
/// below:
///   1. **`publish_effect_zone_choice_tracked_set` stamps the producer action.**
///      An INTERACTIVE exile publishes its members through the choice-completion
///      seam, not through `publish_tracked_set_for_resolution`'s event-derived
///      arm, so nothing wrote `tracked_set_member_causes` and a
///      `caused_by: Exiled` selector matched nothing.
///   2. **`enter_with_counters` resolves per moved object.** The parser lowers
///      "a number of time counters on it equal to its mana value" correctly to
///      `enter_with_counters: [(Time, Ref(ObjectManaValue { scope: Recipient }))]`
///      (pinned by `parse_exile_from_hand_with_dynamic_counter_suffix` in
///      `parser/oracle_effect/imperative.rs`), but the count was resolved at
///      resolver ENTRY with `recipient: None` — before the pick bound the
///      recipient — so `ObjectScope::Recipient`'s fallback ladder walked down to
///      the ability SOURCE and stamped the SOURCE's mana value.
mod resolution_time_choice_binding {
    use super::*;
    use crate::rules::run_combat;
    use engine::parser::parse_oracle_text;
    use engine::types::ability::Effect;

    const ELEVENTH_DOCTOR: &str = "Whenever The Eleventh Doctor deals combat damage to a \
        player, you may exile a card from your hand with a number of time counters on it \
        equal to its mana value. If it doesn't have suspend, it gains suspend.";

    fn drive(printed_suspend: bool) -> (GameRunner, ObjectId) {
        let mut scenario = GameScenario::new();
        scenario.at_phase(Phase::PreCombatMain);
        let doctor = scenario
            .add_creature_from_oracle(P0, "The Eleventh Doctor", 3, 3, ELEVENTH_DOCTOR)
            .id();
        let hand_card = {
            let mut builder = scenario.add_spell_to_hand(P0, "Chosen Sorcery", false);
            builder.with_mana_cost(ManaCost::generic(3));
            if printed_suspend {
                builder.with_keyword(printed_suspend_four_blue());
            }
            builder.id()
        };
        // A second, plain hand card so the resolution-time pick is a REAL choice
        // and not a degenerate single-candidate auto-resolve.
        {
            let mut decoy = scenario.add_spell_to_hand(P0, "Decoy Sorcery", false);
            decoy.with_mana_cost(ManaCost::generic(1));
        }
        let mut runner = scenario.build();
        run_combat(&mut runner, vec![doctor], vec![]);

        // Answer the optional trigger and its resolution-time card pick. Same
        // terminal-state contract as `settle`: only an empty stack at a priority
        // window is a legal exit, because the pins below (the time-counter count,
        // the presence of the suspend grant) are exactly what a card that never
        // left the hand would also show.
        let mut saw_optional = false;
        let mut saw_pick = false;
        let mut settled = false;
        for _ in 0..40 {
            match runner.state().waiting_for.clone() {
                WaitingFor::OrderTriggers { .. } => {
                    engine::game::triggers::drain_order_triggers_with_identity(runner.state_mut());
                }
                // Accept the trigger's "you may" so the exile actually happens.
                WaitingFor::OptionalEffectChoice { .. } => {
                    saw_optional = true;
                    runner
                        .act(GameAction::DecideOptionalEffect { accept: true })
                        .expect("the optional combat-damage trigger must accept");
                }
                // The resolution-time pick of which hand card to exile.
                WaitingFor::EffectZoneChoice { .. } => {
                    saw_pick = true;
                    runner
                        .act(GameAction::SelectCards {
                            cards: vec![hand_card],
                        })
                        .expect("the chosen hand card must be a legal pick");
                }
                WaitingFor::TriggerTargetSelection { .. } | WaitingFor::TargetSelection { .. } => {
                    runner
                        .choose_first_legal_target()
                        .expect("a pending target selection must offer a legal target");
                }
                WaitingFor::Priority { .. } => {
                    if runner.state().stack.is_empty() {
                        settled = true;
                        break;
                    }
                    runner
                        .act(GameAction::PassPriority)
                        .expect("passing priority on a non-empty stack must be legal");
                }
                other => panic!("unexpected prompt while driving the trigger: {other:?}"),
            }
        }
        assert!(
            settled,
            "the stack never emptied within 40 steps (waiting_for = {:?}, stack depth = {})",
            runner.state().waiting_for,
            runner.state().stack.len(),
        );
        assert!(
            saw_optional,
            "reach-guard: the optional combat-damage trigger must be offered"
        );
        assert!(
            saw_pick,
            "reach-guard: the resolution-time hand pick must be offered"
        );
        (runner, hand_card)
    }

    /// The trigger's exile half parses, the pick is offered and answered, and the
    /// grant is a REAL supported effect rather than a coverage gap.
    #[test]
    fn the_pick_targets_the_exiled_tracked_set_instead_of_a_coverage_gap() {
        let parsed = parse_oracle_text(
            ELEVENTH_DOCTOR,
            "The Eleventh Doctor",
            &[],
            &["Legendary".to_string(), "Creature".to_string()],
            &["Time Lord".to_string(), "Doctor".to_string()],
        );
        let execute = parsed.triggers[0]
            .execute
            .as_deref()
            .expect("the combat-damage trigger has an effect chain");
        // Reach-guard: the exile half still parses, so the repair is scoped to the
        // gate and did not swallow the whole trigger.
        assert!(
            matches!(&*execute.effect, Effect::ChangeZone { .. }),
            "the hand exile must still parse, got {:?}",
            execute.effect
        );
        let grant = execute
            .sub_ability
            .as_deref()
            .expect("the suspend grant is the sub-ability");
        assert_eq!(
            grant.effect.unimplemented_description(),
            None,
            "the grant must no longer be a disclosed gap, got {:?}",
            grant.effect
        );
        assert_eq!(
            grant.condition, None,
            "the keyword test lives inside the set selector now, got {:?}",
            grant.condition
        );
    }

    /// CR 702.62a: the chosen card actually gains suspend — the payoff the
    /// disclosed-gap module could only defer.
    #[test]
    fn the_chosen_card_gains_suspend() {
        let (runner, card) = drive(false);

        assert_eq!(
            runner.state().objects[&card].zone,
            Zone::Exile,
            "reach-guard: the chosen hand card must be exiled"
        );
        assert!(
            object_has_effective_keyword_kind(runner.state(), card, KeywordKind::Suspend),
            "CR 702.62a: the exiled card must gain suspend"
        );
    }

    /// CR 122.1: the chosen MV-3 card enters exile with THREE time counters —
    /// `<its mana value>`, read off the card the pick bound, not the source.
    #[test]
    fn the_chosen_card_gets_time_counters_equal_to_its_own_mana_value() {
        let (runner, card) = drive(false);

        assert_eq!(
            runner.state().objects[&card].zone,
            Zone::Exile,
            "reach-guard: the chosen hand card must actually be exiled"
        );
        assert_eq!(
            runner.state().objects[&card]
                .counters
                .get(&CounterType::Time)
                .copied()
                .unwrap_or(0),
            3,
            "CR 122.1: the chosen card's mana value (3) determines the number of \
             time counters, not the Doctor's"
        );
    }

    /// CR 702.62a: a card that already has printed `Suspend 4—{U}` keeps its
    /// parameters. This is the per-member half of the selector doing its job: the
    /// set is restricted to members WITHOUT the keyword, so no redundant grant is
    /// installed and `upsert_keyword_contribution` cannot clobber the printed
    /// contribution down to `Suspend 0—{}`.
    ///
    /// Revert-fail: with a bare `TrackedSet` selector (or the old misbinding
    /// `TargetMatchesFilter` gate) the grant fires here and this reads
    /// `Some({0})`.
    #[test]
    fn printed_suspend_parameters_survive_the_grant() {
        let (runner, card) = drive(true);

        assert_eq!(
            runner.state().objects[&card].zone,
            Zone::Exile,
            "reach-guard: the chosen hand card must actually be exiled"
        );
        assert_eq!(
            effective_suspend_cost(runner.state(), card),
            Some(blue_mana_cost()),
            "CR 702.62a: the printed Suspend 4—{{U}} must survive — no redundant \
             grant may clobber it to {{0}}"
        );
    }

    /// The card the module is named for, measured end to end: the Doctor's
    /// trigger exiles the chosen card with its own mana value in time counters
    /// and that card has suspend. Before the repair this exact drive produced a
    /// card in exile with ZERO counters and no keyword.
    #[test]
    fn the_eleventh_doctor_exiles_the_chosen_card_with_suspend() {
        let (runner, card) = drive(false);

        assert_eq!(
            runner.state().objects[&card].zone,
            Zone::Exile,
            "reach-guard: the chosen hand card must be exiled"
        );
        assert_eq!(
            runner.state().objects[&card]
                .counters
                .get(&CounterType::Time)
                .copied()
                .unwrap_or(0),
            3,
            "CR 122.1: three time counters for the chosen MV-3 card"
        );
        assert!(
            object_has_effective_keyword_kind(runner.state(), card, KeywordKind::Suspend),
            "CR 702.62a: the exiled card must have suspend"
        );
    }
}
