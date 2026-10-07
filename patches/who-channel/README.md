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
| 4 | Clara Oswald | CR 607.2p 开局选色（解析器 + 区域门 + 开局扫描 + 持久存储四处） | 见上一节 | ✅ |

**Exterminate! 一次性暴露了 4 个叠加缺陷**（详见 commit message），其中第三个最危险：

> `parse_oracle_cost` 用 `take_until(" (")` 剥提醒文本时**会留下句号**，导致
> `parse_single_cost` 里所有 `remainder.trim().is_empty()` 守卫失败，费用**静默降级**成
> 通用 `EffectCost`（`SetTapState`）——而 `supports_effect_cost_payment` **拒绝**它。
> **牌解析显示成功，但实际无法施放。** 已在 `parse_oracle_cost` 通用层修掉。

剩余 2 张：The Eighth Doctor、The Wedding of River Song。
第 1 步（The Eighth Doctor）代码已完成、运行时测试待补；第 2 步（The Eleventh Doctor）**已完成**。

### ✅ 第 4 步（Clara Oswald）—— 已修（CR 607.2p 开局选色）

**缺口**：那句「If Clara Oswald is your commander, choose a color before the
game begins. Clara Oswald is the chosen color.」整段 strict-fail。

**它不是一张牌，是一个恰好 3 张的类。** 实测（Scryfall
`oracle:"choose a color before the game begins"`，`unique=cards`）全卡池只有：

| 牌 | 措辞 |
| --- | --- |
| Clara Oswald | `Impossible Girl — ` 异能词 + 配对 |
| Faceless One | 裸配对 |
| The Prismatic Piper | 裸配对 |

三张**除牌名外措辞完全相同**，所以识别器按**类**建，不是按卡建。

#### CR 607.2p：一段文字 = 一对**关联异能**

```
① 静态能力：让牌手在游戏开始前选一个颜色        → AbilityKind::BeginGame
② 特征定义能力：读那个选择                      → CDA + AddChosenColor{Set}
```

第二段「continues to refer to that choice as the object **changes zones**
during the game」是这条规则的重点。

#### 顺带修掉的三个**通用**缺陷（都不只影响这张牌）

| # | 位置 | 缺陷 |
| --- | --- | --- |
| 1 | `layers.rs::effect_candidate_ids` | **CDA 在所有区域生效（CR 604.3），但具名对象的受影响集合按 *filter 的*扫描区域解析，默认只有战场** → 指挥区里的 `SelfRef` CDA **受影响集合为空、被整个丢弃**（不是判假，是没执行）。收窄到 `named == source_id`，因为 `SpecificObject` 指向**别的**对象那一类由 off-zone 机制负责（有测试钉住） |
| 2 | `mulligan.rs::queue_begin_game_abilities` | 只扫**起手牌**。CR 903.6 说指挥官开局在**指挥区** → 指挥官自己的开局能力永远找不到。改成手牌 + 指挥区 |
| 3 | `StaticCondition` | 没有"源是（我的）指挥官"这个条件。新增 `SourceIsCommander`（CR 903.3：指挥官身份是**牌的属性**，任何区域都成立）+ 同步 20 处穷尽 match |

#### 还有个**存储**问题（不是缺陷，是规则要求）

CR 607.2p 要求那个选择**跨区域持续**，但 `chosen_attributes` 每次进战场都被
`reset_for_battlefield_entry` 清掉（CR 400.7）—— 指挥官在指挥区选完色，一进战场就丢。

所以加了 `GameObject::commander_color_choice`（像 `is_commander` 一样是牌的属性，永不清除），
`GameObject::chosen_color` **优先读它**。这样整个"所选颜色"家族
（`AddChosenColor` / `IsChosenColor` / `HexproofFrom`/`Protection(ChosenColor)`）
一行都不用改就服务于这张牌。

#### ⚠️ 已知缺口（明确决定不做，不是没发现）

