# 补丁：简体中文卡图

让 phase.rs 原生显示简体中文卡图。**不修改上游文件以外的东西，也不推上游。**

## 这个目录是什么

```
patches/zhs-card-art/
  README.md                                                       ← 本文件
  0001-feat-art-support-Simplified-Chinese-card-art.patch          ← 功能本体
  0002-test-art-guard-the-mapped-locales-full-size-vocabula.patch  ← 非回归防护测试
  0003-fix-art-attach-the-derived-locale-s-English-rung-at-.patch  ← 降级轮的修复（见下）
```

补丁内容也保存在一个分支上：`patches/zhs-card-art`（基于 `main` 的 `59b2b17`）。
**分支和补丁文件是同一件事的两种形态**，用哪个都行。

补丁**只含代码，不含本目录**——否则补丁会包含自己，套用时层层嵌套（早期版本确实
踩过这个坑：补丁体积从 68KB 涨到 78KB）。本目录由分支上一个独立提交维护，不进补丁。

## 怎么用

补丁在 clean 的 `main` 上应用：

```bash
cd /Users/mouhaowen/phase-rs-who
git checkout main
git pull                                  # 先跟上你的 fork
git checkout -b zhs-card-art              # 换个分支，别在 main 上做
git am patches/zhs-card-art/*.patch       # 应用补丁
pnpm --dir client install                 # 首次需要
```

或者直接用已经带提交的分支：

```bash
git checkout patches/zhs-card-art
```

撤销（补丁还在、工作树回到干净状态）：

```bash
git checkout main && git branch -D zhs-card-art
```

## 上游更新后怎么再套用

```bash
git checkout main
git pull                                  # 拿到上游新代码
git checkout patches/zhs-card-art
git rebase main                           # 有冲突就解冲突
```

冲突几乎只会出现在这几个文件里，且都是「加了几行」的性质：

| 文件 | 改了什么 |
| --- | --- |
| `client/src/services/cardArtLocale.ts` | **新文件**（词汇表，零依赖） |
| `client/src/services/scryfall.ts` | 派生 URL 构造 + `localizeImageUrl` 分支 + 兜底轮查询 |
| `client/src/hooks/useCardImage.ts` | 把 `artLanguage` 接进解析链，阶梯插入英文轮 |
| `client/src/stores/preferencesStore.ts` | `artLanguage` 偏好 + 归一化 |
| `client/src/components/settings/PreferencesModal.tsx` | 设置里的「卡图语言」选择器 |
| `client/src/i18n/locales/*/settings.json` | 每个语言 +2 个键 |
| `client/src/services/visualPacks/types.ts` | locale 白名单放宽为形状校验 |

如果上游自己实现了中文卡图，**删掉这个分支即可**，没有别的收尾工作：

```bash
git checkout main && git branch -D patches/zhs-card-art
rm -rf patches/zhs-card-art
```

## 它到底做了什么

### 为什么不能用现有的本地化机制

现有的 de/es/fr/it/ja/pt 卡图靠一个生成出来的映射表
`client/public/scryfall-images.v2.<lng>.json`：英文印刷 id → 同一个牌的本地语言**印刷** id。
**Scryfall 根本没有简体中文印刷**，所以这张表对 zh 无从生成。

### 所以中文走「派生」路线

大学院废墟（mtgch.com，原 sbwsz.com）的图床路径与 Scryfall 一一对应，
只是换成 `/zhs/` 前缀、扩展名变 `.webp`：

```
https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg        ← 应用原本输出
https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp     ← 简体中文
https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp      ← 同一图床的英文图
```

`<uuid>` 就是**英文印刷的 Scryfall id**——应用本来就有，所以
**不需要任何映射表、不需要生成的产物、也不需要网络请求就能就绪**。

### 两级降级（这是必须的，不是优化）

中文图是**按印刷**存在的，只能靠加载图片才知道有没有（实测：该图床英文图接近 100%，
但某个印刷没有中文版就是 404）。所以卡图阶梯多了一轮：

```
中文图 --404--> 同图床英文图 --404--> 文字占位卡（原有终态，未改动）
```

**顺序很关键**：这一轮必须插在 `{kind: "fallback", src: null}` 终止符**之前**。
`advanceFailedSource` 是按数组顺序走的，放在终止符之后永远走不到，
没有中文版的印刷就会直接显示占位卡——而英文图就在同一个数组里。
`insertBeforeTerminalFallback` 与它的测试就是钉这个位置的。

### 插画裁切（art_crop）故意不改写

裁切图只是插画本身，与语言无关；而且它的 Scryfall URL（带 `?时间戳`）
**正是浏览器已经缓存的那个**。改写它等于每个卡图预览都去第二个图床重下同一张图，收益为零。
（该图床也没有 `/zhs/art_crop`。）

### 卡图语言是独立偏好

