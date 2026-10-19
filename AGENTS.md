# AGENTS.md

## 开发命令

使用 Node.js 22 或更新版本。

```sh
npm ci
npm run lint             # 对每个 JS/MJS 文件分别检查语法
npm test                 # 领域逻辑、配置和后台单元测试
npm run test:integration # jsdom、worker_threads、生命周期与协议
npm run test:browser     # 实际 Chromium 扩展，仅测试副本授权 localhost
npm run build            # 完整的未打包扩展及 ZIP
```

## 模块职责

插件使用 Chrome Manifest V3。`domain/` 中的纯逻辑不访问浏览器 API。`infra/` 分别负责采集、观察、匹配、渲染、界面展示和流程控制；`content_script.js` 负责配置、查询、导航和页面生命周期的协调。

- `domain/runtime_policy.js`：不可变的公共契约，统一查询、设置、传输、超时和错误码；区分搜索范围与可续处理的工作分片。
- `domain/runtime_config.js`：默认值、类型、数值范围和颜色校验；`numericRanges` 与 `budgetPresets` 同时供设置页使用。
- `domain/pattern_analyzer.js`：有长度限制的正则检查及普通文本模式校验。
- `domain/literal_matcher.js`：Worker 内使用的精确字面匹配；保留 UTF-16 位置，按原生正则语义处理 Unicode 大小写。
- `domain/error_registry.js`、`display_formatter.js`：错误码与状态格式。
- `infra/task_scheduler.js`：采集与渲染共用的调度，定期运行普通任务，避免连续优先续任务占用网页。
- `infra/page_visibility.js`：组合 DOM 祖先、每轮样式检查、可见性排除和 ShadowRoot 访问。
- `infra/selection_capture.js`：控件、同源 frame 与可访问 ShadowRoot 的选区捕获、范围检查和监听；按文档共享监听器，验证实际文档嵌入链。
- `infra/text_mapping.js`：稀疏来源与兼容 segment 的命中位置恢复、共享映射遍历驱动和按需读取匹配文字；不访问 Worker 或界面。入口保留一次异步边界供调用者取消，之后同步检查直接继续，仅实际异步续任务需要等待。
- `infra/text_collector.js`：按字符预算和整次时限分片采集、连续文本块和来源记录。
- `infra/highlight_engine.js`：不改写文本节点的 CSS Highlight / Range 渲染、矩形兼容层、变化快照与导航对象。
- `infra/dynamic_observer.js`：观察根和监听器的生命周期、延迟合并、最长等待、DOM/CSSOM 巡检，含 Chrome 可访问的闭合根。
- `infra/worker_transport.js`：有输入和队列限制的扩展端口传输，提供 Worker 兼容接口。
- `infra/worker_manager.js`：任务取消、启动及运行超时、流式批次确认。
- `infra/search_controller.js`：查询校验、采集、匹配、渲染、状态与资源释放。
- `infra/ui_i18n.js`：界面语言解析、纯文本词条、数字格式与显式 DOM 翻译；不读取配置或保存数据。
- `infra/search_toolbar.js`：单行搜索栏、弹出选项菜单、方式的键盘单选与主栏范围切换、控件状态与错误反馈；不执行查询或滚动。
- `infra/toolbar_position.js`：拖柄交互、位置保留、视口限制及可选的本地坐标保存；不执行查询或定位匹配。
- `search_worker.js`：仅在 Worker 内运行的匹配器，校验协议和扫描上限。
- `background.js`：顶层 frame 注入、发送人校验、消息转发、经发送人验证的设置入口和 offscreen 生命周期。
- `offscreen.html/js`：本地 Worker 宿主，仅通过扩展 runtime 消息通信。
- `options.html/js/css`：设置界面，与页面界面共用配置校验。

## 注入和打包

`background.js` 先注入领域配置、规则和基础设施，最后注入搜索栏工厂及页面协调脚本；`ui_i18n.js` 和 `toolbar_position.js` 必须在使用它们之前注入，`text_mapping.js` 必须在采集器、控制器和高亮模块之前注入。再次注入前先 ping 顶层 frame 的现有监听器；重复初始化模块会重置闭包并丢失活动资源引用。界面消息只发给 frame 0。

