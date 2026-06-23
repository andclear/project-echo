# Echo (回音) 平台插件与扩展开发指南

本文档用以指导和规范 Echo 平台下的扩展与动态插件系统的开发。文档中详细登记了平台导出的核心宿主桥接 API（Host Bridge API）、大模型调用规范、数据存储结构、AI 绘图接口及常见开发避坑指南，以帮助插件开发者快速且规范地接入平台生态。

---

## 一、 核心设计思想：高内聚、低耦合

为了未来能让用户通过 Zip 压缩包动态导入由第三方开发的插件，目前所有内置的扩展功能均按照**“插件化”**规范进行设计：

1. **绝对隔离原则**：
   - 插件或扩展的前端组件与路由状态必须独立，不能侵入式地修改主程序的全局渲染状态。
   - 插件或扩展的后端服务与数据库表必须独立，避免污染常规聊天数据库。
2. **桥接通信原则**：
   - 前端 $\leftrightarrow$ 后端一律使用统一抽象的 IPC 通道，或者通过预先定义的宿主桥接 API（Host Bridge API）进行交互，插件不能直接读取或篡改宿主程序的私有内部类。
3. **接口复用原则**：
   - 系统将公共的大模型调用、系统设置读取、角色数据管理、AI 绘图等底层服务进行了统一提炼，插件开发者可以直接引用 `PluginBridgeService` 完成开发。

---

## 二、 插件桥接服务：`PluginBridgeService`

为了极大简化插件与宿主程序的交互，我们在宿主后端中提供了通用的桥梁：
- 文件定义：[PluginBridgeService.ts](file:///Users/lillian/github/project-echo/src/main/services/PluginBridgeService.ts)

通过导入 `PluginBridgeService`，你可以非常方便地调用系统的各项核心服务。

---

## 三、 大模型调用 (LLM 调用)

宿主程序为插件提供统一的 AI 适配器调用，支持主大模型与辅助大模型的分配，并在底层做了大量的健壮性容错与占位符动态替换。

### 3.1 调用方法
你可以直接通过 `PluginBridgeService.chat(messages, options)` 呼起大模型。

**代码示例**：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'
import { ChatMessage } from '../models/ModelAdapter'

async function callModel() {
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是一个得力助手。' },
    { role: 'user', content: '请帮我写一首关于夏天的短诗。' }
  ]

  try {
    // 默认分配：优先使用辅助大模型进行生成
    const response = await PluginBridgeService.chat(messages)
    console.log('AI 回复内容：', response.content)
    console.log('Token 消耗：', response.tokenUsage)
  } catch (error) {
    console.error('调用大模型失败:', error)
  }
}
```

### 3.2 🔴 防范 400 错误的黄金准则
在调用大模型接口时，如果不注意数据格式的传递，很容易触发 OpenAI API 反序列化失败或 TypeScript 类型解析异常，导致请求返回 **400/422 错误**。请开发者务必严格遵守以下规范：
1. **严格使用 `ChatMessage[]` 格式数组**：
   - 传入的第一个参数 `messages` 必须是一个**合法的对象数组**。
   - 数组中的每一个元素必须严格包含 `role` 和 `content` 属性。
   - ❌ **千万不要** 传入单个消息对象（如 `messages: { role: 'user', content: '...' }`），或者包含空属性的对象，否则在底层进行 System 消息降级合并（`messages.filter`）或向大模型端点发起请求时会直接崩掉并引发 400/500 异常。
2. **正确指定 `role` 的有效范围**：
   - 消息的 `role` 必须限定在 `'system' | 'user' | 'assistant'` 范围内。
3. **避免包含未闭合的标签**：
   - 如果要手写输入控制结构，需避免在 `content` 中传入容易引发模型流式反序列化混乱的未闭合 HTML 标签。

### 3.3 主大模型与辅助模型的分配路由规则
系统支持在“系统设置-大模型设置”中分别配置一个“主大模型”和一个“辅助大模型”。它们的分配机制由 `options` 参数控制：
- **默认路由机制（不设置 options 或为空）**：
  - **优先使用辅助大模型**。如果用户在常规设置中启用了辅助大模型，系统自动路由至辅助大模型；如果用户未启用或未配置辅助大模型，则默默回退并使用主大模型。
- **显式请求主大模型**：
  - 传入 `options: { usePrimary: true }`。例如进行多模态图像识别分析等需要高推理能力的场景，系统将强制调起主大模型（即使配置了辅助大模型）。
- **显式请求辅助大模型**：
  - 传入 `options: { useSecondary: true }`。此时若系统已启用辅助模型但配置信息不完整，会抛出显式错误，防止静默回退。若未启用辅助大模型，则照常回退使用主大模型。

---

## 四、 全局提示词的调用与注入

系统设置的常规设置中，支持配置一个全局提示词 (Global System Prompt)。

### 4.1 如何获取全局提示词
你可以通过以下方式从数据库中获取当前配置的全局提示词：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

const globalPrompt = PluginBridgeService.getGlobalPrompt()
console.log('当前全局提示词为：', globalPrompt)
```

