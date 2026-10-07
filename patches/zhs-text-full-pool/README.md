# 补丁：全量卡池 + 中文卡牌文本（大学院废墟）

## 这个目录是什么

两个相关的改动，合一个系列：

1. **卡池从"只留 WHO"改为全量**（35,082 张）
2. **中文卡牌文本**从 [大学院废墟 / magic-cards-zhs](https://github.com/HeliumOctahelide/magic-cards-zhs)
   引入，**默认开启**

## ⚠️ 这个系列依赖另一个系列

**必须先套 `patches/zhs-card-art/`**，再套本系列。原因：本系列把"卡牌文本语言"
做成独立偏好，是**照 `artLanguage` 的形状**写的，而 `artLanguage` 由
`patches/zhs-card-art/` 引入。单独套本系列会缺 `artLanguage`，编译不过。

正确的叠加顺序：

```
main
 └─ patches/who-card-support   （WHO 卡牌的解析器/引擎修复）
     └─ patches/zhs-card-art   （中文卡图 + artLanguage 偏好）
         └─ patches/zhs-text-full-pool   （本系列）
```

**已知的耦合代价**：`patches/who-card-support/README.md` 的第 1 节（卡池）在本系列里
被改写成了"已改为全量"，因为收窄卡池的记录就在那个文件里。所以两个系列的 README
有交叉引用 —— 读的时候两边都要看。

## 重新生成本系列（实测可用的确切命令）

本系列在 **`zhs-text-full-pool` 分支**上生成，基座是 `patches/zhs-card-art` 的头部：

```bash
git format-patch refs/heads/patches/zhs-card-art..HEAD \
  --no-signature --output-directory patches/zhs-text-full-pool \
  -- . ':(exclude)patches/'
```

`:(exclude)patches/` 是必须的：系列的输出写进 `patches/`，而生成命令又读它。

**验证**（套到干净检出上试，别只读补丁文件）：

```bash
git worktree add --detach /tmp/verify <zhs-card-art 头部>
cd /tmp/verify
git am /path/to/patches/zhs-card-art/*.patch        # 先套依赖
git am /path/to/patches/zhs-text-full-pool/*.patch  # 再套本系列
```

## 1. 全量卡池

```bash
cp /tmp/AtomicCards.full.json data/mtgjson/AtomicCards.json
MTGJSON_SKIP_REFRESH=1 PHASE_DECKS_SCOPE=_WHO ./scripts/gen-card-data.sh
```

`PHASE_DECKS_SCOPE=_WHO` 仍然要带 —— 它控制的是**预组目录**（只留四套 WHO），
与卡池无关。**不设它**会输出全部 1381 套预组。

**实测（这台机器，8 GB 内存）**：

| 项目 | 收窄时 | 全量 |
| --- | --- | --- |
| 输入 `AtomicCards.json` | 2.1 MB / 366 张 | **154 MB / 35,082 张** |
| `card-data.json` | 1.5 MB | **95.0 MB** |
| `coverage-data.json` | 1.0 MB | **62.9 MB** |
| `card-names.json` | 8 KB | **672 KB** |
| 卡池解析结果 | 362 张 | **35,879 张** |
| 完全支持 | 341 (94.2%) | **32,010 (89.2%)** |
| 预组 | 4 套 | **1381 套**（含那 4 套 WHO） |

**启动性能实测**（真实 WASM 载入真实 95 MB 卡数据）：

```
WASM 初始化      284 ms
读取 95MB 文件    31 ms
解析 35,879 张   997 ms
查询单张牌         6 ms
总计            1.4 s
```

**结论：95 MB 不是问题**，所以**没有**为"按需查询"重构 sidecar 加载器。

### 顺带修好 6 张假警报

收窄卡池有一个**非显而易见**的副作用：`coverage.rs::collect_valid_subtypes`
从**卡池**构建副类别词典，收窄后只有 **69** 个副类别，而仓库里提交的权威词典是
**408** 项。于是：

| 牌 | 解析出的值 | 收窄卡池 | 全量卡池 |
| --- | --- | --- | --- |
| Celestial Colonnade / Creeping Tar Pit / Lavaclaw Reaches | `Elemental` | ❌ 误报"非法副类别" | ✅ |
| Antarctic Research Base | `Plant` | ❌ 误报 | ✅ |
| The Cheetah Planet | `Cat` | ❌ 误报 | ✅ |
| Coward | `Coward` | ❌ 误报 | ✅ |
| New New York | `Vehicles` | ❌ | ❌ **仍是 bug**（应归一化为单数 `Vehicle`） |

**`New New York` 换全量也修不好** —— `Vehicles` 在完整词典里也不存在，
那是解析器把原文的复数 `become 3/3 Vehicles` 直接当成了副类别。

## 2. 中文卡牌文本

```bash
node scripts/gen-zhs-card-text.mjs              # 产出 client/public/card-data.zhs.json
node scripts/gen-zhs-card-text.mjs --dry-run    # 只报告不写文件
```

**必须在 `gen-card-data.sh` 之后跑** —— 它按 `card-data.json` 的
`scryfall_oracle_id` 做 join。

### 为什么不能用现有管线

其它语言的 `card-data.<lng>.json` 都来自 MTGJSON 的 `foreignData`，而
**Scryfall 完全没有简中印刷** → `zhs` 永远为空。所以这一种语言换成社区数据集。

### 设计决定：独立脚本，不改 Rust

`card-data.json` 已经带 `scryfall_oracle_id`，join **不需要引擎代码** ——
跑一次**几秒**，而不是排在 `tool` profile 那次 15 分钟重编后面。

### 数据源的三个坑（都已实测并处理）

| # | 问题 | 规模 | 处理 |
| --- | --- | --- | --- |
| 1 | **JSON 转义多了一层**（`\"` 非法）→ 整行解析失败 | **2,351 行** | 修原始行 → **39,959 / 39,959 全部通过** |
| 2 | **换行是双反斜杠 + n** → 引擎按行解析会当成一整行 | **22,195 条**（真换行 **0** 条） | 归一化成真换行 |
| 3 | **Forge 的 `CARDNAME` 模板变量未展开** | **73 处 / 52 张** | 替换为该牌自己的中文名 → 残留 0 |

> **坑 2 值得单独记**：第一版写 `replaceAll("\\n", "\n")`，结果把 `\\n`
> 变成 **`\` + 真换行**（只吃掉一个反斜杠）。**渲染出来看不出来** ——
> 是靠打印**字节**（`5c0a` vs `0a`）才发现的。

### 质量策略

- 默认丢弃 `text_stage 0`（**3,192 条**无来源/未授权）；`--all-stages` 可开回
- 数据是**按印刷**的（39,959 条 / 38,932 个 oracle_id），sidecar 是**按牌名**的
  → 按 `stage → 发布日期 → 收集编号` **确定性**归约，绝不依赖文件顺序

**实测覆盖**：全量卡池 **34,522 / 35,879 = 96.2%**

### 前端：卡牌文本语言是独立偏好

原来卡牌文本读的是**界面语言**，而界面语言闭集里**没有中文**
（`SUPPORTED_LNGS` 只有 `en es fr de it pt pl ja`）→ 中文 sidecar **永远取不到**。

所以加了第三条独立轴：

| 偏好 | 管什么 | 默认 |
| --- | --- | --- |
| `language` | 界面文案 | 自动检测 |
| `artLanguage` | 卡图 | `"auto"` |
| **`cardTextLanguage`** | **卡名 / 规则文本 / 类别行** | **`"zhs"`** |

**默认选 `"zhs"` 而不是 `"auto"` 有具体原因**：`"auto"` 解析成界面语言，
而界面语言永远不是中文 → 默认值会让 sidecar **永远不加载**。

设置界面在「卡图语言」旁边加了控件，8 种语言的文案都是**真翻译** ——
两个控件在英文里读起来几乎一样（"Card art language" / "Card text language"），
复制英文兜底会把文本设置**错标成卡图设置**。

**回退是安全的**：`ensureCardLocale` 把 sidecar 404 解析成空 map，两个调用点
都**逐字段**回退英文，所以未发布的语言只会降级，不会让卡牌出错。

### 许可

文本是 **CC-BY-SA-4.0**（不同于 MTGJSON 的 MIT），已记入仓库根目录 `NOTICE`。
派生产物 `client/public/card-data.zhs.json` 是**构建输出、不进 git**
（已被 `client/public/card-data.*.json` 规则忽略）；跟随仓库的是**生成脚本、
它读的源版本号、以及那段致谢**。

## 中文卡图：已覆盖全量卡池（不再限于 WHO）

中文图来自**两条独立链路**（图来自 `patches/zhs-card-art/`，文本来自本系列），
两条现在都覆盖全量池：

| 链路 | 覆盖 | 数据来源 |
| --- | --- | --- |
| **卡牌文本** | 34,522 / 35,879 = **96.2%** | 大学院废墟 `zhs_oracle.json` |
| **卡牌图** | 40,836 / 68,318 印刷 = **59.8%** | 大学院废墟索引 API（`zhs_image_url`） |

没有中文图的印刷**退回英文图**（不是缺图），这是图源本身的覆盖，不是配置问题。

> **历史**：早期做法是**逐张探测 CDN**（每个印刷一次请求），全量池下是**小时级**，
> 所以当时只生成了 `_WHO` 范围（398 个 id，全量池里仅 0.6% 有中文图）。
> 后来发现大学院废墟**自带索引 API**，逐印刷直接回答"有没有中文图"，
> 全量只要 **346 次请求 / 355 秒**，产出 **40,887 个 id**。
> 详见 `patches/zhs-card-art/README.md` 的「两种取数方式」一节。

## 构建流程（叠加后）

```bash
pnpm --dir client install

./scripts/build-wasm.sh                       # 首次 15–20 分钟

# 数据：全量卡池 + 预组只留 WHO
cp data/mtgjson/AtomicCards.full.json data/mtgjson/AtomicCards.json   # 仅首次
MTGJSON_SKIP_REFRESH=1 PHASE_DECKS_SCOPE=_WHO ./scripts/gen-card-data.sh

# 中文卡牌文本（几秒，必须在上面之后）
node scripts/gen-zhs-card-text.mjs

# 衍生物卡图 + 中文卡图可用性表
./scripts/gen-scryfall-token-images.sh
./scripts/gen-derived-art-availability.sh zhs _WHO

pnpm --dir client dev
```
