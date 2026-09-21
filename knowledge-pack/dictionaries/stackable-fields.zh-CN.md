# Stackable 道具字段词典

本文件只写纯字段结论，不写来源链。除 NPC 商店链路中已验证的价格 / 材料字段外，stackable 字段默认都是资料解释或目标 PVF 可观察事实，写入前必须目标 PVF 读回和必要游戏内验证。

## 基础显示

### `[name]`

状态：需验证

含义：道具名字。

注意：文本改动需要读回和游戏内显示确认。

### `[name2]`

状态：需验证

含义：道具第二名称或内部名称线索。

注意：不要当作主显示名。

### `[explain]`

状态：需验证

含义：道具说明文本。

注意：说明文字不证明真实效果。

### `[basic explain]` / `[detail explain]`

状态：需验证

含义：基础 / 详细说明文本。

注意：说明文字不证明真实效果。

## 品质、交易与限制

### `[grade]`

状态：需验证

含义：道具等级或品级相关字段线索。

注意：stackable 中资料解释不足，不能直接套用 equipment 的掉落等级语义。

### `[rarity]`

状态：需验证

含义：道具稀有度或品质等级字段线索。

注意：数值到显示品质需目标客户端确认。

### `[attach type]`

状态：需验证

含义：绑定、交易或附着类型线索。

注意：实际交易限制可能受服务端和账号状态影响。

### `[usable job]`

状态：需验证

含义：可用角色。常见值包括 `[all]`、`[swordman]`、`[demonic swordman]`、`[fighter]`、`[at fighter]`、`[gunner]`、`[at gunner]`、`[mage]`、`[at mage]`、`[priest]`、`[thief]`、`[creator mage]` 等。

注意：实际使用限制需游戏内确认。

### `[minimum level]`

状态：需验证

含义：最低使用等级或领取等级线索。

注意：stackable 中资料解释不足，必须按目标样本验证。

### `[action usable place]`

状态：需验证

含义：可使用地点线索。

注意：地点枚举和实际限制需目标样本和游戏内确认。

## 使用、消耗与召唤

### `[summon apc]`

状态：需验证

含义：stackable 使用效果中的 APC 召唤入口。APC 数字必须通过 `aicharacter/aicharacter.lst` 解析，并继续读取目标 `.aic` 及其依赖。

注意：字段静态存在不证明副本内允许使用、APC 成功生成或行为正常；`[summon npc]` 是另一条未覆盖的机制，不能类推。

### `[stackable type] [waste]` / `[stackable type] [unlimited waste]`

状态：需验证

含义：消耗品使用策略的版本相关线索。已有同一目标版本、同一道具链的实机 A/B 表明，把 `[waste]` 改为 `[unlimited waste]` 与该人偶在副本内成功使用相关；仅移除 `[expert type] [doll_controller]` 和 `[sub type] 2` 未能解除限制。

注意：这不是跨版本枚举定义，不能据此断言所有 `[waste]` 都禁止副本使用，或所有 `[unlimited waste]` 都必然可用。提示、冷却和副本禁用策略仍需逐目标实机验证。

### `[consume item]`

状态：需验证

含义：使用效果执行时的显式物品消耗入口；物品 ID 必须通过 `stackable/stackable.lst` 解析，数量列按目标同类样本确认。

注意：在上述已验证道具链中，只有加入显式 `[consume item]` 后才观察到每次使用扣除材料；单独存在 `[need material]` 未形成按次扣除。其他版本仍须分别验证，不能把两字段视为同义或互相替代。

## 商店与经济

### `[price]`

状态：默认可用

含义：NPC 商店出售链路中，stackable 商品的普通金币价格。


注意：本状态只适用于 NPC 商店出售链路；其他系统需验证。

### `[cash]`

状态：默认可用

含义：NPC 商店出售链路中，现金类 stackable 商品的点券 / CERA 类价格。

注意：实际扣费受账号余额和服务端配置影响。

### `[need material]`

状态：默认可用

含义：NPC 商店出售链路中，stackable 商品的材料兑换条件。


格式边界：目标样本中 `[need material]` 后接材料 ID 与数量行，不使用 `[/need material]` 闭合标签。新增该块前要在目标 PVF 的同类 `stackable/*.stk` 商品样本中确认列形和空 tab；不要凭普通成对标签习惯补闭合标签。

注意：材料 ID 必须通过 stackable registry 解析；不要外推到活动兑换、任务条件或账号计数系统。写入后仍需 readback 和 NPC 商店购买验证。

### `[stack limit]`

状态：默认可用

含义：stackable 道具在背包中的堆叠上限。


注意：该结论只覆盖当前 stackable 样本的数字字段最小替换；不证明所有 stackable 类型、礼包、任务物、账号绑定或客户端显示规则通用。含中文字符串文件改数字字段时仍要走编码安全路线。

## 图标、类型与背包

### `[icon]`

状态：需验证

含义：图标资源引用。

注意：PVF 引用不证明客户端资源存在。

### `[stackable type]`

状态：需验证

含义：道具类型字段。

注意：类型值不能脱离同类样本解释；改类型风险高。

### `[stackable type] [quest]`

状态：需验证

含义：任务物品类型线索。

注意：已有 quest 类道具可作为候选，不代表任意 stackable 改类型后都能替代任务物品。

### `[move wav]`

状态：需验证

含义：移动物品声音。

注意：音效资源属于客户端资源边界。

### `[weight]`

状态：需验证

含义：道具重量字段线索。

注意：stackable 中资料解释不足，显示和负重效果需确认。

### `[npc gift disallowance]`

状态：需验证

含义：NPC 赠送限制线索。

注意：当前资料未吸收到精确解释，只作核查入口。

## 宝箱与选择器

完整容器/礼包/选择箱/随机箱边界见 `dictionaries/stackable-container-package-fields.zh-CN.md` 和 `indexes/stackable-container-package-boundary.zh-CN.md`。本节只保留基础字段入口。

### `[booster category num]`

状态：需验证

含义：宝箱或选择器分类数量线索。

注意：资料解释不足，必须和后续分类块闭合。

### `[booster selection num]`

状态：需验证

含义：宝箱或选择器可选择数量线索。

注意：实际可选数量需游戏内打开确认。

### `[booster select category]`

状态：需验证

含义：宝箱选择分类块。

注意：块内候选 ID 必须按对应 registry 解析。

### `[recommend]`

状态：需验证

含义：推荐候选列表线索。

注意：不等同于完整可选列表。

### `[equipment]`

状态：需验证

含义：在 stackable 宝箱 / 选择器块中，常作为候选装备列表。

注意：这里的数字是候选装备 ID，必须走 equipment registry；不要和当前 stackable ID 混淆。

### `[booster category name]`

状态：需验证

含义：宝箱或选择器分类显示名称。

注意：显示文本不证明分类块完整。

### `[booster info]`

状态：需验证

含义：点券宝箱或特殊宝箱信息块。

注意：块内数字列需要同类样本和游戏内开启结果确认。