### 4.2 全局提示词的注入机制
大模型适配器（`ModelAdapter`）在执行普通对话请求时，只要未显式传入 `{ skipSystemInjection: true }`，就会全自动将全局提示词注入到消息历史中：
1. **Prompt 强效双端锁死注入策略**：
   - 如果 `messages` 中已经存在 `role: 'system'` 的系统消息，系统会首先将 `globalPrompt` 追加拼接在该消息的**最前端（开头）**。
   - 同时，由于大模型在处理超长文本上下文时存在“注意力衰减”的问题，适配器会利用近因效应（Recency Effect），在当前 `system` 消息的**最末尾**重新追加全局提示词的强化声明（如：`## 全局高优先级核心指令... \n {globalPrompt}`）。通过“双端锁死”保证其具备最高优先级。
2. **首部追加策略**：
   - 如果 `messages` 中没有任何 `system` 消息，系统会自动在整个消息数组的第 0 位（最前面）插入一条 `role: 'system'`，内容为 `globalPrompt` 的消息。
3. **不支持 System 角色的智能合并降级**：
   - 如果当前使用的模型在配置中被标记为不支持系统角色（`supportsSystem: false`），底层适配器会在最终向 API 发送前，调用 `mergeSystemMessage(messages)`。该方法会自动提取所有的 system 消息内容拼装为 `[系统指令：xxx]\n\n` 融入到首个 `user` 消息的最前面。

---

## 五、 角色与通讯录数据获取

Echo 拥有完善的角色设定系统，角色的全部数据（包括人设、记忆、日程、日记等）存储在专属的物理文件夹和数据库关联表中。

### 5.1 获取通讯录角色列表
要获取当前用户通讯录中的所有角色元数据：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

// 获取所有导入角色的元数据列表（包含 id, name, avatar 相对路径, folder_name 等）
const characters = PluginBridgeService.getCharacters()
```

### 5.2 获取角色的完整详细数据
每个角色的高级数据由专属的物理文件夹（在 `characters/<folder_name>/` 下）进行管理，同时数据库中存有其发布的 Moments 和 ForumPosts。

通过 `PluginBridgeService.getCharacterAllData(characterId, folderName)` 可以一次性获取角色的全部内容：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

const characterId = 'some-char-uuid'
const folderName = 'char_folder_name'

const allData = PluginBridgeService.getCharacterAllData(characterId, folderName)

// 1. 获取角色基本元数据
console.log('姓名：', allData.meta.name)

// 2. 获取各项物理设定文件 (Markdown 纯文本)
console.log('性格人设 (Soul.md)：', allData.files.soul)
console.log('世界设定 (World.md)：', allData.files.world)
console.log('记忆存储 (Memory.md)：', allData.files.memory)
console.log('角色日记 (Diary.md)：', allData.files.diary)
console.log('自省避坑 (DREAM.md)：', allData.files.dream)
console.log('长期规划 (Goals.md)：', allData.files.goals)
console.log('日程设定 (Schedule.md)：', allData.files.schedule)
console.log('当前状态 (State.md)：', allData.files.state)
console.log('外貌特征 (Appearance.md)：', allData.files.appearance)

// 3. 获取该角色发布的朋友圈动态列表
console.log('朋友圈数量：', allData.moments.length)

// 4. 获取该角色发布的论坛帖子列表
console.log('论坛帖子列表：', allData.forumPosts)
```

