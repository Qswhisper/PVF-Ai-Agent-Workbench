# Economy / Gold / Fatigue / Mileage / Token / Counter 只读核查

状态：默认可用


## 快速结论

- 本主题复用 NPC Shop、Quest Reward、Event Reward Delivery、Upgrade / Recipe、Stackable Container、Clear Reward、ServerParameter 等现有入口，不重开这些大主线。
- 经济对象按 `已登记 -> 有静态引用 -> 来源/入口链闭合 -> 当前可见/可达 -> 运行时交付或转换确认` 分层；后一级不能由前一级替代。休眠、过期、隐藏、未解析配置保持独立状态，不计入有效日收益或实际消耗。
- 账户余额/服务端计数与同名或近似名的 stackable 券、代币、材料是不同对象；静态物品被消耗或取得也不自动证明账户余额完成转换。

## 默认处理

1. 问金币上限、金币费用、商店价格、里程、疲劳消耗、每日次数、任务计数、活动领取、代币或扣费字段时，先读本任务卡。
2. 需要字段口径时，读 `dictionaries/economy-gold-fatigue-mileage-token-counter-fields.zh-CN.md`。
3. 需要文件矩阵、ID 解析样本和辅助差异时，读 `indexes/economy-gold-fatigue-mileage-token-counter-boundary.zh-CN.md`。
4. 需要文件类型说明时，读 `encyclopedia/pvf-file-types/economy-gold-fatigue-mileage-token-counter.zh-CN.md`。
5. 如果问题转向具体商店购买、强化、活动奖励、翻牌、任务、礼包开包或 UI，转读对应现有主题。
6. 汇总经济来源或消耗时，逐项标注上述可达性层级；没有当前入口或运行时交付证据的条目不并入“玩家实际可获得/可消耗”总量。

## 可接受结论

- 可以说 `etc/mileageshop.etc` 观察到 `[coin]`、`[item]`、`[premium]`、`[creature]`、`[package]`、`[max gift count]`、`[not stackable buy]`、`[recommended avatar list]` 等块。
- 可以说黑钻贩卖机相关代币 `7454`、`7455` 解析到 stackable material。
- 可以说 `etc/itemdropinfo_clearreward.etc [gold card cost table]` 是等级/序号到费用数值的静态表，不证明金币扣除。
- 可以说 `event/heromissionevent.evt` 的 `[repeat]`、`[reset]` 和 `[condition]` 是活动任务计数/重置线索，不证明计数器生效。
- 可以说 `[price]` 在 stackable 配方、商店商品等父上下文中可作为价格线索，但不能跨文件族自动同义。

## 禁止结论

- 不把 `[price]`、`[cost]`、`[cash]`、`[medal]`、`[need material]`、`[gold card cost table]` 写成真实扣费成功。
- 不把 `mileage`、`token`、`point`、`coin`、`fatigue` 写成账号余额、疲劳值、点数或代币实际写入成功。
- 不把 `[db table]`、`[repeat]`、`[reset]`、`[condition]`、`[daily match count]` 写成数据库存在、每日重置或计数器实机生效。
- 不把活动 `[reward]`、`[item]`、邮件配置、翻牌空白物品、PC 房卡或里程商店候选写成物品实际发放。
- 不把 `serverparameter` 经济字段写成服务端一定读取或最终公式。

## 下一步测试建议

本主题当前只做静态知识整理。后续如果要验证实际经济行为，最小顺序是：先选单一入口，例如里程商店兑换、签到疲劳领取、翻牌金牌费用或限制物品补充次数；再确认 item/equipment registry、账号状态、服务端开关、UI/资源、背包空间和日志；最后走受控输出 PVF、读回和实机验证。不要直接改源 PVF。
