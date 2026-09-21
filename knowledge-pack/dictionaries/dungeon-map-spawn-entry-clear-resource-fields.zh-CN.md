# Dungeon / Map / Spawn / Entry / Clear / Resource 字段词典


## Registry

### `dungeon/dungeon.lst`

状态：默认可用

含义：副本 registry。副本 ID 通过本表解析到 `dungeon/**/*.dgn`。

边界：`.dgn` 文件存在不等于副本已注册；副本事实以 registry 为入口。

### `map/map.lst`

状态：默认可用

含义：地图 registry。`.dgn` 中普通 `[map specification]`、`[boss map specification]` 和特殊 `[advance altar map]` 的地图 ID 均按本表解析。

边界：地图文件存在不证明会被某个普通副本使用；还要看 `.dgn` 或 `.map [dungeon]`。

### `worldmap/worldmap.lst`

状态：默认可用

含义：worldmap 入口 registry。城镇 `[dungeon gate]` 后的数字按本表解析到 `.wdm`。

边界：worldmap 静态入口不证明按钮可点、UI 正常或服务端放行。

### `town/town.lst` / `region/region.lst`

状态：默认可用

含义：区域和城镇 registry。`region/*.rgn [towns]` 指向 town ID，`town/*.twn [area]` 可声明普通区域、城镇门或副本门。

边界：城镇/区域静态配置不证明玩家当前角色能到达该入口。

## `.dgn` 字段

### `[name]` / `[explain]`

状态：默认可用

含义：副本名称和说明文本。

边界：文本不证明入口可见或副本可进。

### `[entering title]`

状态：默认可用

含义：进图标题动画引用。

边界：引用不证明客户端动画资源存在或显示正常。

### `[cutscene image]` / `[minimap image]`

状态：默认可用

含义：副本选择、切图或小地图相关 `.img` 引用。

边界：Script.pvf 内引用不证明客户端 ImagePacks2/NPK 含有该资源。

### `[worldmap pattern info]`

状态：默认可用

含义：worldmap 选择槽和图案相关静态配置，可包含数值、slot `.img` 引用和控制值。

边界：只证明 PVF 中有 worldmap 展示配置，不证明 UI slot 正常。

### `[minimum required level]`

状态：默认可用

含义：副本静态最低等级字段。


边界：不证明服务端最终等级校验只看这一项，也不等同任务 `[level]`。

### `[basis level]`

状态：默认可用

含义：副本基础等级或经验/难度计算相关静态等级线索。


边界：不直接等同入场等级；不证明可见装备奖励池、免费翻牌金币公式、概率表或所有副本通用。

### `[evil]`

状态：需验证

含义：副本抗魔要求或战斗缩放入口线索；需与装备 `[anti evil]` 联合读取。

边界：字段存在不证明玩家会被禁止进入。一个历史目标实机样本表现为阈值以下可以入场但承受严重战斗惩罚，达到阈值后恢复正常；这只证明需要区分“硬性入场门槛”和“入场后缩放”，不提供跨版本阈值、伤害倍率或最终公式。最低运行矩阵至少包含阈值以下与达到阈值两个点，并分别记录入口、面板和战斗表现。

### `[required item]`

状态：默认可用

含义：副本入场消耗/门票静态字段。样本列形为物品 ID、数量和控制值，物品 ID 按 `stackable/stackable.lst` 解析。


边界：示例不证明第三列所有取值、多门票组合、疲劳、组队、深渊或所有副本通用。

### `[maze info]` / `[size]` / `[greed]`

状态：默认可用

含义：副本房间布局块。`[size]` 给出网格尺寸，`[greed]` 给出房间字母布局。

边界：布局文本不证明实际房间推进、门状态或路径可通。

### `[map specification]`

状态：默认可用


边界：只适用于普通父块，不要拿来解释特殊副本的自定义 map 字段。

### `[boss map specification]`

状态：默认可用

含义：Boss 地图绑定块。列形与普通 map specification 类似，map ID 按 `map/map.lst` 解析。

边界：Boss map 静态存在不证明 Boss 刷出或通关成功。

### `[start map]` / `[boss map]`

状态：默认可用

含义：起始房间与 Boss 房间的坐标/房间定位字段。旧式副本可只有这些字段而没有显式 `[map specification]`。

边界：该字段不是稳定的 map registry ID 列，不能裸拿其中数字去解析地图。

### `[pathgate object]`

状态：默认可用

含义：副本门对象配置 ID 列。用于控制路径门外观或对象集合。

边界：静态门对象不证明门可通、锁门正确或客户端表现正常。

### `[quest connection]`

状态：默认可用

含义：任务相关 maze 分支线索。

边界：不证明任务已接、任务条件满足或任务链生效。

### `[event monster]`

状态：默认可用