> [!TIP]
> 如果你需要更自由地进行条件筛选或多表关联查询，可以直接调用底层数据库提供的 Better-Sqlite3 数据库实例：
> ```typescript
> import { getDatabaseService } from '../db/database'
> const db = getDatabaseService().db
> // 执行自定义 SQL
> const rows = db.prepare('SELECT * FROM Moments WHERE character_id = ? AND likes > ?').all(characterId, 5)
> ```

---

## 六、 用户画像、个人人设与用户余额获取

在 Echo 中，用户的人设立场和千人千面画像是独立于角色卡存储的。系统提供了多套画像卡加载与单套个人中心配置两种方式。

### 6.1 画像卡物理存储结构 (多画像管理)
所有的用户画像卡文件存储在：
`app.getPath('userData')/config/user_profiles/` 目录中。
其中每一个用户人设由两个同名物理文件组成：
- `<profileId>.md`：人设卡 Markdown 配置文件。
- `<profileId>.png`：人设卡对应的头像文件。

### 6.2 画像卡配置文件格式
Markdown 画像文件的头部使用 HTML 注释来包裹 JSON 格式 of 元数据（姓名、性别、年龄、职业及自定义交互偏好等），后半部分为纯 Markdown 自然语言描述。
```markdown
<!--
{
  "name": "天行者",
  "gender": "男",
  "age": "24",
  "occupation": "软件工程师",
  "description": "性格开朗，喜欢科幻与技术探讨。"
}
-->

## 个人详细人设说明
...
```

### 6.3 批量获取画像卡列表方法
你可以通过调用 `PluginBridgeService.getUserProfiles()` 来获取当前系统中注册的所有用户画像卡及其解析数据：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

const profiles = PluginBridgeService.getUserProfiles()
profiles.forEach(profile => {
  console.log('人设ID：', profile.profileId)
  console.log('真实姓名：', profile.name)
  console.log('年龄：', profile.age)
  console.log('性别：', profile.gender)
  console.log('头像 (Base64)：', profile.avatar)
  console.log('详细设定 (Markdown)：', profile.content)
})
```

### 6.4 获取个人中心用户人设与钱包余额
如果插件只需要获取用户当前在宿主“设置 - 个人中心”里自己配置的那套常规个人人设卡以及用户个人的钱包余额，可以使用以下接口：

- **`PluginBridgeService.getUserPersonalProfile()`**：返回当前用户的个人人设对象，包含 `nickname`（昵称）、`signature`（个性签名）、`location`（所在地）及 `walletBalance`（钱包余额）。
- **`PluginBridgeService.getUserWalletBalance()`**：快速获取当前用户在个人中心设置的钱包余额（返回纯数字）。

**代码示例**：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

// 1. 获取个人中心配置人设
const userProfile = PluginBridgeService.getUserPersonalProfile()
console.log('用户昵称：', userProfile.nickname)
console.log('个性签名：', userProfile.signature)
console.log('当前所在地：', userProfile.location)

// 2. 获取用户钱包余额
const walletBalance = PluginBridgeService.getUserWalletBalance()
console.log('用户余额：', walletBalance, '元')
```

---

## 七、 调用 AI 绘图功能与提示词生成

平台内置了 AI 绘图功能（底层基于 NovelAI / Stable Diffusion 提供商接口），支持画师分流算法、角色外貌特征自动整合及绘图提示词自动生成。

### 7.1 生成 AI 绘图提示词
当你需要根据当前的聊天背景或一段场景内容生成适合绘图软件的 Danbooru 英文 Tags 时，可以使用 `PluginBridgeService.generateDrawingPrompt(params)`。

此方法自动使用宿主精心调优的“NovelAI 4.5 双角色隔离 Pipe 黄金指令”作为 system prompt，让 AI 分析人设、记忆与上下文场景，生成最贴合的绘图 Tags。

**代码示例**：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