界面语言和卡图语言的集合**互不包含**：中文有卡图但**没有界面词典**
（补齐中文界面是 4522 个键的独立工作量，属于第二步），
波兰语有界面但没有任何本地化卡图。所以设置里多了一个独立的「卡图语言」，
默认 `auto`（跟随界面语言）——**现有玩家升级后行为逐字节不变**。

## 一个曾经漏掉的降级缺陷（补丁 0003）

实测发现 `Temple of Mystery`、`Time Wipe` 这类牌在中文模式下**不显示卡图**。原因是两处：

1. **降级轮挂错了地方。** 它挂在 `useCardImage` 里，而那里只覆盖三条覆盖路径（衍生物、
   钉住的印刷、art chain）。**最普通的那条路径**（`fetchCardImageAsset` /
   `…ByOracleId`，也就是「没有任何卡图偏好」的牌）资产是在 `scryfall.ts` 里构造的，
   压根不经过那个辅助函数。于是中文图 404 后没有第二轮可走，直接掉到文字占位卡。
2. **第一次修还修错了顺序。** 我从资产的 `src` 推导降级轮，但那个值**已经被本地化过了**，
   而 `derivedArtSource` 只认 `cards.scryfall.io` 主机 —— 于是又静默返回 `undefined`。
   降级轮是**同一个印刷的英文图**，必须从**本地化之前**的 URL 推导。

现在挂在 `resolveImageAsset`（所有存储图像的**唯一漏斗**）里，并且从本地化前的 URL 推导。
两处都有回归测试钉住（用真实的存储条目，就是上述两张牌）。

**教训**：这类「只在某几条路径上生效」的疏漏，单元测试很难覆盖到——它需要针对
**最普通的调用路径**写测试，而不是针对你以为的那条。

## 验证情况

- `cargo fmt --all -- --check` 通过（改动全在 `client/`，Rust 侧零改动，符合预期）
- `cargo clippy --all-targets -- -D warnings` 通过（首次全量 8m25s，缓存后 8s；**零 warning**）
- `pnpm run type-check` 通过
- `pnpm lint` 0 errors（56 warnings，与基线完全同数；那 56 条都是存量）
- 前端全套测试与 `59b2b17` 基线 worktree **逐用例**对比：**新增失败 0 项**
  （我这边 36 项失败 / 基线 37 项，全部落在基线已有的失败集合内；
  少的 1 项是基线自身 flaky，非本补丁所修）
- **补丁保真性**：在 `59b2b17` 的全新检出上 `git am` 两枚补丁后，
  工作树与开发分支提交的树**哈希完全一致**（除本目录外逐字节相同）
- 六个既有语言的本地化测试全绿，并额外钉住「各尺寸仍解析到中文印刷的对应尺寸」
  与「既有语言不会获得派生轮」——防止我新增的提前返回过度吞并既有路径
- 外部契约用真实 HTTP 请求实测：`/zhs/` 与 `/sf/` 的 small/normal/large 均 200，
  正反面、双面牌、衍生物都覆盖；`/zhs/art_crop` 确实 404；
  `sf/art_crop` 尺寸与 Scryfall 完全一致（626×457）；
  中文图经目视确认（2X2「闪电击」，key 为英文印刷 id）
- 降级路径实测：取一个**完全没有中文图**的印刷（`d4a72769…`），
  中文各尺寸全 404、英文轮 `/sf/normal/…` 200——正是阶梯要处理的场景

## 已知限制

- **没有中文界面**。界面仍是 8 种既有语言之一；卡图与界面语言解耦，这是刻意的（第二步再说）。
- **覆盖率随年代差异很大**：该图床对较新的系列可能还没有中文图，会自动降级到英文图，
  不会出现裂图或占位卡。实测 Bloomburrow 约 29/30 有中文图，而最新系列、促销印刷常常没有。
- **社区中文图带水印**：该图床的中文图既有官方印刷也有社区制作（例如 1993 年的 LEA Sol Ring），
  社区图在文本框位置有 `MTGCH.COM` 水印。
- **部分社区图尺寸略有偏差**（如 488×683 对 488×680），
  在应用固定的 488×680 取景比例下只是观感问题，不会破版。
- **卡图版权不属于本仓库**：应用只在显示时把浏览器指向该图床，不复制、不打包、不再分发。
  若将来要做「离线图像包」，不要把该图床的图打进分发包。
- **未接入视觉包**：视觉包（Visual Packs）里的 `locale:<lng>:<set>` 安装选择器仍是原来的 6 种语言。
  本补丁只放宽了候选键的 locale 形状校验，让 `zhs` 不再抛错，但没有新增中文包可选。

## 与 phase-rs-zh 的关系

`phase-rs-zh` 是同一件事的**书签小工具**版本（注入页面改写 `<img>` 属性）。
本补丁是原生实现，两者互不依赖，`phase-rs-zh` 仓库**没有被本补丁修改过**。

原生化之后 `phase-rs-zh` 仍然有用：它也能给别的地方（比如 phase-rs.dev 官方站）用，
而且不依赖本仓库的构建。
