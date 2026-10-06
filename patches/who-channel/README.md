# 补丁：神秘博士（WHO）专用频道

把 phase.rs 改造成「打开就是神秘博士指挥官」的专用客户端。保留上游全部代码，改动全部以补丁形式维护。

## 这个目录是什么

```
patches/who-channel/
  README.md                                              ← 本文件
  0001-feat-build-allow-scoping-the-precon-catalog-...patch ← 预组目录范围控制
```

分支：`patches/who-channel`（基于 `main` 的 `59b2b17`）。

补丁**只含它触及的目录**（这里是 `scripts/`）。生成方式见顶层 `CLAUDE.md` 的「Local Patches」一节。

## 已完成

### 1. 卡池只留 WHO

产出从全量 **71237 张** 收窄到 **362 张**，卡数据文件从 **37 MB** 降到 **1.5 MB**。

做法：**不碰代码**。生成器读 `data/mtgjson/AtomicCards.json`，把它先收窄成只含 WHO 的版本即可：

```bash
# 备份全量（只做一次）
cp data/mtgjson/AtomicCards.json /tmp/AtomicCards.full.json

# 收窄成 WHO（366 张，3.1 MB）
jq '{meta, data: (.data | with_entries(select(.value[0].printings | index("WHO"))))}' \
  /tmp/AtomicCards.full.json > data/mtgjson/AtomicCards.json

./scripts/gen-card-data.sh
```

要**恢复全量**时把备份拷回去再跑一遍即可。

> 注意：`WHO` 是 MTGJSON 的系列代号（Doctor Who，2023-10-13，commander 系列）。
> 原子库里是 **366 张**（按「牌」去重），`WHO.json` 里的 **1186** 是含异画变体的印刷数。

### 2. 预组目录只留四套 WHO 预组

`PHASE_DECKS_SCOPE=_WHO` 让 `decks.json` 只保留这四套：

| deck id | 名称 | 指挥官 | 牌数 | 覆盖率 |
|---|---|---|---|---|
| `BlastFromThePast_WHO` | Blast from the Past | The Fourth Doctor + Sarah Jane Smith | 97 | 99% |
| `MastersOfEvil_WHO` | Masters of Evil | Davros, Dalek Creator | 99 | 99% |
| `ParadoxPower_WHO` | Paradox Power | The Thirteenth Doctor + Yasmin Khan | 93 | 98% |
| `TimeyWimey_WHO` | Timey-Wimey | The Tenth Doctor + Rose Tyler | 95 | 98% |

```bash
PHASE_DECKS_SCOPE=_WHO ./scripts/gen-card-data.sh
```

**不设这个变量时行为与上游完全一致**（输出全部 1381 个卡组），所以 CI 和上游不受影响。
范围匹配不到任何卡组时会警告并保留未过滤的结果，而不是推广一个空目录——
空目录在运行时和「这个构建没有预组」无法区分，比一条警告糟糕得多。

### 3. 中文卡图：生成可用性表（与中文卡图补丁配套）

`patches/zhs-card-art/` 提供中文卡图，但它需要一张**逐印刷的可用性表**才能挑对印刷 ——
否则应用渲染的是「最新印刷」，而那个印刷常常没有中文版。

```bash
./scripts/gen-derived-art-availability.sh zhs _WHO
```

产出 `client/public/scryfall-images.zhs-available.json`（约 15 KB）。
必须带 `_WHO` 范围，否则会探测整个卡池（几分钟而不是 15 秒）。

实测 WHO：1178 个印刷里 **398 个（33%）** 有中文图；同一张牌的多个版本之间**没有规律**
（#318 有中文，#528 / #909 / #1119 都没有），所以只能逐印刷探测。
细节见 `patches/zhs-card-art/README.md`。

### 🔬 第 4 步（The Eighth Doctor）—— 解析器已完成，运行时未接线

**牌面**：
> Once during each of your turns, you may play a historic land or cast a historic permanent spell
> from your graveyard. If you do, it gains "If this permanent would leave the battlefield, exile it
> instead of putting it anywhere else."

**关键发现：解析器本来就能解析这张牌，而且文档注释直接点了它的名。**

`try_parse_disjunctive_graveyard_cast_permission` 的注释写着：

> - tail-zone: "play a \<land\> or cast a \<spell\> from your graveyard"
>   (**The Eighth Doctor** — "from your graveyard" once, at the end).