async function generateAndDraw() {
  const soulContent = '一个喜欢读书、知书达理的少女人设，性格温柔...'
  const memoryContent = '短期记忆：今天刚和主角去图书馆借了科幻小说...'
  const contextText = '角色：听说这本新书超级有趣，你要不要先看？\n用户：好啊，谢谢你。'

  // 1. 调用大模型分析上下文生成提示词
  const { prompt, description } = await PluginBridgeService.generateDrawingPrompt({
    soulContent,
    memoryContent,
    contextText
  })

  console.log('生成的英文 Danbooru 提示词：', prompt)
  console.log('生成的中文画面意境描述：', description)
}
```

### 7.2 调用 AI 绘图
调用 `PluginBridgeService.drawImage(prompt, folderName?, dimensions?)` 来生成图像。

此接口会**直接打包使用系统设置里的 AI 绘图参数**，包括用户配置的 API Key、自定义画师串、质量词后缀及画师随机分流设置等，并返回生成的图片 `Buffer`：

**代码示例**：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'
import * as fs from 'fs'

async function triggerDrawing() {
  const prompt = '1girl, reading book, library, soft lighting, cozy atmosphere'
  const characterFolderName = 'gentle_girl' // 传入此项能自动从 Appearance.md 中提取并拼接入外貌 Tags

  try {
    // 2. 发起绘图请求（打包当前系统绘图设置），尺寸设为竖屏 'portrait'
    const imageBuffer = await PluginBridgeService.drawImage(
      prompt,
      characterFolderName,
      'portrait' // 选项: 'portrait' | 'landscape' | 'square' | 'custom'
    )

    // 保存绘制完成的图片
    fs.writeFileSync('output.png', imageBuffer)
    console.log('AI 绘图成功并保存为 output.png！🎨')
  } catch (error) {
    console.error('绘图失败:', error)
  }
}
```

---

## 九、 状态栏全局预设指标获取与格式化

在系统的「设置 - 状态栏设置」中，用户可以预先配置一系列全局状态栏指标（例如“好感度”、“魔法值”等）。开发其他插件（如剧情推进或状态更新分析模块）时，可以通过以下接口获取预配置指标的完整信息，包括含义说明和变动规则：

- **`PluginBridgeService.getGlobalStatePresets()`**：获取用户预设的指标原始配置数组。每一项包含 `label` (指标名称)、`type` (数字类或文本描述类)、`meaning` (指标含义说明)、`rule` (指标变动/影响规则)。
- **`PluginBridgeService.getFormattedStatePresetsText()`**：将这些预设指标的含义、规则自动拼装为格式化好的纯文本字符串，便于直接注入到 AI 提示词（Prompt）中，协助大模型自动学习和适应这些指标的运行逻辑。

**代码示例**：
```typescript
import { PluginBridgeService } from '../services/PluginBridgeService'

// 1. 获取全局预置指标原始列表
const presets = PluginBridgeService.getGlobalStatePresets()
presets.forEach(preset => {
  console.log('状态名称：', preset.label)
  console.log('类型：', preset.type)
  console.log('指标含义说明：', preset.meaning)
  console.log('指标更新/影响规则：', preset.rule)
})

// 2. 直接获取已排版好的 Prompt 注入指导文本
const presetsPromptText = PluginBridgeService.getFormattedStatePresetsText()
console.log('=== 用于注入提示词的配置信息 ===')
console.log(presetsPromptText)
/*
输出样式：
- **好感度** [数值类]：
  * 指标含义：衡量用户与角色之间的社交好感与感情深浅。
  * 变动与影响规则：低于 20 时角色容易冷淡或起冲突，高于 80 时角色将产生顺从和依赖。
*/
```

---

## 八、 附录：插件包元数据模板 (`plugin_manifest.json`)