**CR 903.4b**：选的颜色「applies **during deck construction** ... That choice
**affects the commander's color identity**」。

组牌校验**不知道**这个选择，所以**以克拉拉为指挥官**的自定义套牌，
不会按她的颜色做标识色校验（CR 903.5c / 903.5d）。

**影响面 = 一个本 fork 绝不会走到的场景**：实测 Paradox Power 预组的指挥官是
**The Thirteenth Doctor + Yasmin Khan**，克拉拉在 **99 张主牌**里 ——
按 CR 903.3d，她不是指挥官 → `StaticCondition::SourceIsCommander` 为**假** →
整段文字**不生效**，引擎行为**完全正确**。

补上它需要组牌侧的选择（`DeckCompatibilityRequest` / `PlayerDeckList` 各加字段 +
组牌界面选择器 + 改选后重校验），是一块独立的工作，另开一轮。

**为什么明确记录而不静默放过**：这一轮我们已经因为"能跑但静默错"栽过三次
（第八任博士的台账、第十一任博士的指示物、克拉拉自己的 CDA 区域门），
每次都是先把它变响才修好的。

#### 另一个**独立的**既有缺口（顺带查到，未修）

`deck_validation::card_color_identity` 的**回退分支只读法术力费用和
`color_override`，从不读规则文本里的法术力符号（CR 903.4），也从不读 CDA**。

本 fork 里被掩盖了：数据管线为 362 张里的 **281 张**预填了来自 Scryfall 的
`color_identity` 字段，回退只在剩下 **81 张**时运行。实测 WHO 卡池有 **74 张**
「费用无色 + 文本含彩色符号」（Talisman 系列、Temple 系列、基本地等）**全部靠预填字段绕过回退** ——
所以这是**数据依赖的运气，不是实现正确**。

## ⚡ 先跑这个再决定要不要重建 WASM（省 20 分钟）

**不是每次改解析器都要重建 WASM。** 判据只有一条：**这次改动有没有产生新的
「会被序列化进 `card-data.json` 的形状」**。

| 改了什么 | 要重建 WASM 吗 |
|---|---|
| 解析**逻辑**（同一句话现在选另一个已有变体） | ❌ 不用 |
| 运行期执行逻辑（effect handler、层计算、调度） | ❌ 不用 |
| 新增/修改**会序列化进卡数据**的类型变体（`Effect` / `TargetFilter` / `FilterProp` / `ContinuousModification` / `Keyword` …） | ✅ **必须** |

判据可以**实测**，不用靠判断：

```bash
# 1) 只生成卡数据（会重编原生 engine，但 tool profile 之后是增量的）
PHASE_DECKS_SCOPE=_WHO ./scripts/gen-card-data.sh

# 2) 用【已构建的 WASM】试着载入【新卡数据】 —— 几秒钟出结果
node scripts/check-card-data-compat.mjs
```

- 退出码 **0** → 形状没变，**不用重建**
- 退出码 **1** → 形状变了，去跑 `./scripts/build-wasm.sh`

顺带验证某张牌是否真的变支持（**别用字符串数 `"Unimplemented"`**，
覆盖率树是按各自的标签渲染的，数不到）：

```bash
node scripts/check-card-data-compat.mjs --card "The Eleventh Doctor"
```

它会打印这棵解析树**每个节点**的 `supported` 标志。

**实测数据（本次工作）**：第十一任博士的三处修复**没有产生新形状**
（`caused_by: "Exiled"` 是枚举里已有的值），所以那次 20 分钟的 WASM 重建
**完全没必要** —— 事后用这个闸门验证过：旧 WASM 载入新卡数据，正常。

**另注**：`gen-card-data.sh` 第一次跑要编译 `tool` profile 的整套依赖
（本次实测约 40 分钟，一次性成本）；之后它只重编 `engine` crate + 链接，快得多。
真正"每次都要付"的只有 WASM 重建，所以**闸门卡在这一步收益最大**。

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