它**刻意拒绝**（`if ... scan_contains(rest, "if you do, it gains") { return None }`），理由是：

> the granted leave-battlefield exile rider is a CR 614.1a Moved replacement on the resolved
> permanent. **Parsing only the permission would make coverage report support while dropping rules
> text.**

**缺的只是一个存放 rider 的位置。** 陷阱在于 `graveyard_destination_replacement` **看起来像但语义不同**：
它重定向**堆叠→坟场**的离开，而第八任博士重定向**战场→放逐**的离开。混用会静默丢 rider。

**已完成并提交（`c3dfecb843`，行为中性）**：给 `GraveyardCastPermission` 加上
`leave_battlefield_replacement: bool`（默认 false，serde 跳过，既有数据逐字节不变）。

**解析器侧也已跑通但未提交**（运行时未接线，提交会标记 supported 却丢效应，故回退）：
- `strip_leave_battlefield_grant_rider(lower) -> Option<(&str, bool)>` —— 识别并消费 rider
- 两个要点：**开头和结尾的引号都要剥**（探测器的末尾检查会拒绝闭引号）；
  rider 到达时**未归一化**，需把 `this permanent` → `~` 再交给共享探测器
- 测试全绿，含一个**反向对照**（无 rider 时必须记 `false`）

**剩余的运行时工作**（下一步的起点）：
1. 把字段穿过 `GraveyardPermissionSource` / `GraveyardPermissionLatch` / `CastAuthorityChoice`
   （`enters_with_counter` 是逐字模板）
2. 在 `finalize_cast` 接缝应用：读出标志后
   `add_transient_continuous_effect(object_id, player, Duration::Permanent,
   TargetFilter::SpecificObject { id: object_id }, vec![ContinuousModification::GrantReplacement {
   replacement: Box::new(leave_battlefield_exile_replacement()) }], None)`
3. **必须用无 stamp 的构造器**（`leave_battlefield_exile_replacement()`，非 detector 的
   `AddTargetReplacement` 载荷）——后者带 `RestrictionExpiry::UntilHostLeavesPlay`，
   会让授予的 rider 活过授权效应

**验收标准（实现前先写）**：运行时测试需断言放逐的永久物**离开战场时进入放逐区**，
且在**没有**该 rider 的同类许可下**不会**如此——单向断言会漏掉「静默丢弃」。

### ✅ 第 3 步（The Eleventh Doctor）—— 已修（用 Forge 的思路）

**缺口**：`keyword_anaphor_resolution_time_pick`（影响 3 张：The Eleventh Doctor、Amy's Home、
Amy's Home 的 chaos 触发；代码里原本**刻意**严格失败并写明原因）。

#### 为什么上一轮的方案是死的（记录在此，避免重走）

上一轮试的是「把条件从 `TargetMatchesFilter` 重锚到 `ZoneChangedThisWay`」。
AST 层面完全正确，但运行时实测：

```
plain zone:            Some(Exile)      ← 放逐成功
last_zone_changed_ids: []              ← 台账是空的
counters:              Some({})        ← 时间计数器也没放上
```

结论：交互式选择路径**不填** `last_zone_changed_ids`，重锚是惰性修复（条件恒为假）。

**真正的修复点**：不是 `last_zone_changed_ids`，而是 **tracked set 的 producer cause 台账**
（`GameState::tracked_set_member_causes`）。交互式选择走的是
`publish_effect_zone_choice_tracked_set`，它发布了集合却没写 cause。

#### Forge 的思路（关键转折）

Forge 的 `the_eleventh_doctor.txt`：

```
ChangeZone  Origin$ Hand  Destination$ Exile  WithCountersType$ TIME
            WithCountersAmount$ X  RememberChanged$ True
PumpAll     ValidCards$ Card.IsRemembered+withoutSuspend  KW$ Suspend  PumpZone$ Exile
```

它是「**记住那张牌 → 直接给「记住的 且 没有 suspend 的」加 suspend**」——
**把两个谓词合进一个集合选择器**，而不是「先判断再决定」。

phase.rs 现在落成同一个形状：

```rust
TargetFilter::TrackedSetFiltered {
    id: TrackedSetId(0),                      // 本链最近发布的集合
    filter: Typed[WithoutKeywordKind(Suspend)], // 「没有 suspend 的」
    caused_by: Some(ThisWayCause::Exiled),    // 「被放逐的」
}
```