每个 Echo 插件必须在其根目录下提供一个元数据清单文件，用以声明插件的标识、入口以及所需要向用户申请的权限列表：
- 文件模板：[plugin_manifest.json](file:///Users/lillian/github/project-echo/plugins_dev_doc/plugin_manifest.json)

---

## 十、 插件动态生命周期与 IPC 挂载机制

在主进程中，Echo 提供了一套灵活的生命周期挂载规范。插件通过实现 `IPlugin` 接口，可以被 `PluginManager` 动态载入，并在应用启动时全自动注册自己专属的 IPC 通信通道，从而实现插件的开箱即用与物理代码解耦。

### 1. 接口定义 (`IPlugin`)
```typescript
export interface IPlugin {
  name: string;
  init?(): void;
  registerIpcHandlers?(): void;
}
```
- **`name`**：插件的唯一标识名。
- **`init()`**：在插件被装载时最先触发，适合执行插件自有的数据库初始化、物理文件目录校验等前置工作。
- **`registerIpcHandlers()`**：用于声明并绑定插件自有的 IPC Handle 监听通道。所有通道命名建议加插件名前缀进行命名空间隔离（例如：`theater-create-stage-session`）。

### 2. 插件开发范例
```typescript
import { ipcMain } from 'electron';
import { IPlugin } from '../PluginManager';

export class MyCustomPlugin implements IPlugin {
  public readonly name = 'MyCustomPlugin';

  public init(): void {
    console.log('[MyCustomPlugin] 初始化启动...');
  }

  public registerIpcHandlers(): void {
    // 注册独占的 IPC 处理事件
    ipcMain.handle('my-plugin:get-status', async (event, payload) => {
      return { success: true, version: '1.0.0' };
    });
  }
}
```

### 3. 在主进程中注册载入
主进程仅需在一处通过 `PluginManager` 注册即可完成插件的全生命周期绑定，彻底解决了 `index.ts` 代码体积无限膨胀的痛点：
```typescript
import { PluginManager } from './plugins/PluginManager';
import { MyCustomPlugin } from './plugins/my-custom-plugin';

// 主进程初始化时注册
PluginManager.register(new MyCustomPlugin());
```

---

## 十一、 跨端数据同步与移动端刷新规范

为保证局域网、Web 端以及移动端在休眠锁屏、断网唤醒、网络波动等弱网或离线场景下数据的一致性，Echo 提供了“**推拉结合自愈数据同步模式（Event-driven Push-Pull Sync Pattern）**”的平台级底座能力。

### 1. 后端发送广播事件
当插件处理完计算、或完成了某一推进回合时，可以通过 `PluginBridgeService` 发送一个轻量的广播通知帧：
```typescript
import { PluginBridgeService } from './PluginBridgeService';

// 广播插件自定义状态更新通知（如大剧院剧情推进完毕）
PluginBridgeService.broadcastPluginEvent('my-plugin', 'state-updated', {
  sessionId: 'session_9921',
  success: true
});
```
*注：`PluginBridgeService` 会将该消息重定向为统一的 `plugin-event-broadcast` 事件发送至 EventSource 消息队列，从而免去前端在移动端/浏览器单独配置 sseEvents 的配置强绑定。*

### 2. 前端推拉自愈 Hook (`usePluginSync`)
在前端，我们提供了通用的组合式 API `usePluginSync`。插件页面只需注册此 Hook，即可同时享用以下自愈保活能力：
- 自动订阅该插件事件的 SSE 推送。
- 自动绑定 `sse-connected` 连接重建信号。在手机亮屏、浏览器切回前台等长连接自动恢复时，自动发起拉取请求。
- 对外暴露出统一的 `doSync` 同步句柄。

```typescript
import { usePluginSync } from '@/composables/usePluginSync';

// 🚀 使用通用插件推拉 Hook
usePluginSync({
  pluginName: 'my-plugin',
  eventName: 'state-updated',
  fetchFn: async () => {
    // 执行向服务端的 HTTP 请求，全量同步最新数据状态，实现 100% 数据防卡死与自愈同步
    await loadLatestPluginData();
  }
});
```

---

## 十二、 界面布局与栏位控制 (全宽单栏页面开发规范)

Echo 平台的常规布局为**三栏式**设计：最左侧为系统导航栏，中间为聊天列表/设置目录等辅助边栏（`<aside>` 容器），右侧为聊天会话/功能主面板。

对于需要展示丰富卡片流、笔记块编辑器或大屏交互的插件（如：大剧院 `theater`、心理按摩 `therapy`、树洞 `shudong`），为避免界面被中间辅助栏挤压，我们必须将其配置为**全宽单栏（无中间栏）布局**。

### 1. 隐藏中间辅助边栏
打开主渲染进程的核心路由视图文件 [App.vue](file:///Users/lillian/github/project-echo/src/renderer/src/App.vue)，定位到中间边栏 `<aside>` 声明处，在其 `v-if` 条件中追加您的插件路由名以实现条件屏蔽：
```html
<aside
  v-if="
    sideView !== 'stats' &&
    sideView !== 'moments' &&
    sideView !== 'forum' &&
    sideView !== 'favorites' &&
    sideView !== 'home' &&
    sideView !== 'extensions' &&
    sideView !== 'theater' &&
    sideView !== 'livestream' &&
    sideView !== 'therapy' &&
    sideView !== 'shudong' && // 🚀 屏蔽树洞插件的中间边栏，开启全页面宽屏模式
    (sideView !== 'bookshelf' || selectedBookId)
  "
>
  ...
</aside>
```

### 2. 隐藏拖拽分割线 (Divider Splitter)
同理，在 [App.vue](file:///Users/lillian/github/project-echo/src/renderer/src/App.vue) 中定位到可拖拽分割线 `div` 处，在 `v-if` 条件中追加屏蔽规则，防止一条悬空分割虚线破坏整体排版：
```html
<div
  v-if="
    sideView !== 'stats' &&
    sideView !== 'moments' &&
    sideView !== 'forum' &&
    sideView !== 'favorites' &&
    sideView !== 'home' &&
    sideView !== 'theater' &&
    sideView !== 'livestream' &&
    sideView !== 'therapy' &&
    sideView !== 'shudong' && // 🚀 屏蔽分割线
    (sideView !== 'bookshelf' || selectedBookId)
  "
  class="col-resize-splitter"
>
  ...
</div>
```

### 3. 在主内容区进行挂载
在 [App.vue](file:///Users/lillian/github/project-echo/src/renderer/src/App.vue) 的主内容显示区域，通过 `v-else-if` 条件渲染挂载您的插件主组件：
```html
<!-- ── 树洞 ── -->
<template v-else-if="sideView === 'shudong'">
  <ShudongMain :isMobile="isMobile" @exit="sideView = 'extensions'" />
</template>
```

遵循以上三步即可无缝创建简约、大方且美观的单栏全页宽屏插件交互页面。

---

## 十三、 移动端与手机端显示避坑指南（插件动态视图注册）

在开发拥有独立页面的自定义插件时，容易踩到的一个大坑是：**“插件页面在 PC 浏览器端或 Electron 桌面端能正常显示，但在手机端/移动端打开时直接显示空白”**。

### 1. 移动端空白成因
为了在移动端提供更契合手机屏幕比例的单栏自适应体验，Echo 的前端容器 `<main>` 在手机端会自动添加 Tailwind 的 `hidden`（`display: none`）类，将未声明为活跃主页面的视图直接隐藏。

只有在白名单中的视图才会被放行显示。

### 2. 解决方案：插件动态视图注册
为避免第三方开发者在编写插件时侵入式修改宿主程序的 `App.vue` 白名单文件，宿主引入了**「插件动态视图注册机制」**。

当你的插件拥有自定义的主内容区路由名（即分配给 `sideView` 的字符串标识）时，请在主进程定义的插件类（实现 `IPlugin` 接口）中，显式声明 `views` 数组：

```typescript
import { IPlugin } from '../PluginManager';

export class MyCustomPlugin implements IPlugin {
  public readonly name = 'MyCustomPlugin';
  
  // 🚀 核心：声明本插件所占用的自定义页面/路由视图名称（白名单放行）
  public readonly views = ['my-custom-view'];

  public init(): void {
    // ...
  }
}
```

### 3. 运行原理
1. **收集**：宿主程序在初始化时，`PluginManager` 会自动提取各个已注册插件的 `views` 属性进行合并去重。
2. **桥接**：主进程通过全局的 `'plugin-get-custom-views'` IPC 句柄，向渲染进程提供这批已注册的视图白名单。
3. **放行**：前端 `App.vue` 在挂载时动态拉取该列表，与原有的内置白名单（`stats`, `moments` 等）合并计算，从根本上解决移动端加载第三方插件时的误隐藏空白问题，实现了无侵入式平滑接入。