`domain/runtime_policy.js` 是运行入口的首个依赖：后台和 Worker 通过 `importScripts` 加载，页面注入、设置页、offscreen 页面及 Blob Worker 同样先加载它。修改公共范围时改这份定义，不在各入口添加数字副本。模块内部的批量、缓存、重试和几何参数应按用途命名；批量用尽必须保留游标或排队续处理，不能变成逻辑搜索配额。

`scripts/package.mjs` 必须包含全部注入文件（包括 `infra/text_mapping.js`）、`search_worker.js`、Worker 导入的 `domain/pattern_analyzer.js` 和 `domain/literal_matcher.js`、offscreen 页面和脚本，以及 `_locales/`。语言目录使用 Chrome 的 `zh_CN` / `zh_TW` 命名，界面配置使用 `zh-CN` / `zh-TW`；manifest 的 `appName/appDescription/openCommand` 消息必须存在于默认英语词条中。缺少运行文件时构建应失败。测试授权、开发样例、node_modules 和报告不能进入 dist。

## 接口约定

- `RRRuntimeConfig.normalize(values)` 返回有范围限制的配置；不得直接赋值未经检查的 storage 数据。
- 配置读取使用 `RRRuntimeConfig.storageKeys` 获取原始存储项，再调用 `migrateStored(items).values`。旧字符预算在内存换算，不自动回写；设置页保存配置时同时写入 `characterBudgetVersion`，之后保留用户主动设置的小预算。旧 `maxBlockChars` 字段不再参与查找或设置界面。
- `RRPatternAnalyzer.analyze(pattern, flags, {mode})` 返回规则检查结果。长正则返回 `deferred`，完整编译和风险检查由 Worker 的 `analyzeInWorker` 完成；不能在网页主线程补做完整编译。静态检查无法保证执行时间。
- `RRLiteralMatcher.compile(pattern,flags)` 返回精确扫描器。短查询走原生字面正则，长 ASCII 查询以固定短 anchor 筛选并核对完整查询，重复失败后惰性建立 KMP；方法切换不得截断范围。Unicode 窗口、拒绝候选后的重叠、sticky、代理项和取消必须保持原合同。
- `RRTextCollector.collect(options)` / `collectBatched(options)` 返回条目数组，并通过不可枚举的 `stats`、`roots` 附带统计和观察根。`storeNodes:false` 用于流式处理，避免保留第二份完整节点列表。`onRoot` 报告新的 Document/ShadowRoot。App 的 DOM 选区使用 `selectionScoped:true`，在建立显示映射前按 Range 过滤，只计选中原字符；未选 CSS 上下文只计预处理和整次时限，不能扩大正则材料块。已裁条目标记 `selectionProcessed:true`，控制器不再重复裁剪。独立 API 不传此开关时保留原始条目合同。
- App 使用 `compactMappings:true`，文本条目为 `{id,node,text,kind:'text',mappingRecords}`。每份来源记录覆盖至多 128 Ki 原字符，保留原字符串引用、UTF-16 偏移、空白状态和显示变换，不为每个空白片段分配映射对象。`RRTextMapping.resolveMatches(records,intervals,options)` 按批恢复实际命中的位置，返回含 `spans` 的命中数组；恢复过程使用同一查询的取消检查和调度。独立调用仍支持 `{id,node,text,kind:'text',segments}`，其中 segment 的 `start/end` 对应 Text 的 `nodeStart/nodeEnd`，显示文字不同的段保留 `sourceText`。
- 控制器将每个命中保存为一个 `boundSpans` 条目。每个 span 含节点的 `nodeStart/nodeEnd`、共享的 `rawSnapshot` 及快照的 `snapshotStart/snapshotEnd`，各偏移均为 UTF-16 位置。控件使用对应 kind 与原值快照引用，并校验实际显示值。搜索、复核和高亮不复制完整匹配文字；只有调用方读取匹配文字时才调用 `RRTextMapping.readBoundText(spans)`。
- `RRHighlightEngine.renderMatches(indexedNodes, matches)` / `renderMatchesBatched(...)` 的参数顺序始终为条目在前、匹配在后，返回 `{marks,handles}`。marks 为导航对象而非 DOM 元素，提供 `isConnected`、`classList`、`scrollIntoView`、`getBoundingClientRect`。一个命中可包含多个 Range。
- 高亮默认按 `budgetMs` 分片；显式 `batchSize` 仍可要求更小的固定工作批次。`setCurrent(mark)` 校验并切换当前命中，返回是否成功；协调层不重复扫描旧命中或同一目标。排队帧执行时由 `navigate(mark, options)` 重新校验，不能省略跨帧校验。
- `RRTaskScheduler.yield()` 保留独立续任务及普通任务的定期执行；不能把多个独立长任务的恢复合成一次微任务批次，否则浏览器无法在它们之间处理输入和绘制。调度器不持有查询状态、DOM 映射或界面对象。
- `RRHighlightEngine.removeHighlights(handles)` 只删除自己持有的 Range、样式和矩形层，不恢复旧网页文字、不 normalize 父节点、不清空网页自己的高亮注册表。
- `RRWorkerTransport.create({signal})` 返回 Worker 兼容对象，`isAvailable()` 判断端口是否可用。已选用实际传输通道后，创建失败应报告错误。
- `RRWorkerManager.search` / `searchStream` 返回 Promise。取消、超时、被新任务取代和 dispose 均须结算当前任务，包括 Worker 尚未创建的阶段。流式生产函数接收 `(sendBatch,shouldContinue,getLastBatchMatchedIds,getLastBatchMatches,getLastBatchCompletedSourceIds)`。第四个参数返回上一批确认的逐项命中范围；第五个参数返回已完整确认的逻辑来源 ID，包括没有命中的来源，用于立即释放其映射。复杂正则来源未结束时保留稀疏来源记录，确认完整来源后只保留命中位置及所需快照引用。
- Worker 协议为 `start → chunks → finish`，另有 `cancel` 和兼容的 `search`；回复 `ack`、`complete`、`error`。批次确认使用 `batchId/matchedChunkIds/completedSourceIds`，转发确认使用 `sequence`。收到 `stopped:true` 后先停止生产，再等待终态消息。物理 chunk ID 严格递增；Manager 独立校验已发送的长度和返回范围，不信任 Worker 自报的来源长度。
- 普通文字和没有正则元字符的表达式使用 `stream` 分片。`runId/offset/ownedStart/ownedEnd/first/last` 中三个偏移都是逻辑块的绝对 UTF-16 坐标；`last` 表示窗口右边缘到达真实块尾，多个尾窗口可为真，直到 `ownedEnd` 到达真实块尾才释放状态。每个块的归属区间必须连续；ruby 基文与注音可以交错，不按活动块数量截断查询。
- 复杂正则使用 `chunk.source={runId,offset,first,last}`，不能同时包含 `stream`。`runId` 等于来源首个物理 chunk 的 ID，首片 `offset` 为 0，各片偏移连续。Worker 收齐真实 `last` 后才对完整来源执行原生正则，命中的 `chunkId` 为该 `runId`，`start/end` 相对完整来源。EOF 确认包含 `completedSourceIds`，无命中也须确认；终止、取消或出错时释放全部未完成来源。
- 搜索覆盖由用户的 `maxScannedChars`、`workerTimeoutMs` 和 `maxMatches` 控制。分片按唯一归属区间计扫描字符，不重复计入上下文；物理窗口和批次最多 16 Mi 字符，用于传输缓冲与逐批确认，不能成为逻辑文本块限制。App 不按节点、根、映射、活动来源、匹配文字副本或快照数量提前结束；独立采集 API 只有调用方显式传入结构预算时才使用该预算。不得随扫描预算预分配等量内存，也不得通过截断文本制造新的锚点、环视或回引结果。
- 平台自身的 String 或 RegExp 失败须清理任务并报告具体错误。原生字符串无法容纳完整来源时使用 `engine-text-too-large` / `414`；不能改成“扫描上限”，不能把平台失败转换为自定文本块阈值。
- 查询只使用同一个整次 deadline，覆盖准备、启动、采集、匹配和渲染。阶段之间传递剩余时间，不重新给出完整时长；不得提前扣除固定余量或另设单片时限。Manager 和 offscreen 按同一剩余时间终止 Worker，宿主失联回收的宽限不能延长查询。
- offscreen 的并行 Worker 槽位仅限制同时执行的任务，超出的任务按 FIFO 排队；等待计入原查询时限，取消、超时和断开须从队列移除，不能另设页面数量或排队数量来拒绝正常查询。
- 限制提示使用 `RRDisplayFormatter.limitFeedback`，分别说明字符预算、整次时限和匹配上限；未知原因显示部分结果，不能统称扫描字符上限。设置界面不增加内部缓冲、映射、根数量或内存阈值。
- `RRDynamicObserver.create(options)` 提供 `start/updateRoots/addRoot/pause/resume/stop/flush/setDebounce/syncControl/dispose`。`syncControl(element, observed)` 同步采集器已读取的公开控件状态，不重复触发刷新；普通输入复用已读 `value`，密码仅使用公开的 placeholder 显示标志。stop 必须使旧恢复 token 失效，并释放全部观察器、监听器和计时器。
- 动态观察的变更批次须处理全部记录；超出当轮处理量的记录保留游标继续，新增节点超出即时发现量时排队遍历其父边界。stop/dispose 同时释放变更队列及续任务计时器。
- `RRSelectionCapture.capture/isValid/rootFor/createTracker`：返回 DOM Range 或 `{kind:"control-selection",node,start,end,valueSnapshot}`；不得读取密码选区，frame 脱离时须释放其文档及 ShadowRoot 监听。
- `RRHighlightEngine.createCollectionGuard()` 提供 `addRoot/isEntryCurrent/entryCurrentSteps/dispose`；控制器在采集前建立，渲染检查采集以来的 DOM 变化，成功、取消和异常路径均释放。`entryCurrentSteps` 为生成器，按同一查询时限分片检查全部相关变化；同步接口用于兼容独立调用。观察器按 Document 共享，不按根数或变更记录数使全部结果失效。
- `RRSearchController.create(callbacks)` 持有结果清理和查询世代。过期任务不能覆盖新查询结果；界面回调接收状态、观察根和导航对象。
- `RRi18n.resolveLanguage(value)` 解析 `uiLanguage`；`setLanguage/getLanguage/t(key,params)/formatNumber/apply(root)` 用于更新语言、纯文本翻译、数字和显式 DOM 翻译。`auto` 优先采用浏览器界面语言，不支持的语言回退到英语；翻译词条不得作为 HTML 注入。
- `RRToolbarPosition.create({container,handle,onMove,onCommit,onDragStart})` 返回 `show/hide/refresh/setConfig/attach/reset/dispose`。`attach` 在重建搜索栏时更换节点，`refresh` 按可见视口和缩放夹回位置。坐标保存为归一化的 `{version:1,x,y}`，只有 `rememberPosition:true` 时使用 `chrome.storage.local` 的 `regexRabbitToolbarPosition`；`uiLanguage` 和记忆开关随其他配置保存到 `storage.sync`。
- `RRSearchToolbar.create(actions)` 返回搜索栏节点、选项更新、状态反馈和菜单接口。方式使用单选按钮组，范围使用大小写按钮后的主栏图标按钮切换“全局 / 选区”，默认主栏宽 400px 且保留全部主栏按钮；保留 scopeEl.value 的 page/selection 合同，只在用户切换值时发出 change 事件，程序赋值不发事件。更新计数后调用 `syncCount()` 同步无障碍标签及菜单导航状态，并取消已过期的序号输入；`onJump(index)` 接收从 1 开始的有效结果序号，`cancelJump(true)` 取消输入并还焦点给计数按钮。`refreshLanguage()` 更新界面词条，`reposition()` 按浮层空间选择上下展开，`getAvoidRect()` 包含当前可见菜单和错误提示。`closeDetails(true)` 关闭菜单并将焦点还给更多按钮；输入框聚焦、点击页面和导航操作关闭菜单。查询文字和错误消息必须通过 `textContent` 或输入框的 `value` 显示。