含义：副本层事件怪物线索。

边界：不等同普通 `.map [monster]` 出生记录，也不证明事件触发。

### `[advance altar map]`

状态：默认可用

含义：AdvanceAltar 类特殊副本的地图绑定字段。样本按难度标签连接 map ID 与控制值，map ID 仍按 `map/map.lst` 解析。

边界：这是特殊分支，不并入普通 `[map specification]` 规则。

### `[advance altar clear reward]`

状态：默认可用

含义：AdvanceAltar 类特殊清算奖励块。

边界：不等同全局 `etc/itemdropinfo_clearreward.etc`，也不证明奖励实机发放。

### `[special passive object item]`

状态：默认可用

含义：特殊地图对象关联物品/参数块。


边界：数字含义依赖父块和对象类型，不能裸猜为掉落物或概率；高罐和非物品型对象不在该样本覆盖内。

## `.map` 字段

### `[dungeon]`

状态：默认可用

含义：`.map` 反向归属的 dungeon ID，按 `dungeon/dungeon.lst` 解析。

边界：部分特殊地图没有该块；缺失不自动证明地图废弃。

### `[type]`

状态：默认可用


边界：类型字符串不证明刷怪、通关或奖励逻辑。

### `[tile]` / `[extended tile]`

状态：默认可用

含义：地图地形资源引用，通常为 `.til`。

边界：PVF 引用不证明客户端渲染完整。

### `[pathgate pos]`

状态：默认可用

含义：房间门或路径门坐标配置。

边界：不证明门可通、锁门或开门时序正确。

### `[sound]`

状态：默认可用

含义：地图 BGM 或环境音标识。

边界：不证明客户端音频文件存在或播放正常。

### `[animation]` / `[background animation]`

状态：默认可用

含义：地图动画引用和坐标/层级配置。

边界：不证明动画资源存在、层级正确或实机不卡顿。

### `[passive object]`

状态：默认可用

含义：地图对象投放块。样本按 object ID、X、Y、Z 四列重复，object ID 按 `passiveobject/passiveobject.lst` 解析。

边界：这是地图对象，不等同玩家技能 passiveobject、攻击盒或 NUT 运行时。

### `[special passive object]`

状态：默认可用

含义：特殊地图对象投放和对象控制块。

边界：列义依赖对象类型；不能把所有数字统一写成物品、概率或动作。

### `[monster]`

状态：默认可用

含义：地图出生记录。完整记录的首列按 `monster/monster.lst` 解析，后续列包含坐标、数量、阵营或类型控制线索。

边界：静态出生记录不证明怪物实机刷出、AI 正常、掉落正确或锁门清算成功。

### `[monster specific AI]`

状态：默认可用

含义：地图出生记录配套的 AI/行为类型线索。

边界：不替代 `.mob [ai pattern]` 和 AI 主线复核。

### `[event monster position]`

状态：默认可用

含义：事件怪物位置坐标组。

边界：只证明坐标配置存在，不证明事件触发。

### `[NPC]`

状态：默认可用

含义：地图内 NPC 或特殊单位配置块。

边界：NPC 可见、交互和任务按钮需要实机验证。

### `[dungeon start area]` / `[summon start area]`

状态：默认可用

含义：特殊地图的起始区域或召唤区域坐标配置。

边界：不证明实机出生点、召唤时序或镜头表现正确。

## 入口、掉落与清算文件

### `worldmap/*.wdm [dungeon]`

状态：默认可用

含义：worldmap 页面列出的 dungeon ID，按 `dungeon/dungeon.lst` 解析。

边界：不证明副本按钮可点、频道条件满足或服务端放行。

### `worldmap/*.wdm [ui path]`

状态：默认可用

含义：worldmap 页面对应 UI 文件引用。

边界：UI 文件存在不证明客户端 `.img` 资源齐全。

### `worldmap/ui/*.ui [ui controls]`

状态：默认可用

含义：worldmap UI 控件、按钮坐标、图像和 action 引用。

边界：不证明界面显示、点击命中或按钮逻辑正常。

### `town/*.twn [area] -> [dungeon gate]`

状态：默认可用

含义：城镇区域中的副本门入口，数字按 `worldmap/worldmap.lst` 解析。

边界：不证明角色能到达、入口可点或 UI 正常。

### `etc/independentdrop.lst`

状态：默认可用

含义：独立掉落 registry，解析到 `etc/independentdrop/*.etc`。

边界：独立掉落不是任务奖励、普通怪物掉落或清算翻牌。

### `etc/itemdropinfo_clearreward.etc`

状态：默认可用

含义：清算/翻牌全局配置文件，含掉落概率、金牌成本、空白候选和引用表等块。

边界：静态表不证明翻牌 UI、金币扣除、奖励发放、PC 房加成或概率实机一致。