于是**原句的条件整个消失**——没有可误绑的东西，也就不存在「静默读成博士自己」的问题。

#### 一共三处根因

| # | 位置 | 缺陷 | 修法 |
| --- | --- | --- | --- |
| 1 | `parser/oracle_effect/mod.rs` | 整句 strict-fail 成 `Unimplemented` | `rebind_keyword_anaphor_to_resolution_pick_tracked_set`：重锚到上面的选择器 |
| 2 | `engine_resolution_choices.rs` | 交互式放逐**不写** producer cause | `publish_effect_zone_choice_tracked_set` 按目的地经 `this_way_cause_for_zone` 打标 |
| 3 | `effects/change_zone.rs` | `enter_with_counters` 在选牌**之前**解析，`Recipient` 回退到**博士自己** | 按「能否在移动前回答」拆成 `EnterCounterSpec::{Resolved, PerObject}` |

**顺带修的邻居（同一根因）**：`GenericEffect` 的广播分支原来只扫**战场**，
放逐区永远加不上关键词。现在 tracked-set 型 filter 会枚举集合成员
（`resolved_object_ids_for_filter_with_context`）。

#### 实测验收

`crates/engine/tests/integration/keyword_anaphor_subject_binding.rs`
（模块 `resolution_time_choice_binding`，5 个新测试）：

| 断言 | 修前 | 修后 |
| --- | --- | --- |
| 选中的 MV-3 牌的时间指示物 | 0 | **3** ✅ |
| 选中的牌有 suspend | 无 | **有** ✅ |
| 打印的 `Suspend 4—{U}` 参数 | 不适用（无授予） | **不被冲成 {0}** ✅ |
| 解析结果 | `Unimplemented` | **真效果** ✅ |

另外 8 个老测试（Delay / Kang Prime / Suspend / Momentum Rumbler 等其他绑定方式）全绿，
证明三种**能绑**的类别没被误改。

**影响面实测**：`effects::change_zone` 103 个全过；
`effects::` + `engine_resolution_choices::` 2706 个全过；引擎单测 23218 过 1 败——
败的是 `game::casting::tests::witherbloom_…`，它要的牌不在本 fork 的 362 张 WHO 卡池里，
**是卡池收窄的既有后果，不是本次改动引入的**。

**已知未覆盖**：`last_zone_changed_ids` 仍不为交互式选择填充。本次修复没有依赖它
（改用了 tracked set 台账），但任何**仍然**读 `last_zone_changed_ids` 的交互式
「…this way」措辞依旧是坏的。那是独立的一块，未在本次范围内。

### 4. 已修的牌（卡牌支持）

预组里原本有 6 张不支持的牌，按「一次一张、修完验证」推进：

| # | 牌 | 缺口 | 修法 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | Carpet of Flowers | `you haven't added mana with this ability this turn` | 复用 `AbilityCondition::AbilityUseCountThisTurn`（`Resolved` + `LT 1`），只加第三条模板 | ✅ 26→25 |
| 2 | Exterminate! | `Replicate—Tap an untapped Dalek you control` 未识别 | `Replicate(ManaCost)` → `(AbilityCost)`；加 `replicate—` 破折号分支 | ✅ 25→24→23 |
| 3 | The Eleventh Doctor | `keyword_anaphor_resolution_time_pick`（解析器 + 引擎台账 + 计数器三处） | 见上一节：重锚到 `TrackedSetFiltered{无 suspend, Exiled}` | ✅ |

**Exterminate! 一次性暴露了 4 个叠加缺陷**（详见 commit message），其中第三个最危险：

> `parse_oracle_cost` 用 `take_until(" (")` 剥提醒文本时**会留下句号**，导致
> `parse_single_cost` 里所有 `remainder.trim().is_empty()` 守卫失败，费用**静默降级**成
> 通用 `EffectCost`（`SetTapState`）——而 `supports_effect_cost_payment` **拒绝**它。
> **牌解析显示成功，但实际无法施放。** 已在 `parse_oracle_cost` 通用层修掉。

剩余 3 张：The Eighth Doctor、Clara Oswald、The Wedding of River Song。
第 1 步（The Eighth Doctor）代码已完成、运行时测试待补；第 2 步（The Eleventh Doctor）**已完成**。

## ⚠️ 改了解析器就必须重建引擎 WASM

**症状**：浏览器报