## 必须保持的行为

- 自定义拦截规则仅允许有长度上限的固定序列，不得在主线程用任意开发者正则匹配用户输入。
- Worker 失败或超时后，不能在网页主线程执行用户正则。
- 即使表达式通过静态检查，也须保留外部超时和有确认、数量受限的批次传输。
- 搜索时限也须覆盖高亮构造和复核；超时后清理未发布对象及自己登记的高亮，再报告超时，并允许立即重试。
- 不能截断超大文本块后，按新边界报告 `^` / `$` 命中。
- Unicode 零宽匹配按完整码点前进，始终保留原 UTF-16 位置。
- 计数和渲染前复核原文、连接状态、CSS 快照及实际可见性。
- 原生 CSS Highlight 的构造和复核阶段不得逐项发布；全部完成后按文档登记，并重新检查与网页高亮名称的竞争，保留原文、可见性和取消校验。
- 搜索和清理保持原 Text 对象身份，并保留网页后来写入的内容。
- 注入的样式和矩形节点标记 `data-regex-rabbit-owned="true"`；自己的界面、高亮和样式变化不能再次触发查询。
- 屏幕外可滚动文字可参与搜索。跨域 frame、像素文字和隐藏元数据不能算作已读取的可见文字。
- 通过检测可用性的 `chrome.dom.openOrClosedShadowRoot` 读取页面闭合根，排除原生输入和密码控件的内部根，并保留 slot 的组合祖先关系。
- 采集器通过 `onControlRead(element, observed)` 同步本轮实际读取的控件状态，控制器只转发当前查询世代的回调；不能等查询完成后再采样，以免丢失扫描期间的变化。巡检和长值指纹不得读取密码值，输入动态变成密码框时应丢弃旧指纹任务。
- 自动更新只在当前页面会话中启用；持久设置不能自行开启实时观察。后台标签页暂停观察及查询，回到前台时补做尚未完成的输入查询；自动更新开启时还须恢复观察并补查询后台期间的变化。
- 输入、选项、配置、自动更新和恢复查询不能主动滚动页面；只有显式查询及定位操作可以滚动。新输入或当前命中变化后，第一次 Enter 定位当前结果；精确保留当前匹配时还须保留已定位状态，Enter 继续下一处，Shift+Enter 切换上一处。文本命中按首尾真实 Range 节点与偏移识别，不能用 bound 条目的局部 `0..displayLength` 混淆同节点等长命中。被动刷新尚未结束时保留有匹配上限约束的待导航意图，完成后执行；用户滚动、新查询、页面隐藏及关闭搜索栏须清除此意图。
- 定位只排队一次动画帧，即使命中已可见也尽量横向、纵向居中；边缘按实际可滚动范围限制，并根据实际可达位置避开搜索栏。使用即刻滚动，检查嵌套滚动容器、frame 与搜索栏覆盖；不得加入延时重复定位。关闭、取消、新查询及网页上的滚轮、触摸、指针按下和滚动按键必须使旧定位失效。
- 关闭搜索栏仅在焦点仍属于搜索栏、原控件仍附着实际页面时恢复原焦点，并避免焦点恢复触发滚动。
- Esc 优先取消序号输入，再关闭选项菜单并将焦点还给更多按钮，其后才清空查询或关闭搜索栏；保留输入法组合阶段的处理和无障碍状态反馈。跳转只接受 1 到当前有效结果总数之间的整数，不能接受未扫描或失效结果的序号。
- 序号跳转发现旧目标失效时，以 `reason:'jump'` 重查并按新结果的序号选择，不能沿用节点身份锚点；新结果总数不足时提示该序号已失效，不能定位到其他项。滚轮、拖动、页面隐藏等取消操作须使等待重查的序号定位失效。
- 默认位置仅存于当前文档内存，关闭重开和替换 body 时保留，刷新或新文档时复位。关闭位置记忆须删除持久坐标并保留本页位置；聚焦拖柄后的 Home 重置本页位置，开启记忆时也删除持久坐标。拖动只由拖柄发起，取消、隐藏和销毁时释放指针监听及排队帧，异步存储结果不能覆盖较新的用户移动。
- 设置读取失败时不得保存默认值覆盖旧设置；重试读取应保留用户尚未保存的编辑。校验失败的折叠字段须先展开，再交给浏览器定位错误。
- 插入 CSS 前校验颜色；即使 storage 数据异常，也必须限制数值配置。
- 提交前运行语法检查和受影响的测试。涉及多个运行模块的修改必须通过实际浏览器测试和完整打包检查。

## 样式与新回归

搜索栏 `style.css` 以 `origin: "USER"` 注入，仅对插件搜索栏使用优先规则。显示状态使用 `data-regex-rabbit-visible`；缩放通过 `--regex-rabbit-scale`，尺寸限制须换算缩放后的物理视口。移除 CSS 时来源必须匹配。重置规则的优先级应低于控件规则，不能重置 SVG 的几何属性；`hidden` 必须覆盖布局的 `display`。计数区域保留空间，菜单和错误提示使用浮层，避免状态切换改变输入框宽度、导航位置或主栏高度。

不得只测试复制出的算法；新测试应运行实际模块或浏览器。整词模式的分支/重叠候选、Unicode 代理项、旧 iframe 仍 `isConnected`、采集后间隙新增、祖先属性影响隐藏间隙、初始化配置与 IME、长控件巡检、设置页数据保留、后台输入恢复、键盘定位与用户滚动取消均有回归用例。