```
Compatibility check unavailable: Card database failed to load:
Failed to parse card database: ManaCost: unknown variant `TapCreatures`,
expected one of `NoCost`, `Cost`, `SelfManaCost`, `SelfManaValue`, `SelfManaCostReduced`
```

**原因**：卡数据是**运行时**载入的，但**解析卡数据的引擎是编译进 WASM 的**。
改了引擎的序列化类型（比如把 `Replicate` 的费用从 `ManaCost` 扩成 `AbilityCost`）之后：

- 卡数据由**新**解析器生成 → 新形状
- 浏览器里的 WASM 还是**旧**引擎 → 拒绝新形状 → 整个卡牌数据库加载失败

**注意**：这个错误**不会**在任何 Rust 测试里出现（Rust 侧用新代码）。它只在浏览器里炸，
而且是在启动时炸掉整个数据库，不是个别卡牌。

```bash
./scripts/build-wasm.sh          # wasm-dev，约 20 分钟（引擎增量）
```

然后**重启 dev server**（`client/src/wasm/*.wasm` 被缓存，热更新不一定换掉它）。

**快速自检**（比开浏览器快）：用真实 WASM 载入真实卡数据：

```bash
cd client && npx vitest run --config vitest.integration.config.ts \
  --coverage.enabled=false src/services/__tests__/deckCompatibility.integration.test.ts
```

`scripts/check-protocol-version.mjs` 只能发现**协议版本号**漂移，发现不了这个——
它比的是版本常量，不是序列化形状。

## 每次生成后必须做的一件事

`gen-card-data.sh` 会**非幂等重写** `crates/engine/data/oracle-subtypes.json`
（一个被 git 跟踪的**解析器输入**），可能丢掉子类型——实测丢过 58 行。

它不是你的改动，**每次生成完都要还原**：

```bash
git checkout -- crates/engine/data/oracle-subtypes.json
```

历史上只有 `scripts/gen-card-data.sh` 传 `--write-subtypes`，其他调用方（CI、ai-gate、裸
`cargo export-cards`）都不会碰它。

## 完整构建流程（从干净检出开始）

```bash
# 1. 依赖
pnpm --dir client install

# 2. 引擎 WASM（首次约 15–20 分钟，之后增量）
./scripts/build-wasm.sh

# 3. 数据：先收窄卡池，再带范围生成
cp data/mtgjson/AtomicCards.json /tmp/AtomicCards.full.json   # 仅首次
jq '{meta, data: (.data | with_entries(select(.value[0].printings | index("WHO"))))}' \
  /tmp/AtomicCards.full.json > data/mtgjson/AtomicCards.json
PHASE_DECKS_SCOPE=_WHO ./scripts/gen-card-data.sh
git checkout -- crates/engine/data/oracle-subtypes.json       # 见上

# 3b. 衍生物卡图数据（约 1 分钟）—— 缺了它衍生物没有图
./scripts/gen-scryfall-token-images.sh

# 3c. 中文卡图可用性表（约 15 秒）
./scripts/gen-derived-art-availability.sh zhs _WHO

# 4. 跑起来
pnpm --dir client dev        # http://localhost:5173/
```

## 已知情况

- **每套预组有 1–2 张牌引擎不支持**（Blast from the Past / Masters of Evil 各 1 张，
  Paradox Power / Timey-Wimey 各 2 张）。这些牌在牌组里会被标记，属于上游解析器覆盖缺口，
  要补齐需要改引擎（并**同时提升协议版本号**，否则联机会静默分叉）。
- **只留 WHO 省的是数据体积，省不了首次编译**。卡牌数据是运行时读 JSON、不参与编译，
  引擎 crate 是客户端必需的。
- **联机**：纯外观/数据改动不影响联机；一旦改引擎补卡牌支持，双方必须用**同一个构建**。

## 怎么再套用（上游更新后）

```bash
git checkout main && git pull
git checkout patches/who-channel
git rebase main          # 冲突几乎只在 scripts/gen-card-data.sh
```

上游自己实现了范围控制后，删掉本目录与分支即可。

## 与中文卡图补丁的关系

两者独立、可并存：

- `patches/zhs-card-art/` — 简体中文卡图（纯客户端外观）
- `patches/who-channel/` — 神秘博士卡池与预组范围（数据构建）

它们改的文件没有重叠（前者 `client/`，后者 `scripts/`）。
