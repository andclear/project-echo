import { ModelAdapter, ModelConfig } from '../models/ModelAdapter'
import { getDatabaseService } from '../db/database'

export class CharacterSummarizer {
  /**
   * 自动调用大模型，归纳总结性格设定 Soul.md 与 世界设定 World.md
   */
  public static async summarize(cardData: any): Promise<{ soul: string; world: string }> {
    const db = getDatabaseService()
    const configStr = db.getSetting('model_config')
    
    if (!configStr) {
      throw new Error('未检测到全局模型配置，请先在“模型配置”菜单中配置并保存大模型连接。')
    }

    let config: { primary: ModelConfig; secondary?: ModelConfig | null; enableSecondary: boolean }
    try {
      config = JSON.parse(configStr)
    } catch (e) {
      throw new Error('全局模型配置解析失败，请重新配置保存模型。')
    }

    if (!config.primary) {
      throw new Error('未检测到有效的主模型配置，请配置主模型。')
    }

    // 实例化适配器
    const adapter = new ModelAdapter(
      config.primary,
      config.enableSecondary && config.secondary ? config.secondary : undefined
    )

    console.log('[Summarizer] 正在对导入设定进行特定字段精简与脱敏...')

    // 1. 必要字段提取与向下兼容兼容 (V2 / V3 格式)
    const name = cardData.data?.name || cardData.name || '未知'
    const description = cardData.data?.description || cardData.description || '无'
    const personality = cardData.data?.personality || cardData.personality || '无'
    const firstMes = cardData.data?.first_mes || cardData.first_mes || '无'
    const scenario = cardData.data?.scenario || cardData.scenario || '无'
    const alternateGreetings = cardData.data?.alternate_greetings || cardData.alternate_greetings || []

    const worldName = cardData.data?.extensions?.world || cardData.data?.character_book?.name || cardData.character_book?.name || '未知'
    const entriesRaw: any[] = cardData.data?.character_book?.entries || cardData.character_book?.entries || []

    // 2. 世界书 entries 过滤精简，仅抽取 comment, content, constant，并依据常驻属性降序排列
    const filteredEntries = entriesRaw
      .map((entry: any) => ({
        comment: entry.comment || '无条目名称',
        content: entry.content || '无设定内容',
        constant: !!entry.constant
      }))
      .sort((a: any, b: any) => {
        if (a.constant === b.constant) return 0
        return a.constant ? -1 : 1 // 常驻条目 (constant=true) 拥有最高优先级排在前面
      })

    // 3. 构建高纯度无冗余的前置请求数据，杜绝无用字段进入 AI 上下文
    const cleanSoulInput = `
--- 角色基本设定元数据 ---
角色姓名 (即唯一主角)：${name}
性格描述：${personality}
人设简介：${description}
开场白：${firstMes}
备选开场白组：${JSON.stringify(alternateGreetings)}
`

    const cleanWorldInput = `
--- 世界观元数据 ---
世界书名称：${worldName}
主角名称 (用于在分析NPC时进行辨别，别混淆主角与NPC)：${name}
基础场景：${scenario}
主要背景设定：${description}

--- 世界书过滤条目列表 (已按常驻属性排序，constant=true 的条目优先级最高) ---
${filteredEntries.length === 0 ? '（暂无任何世界书条目设定）' : filteredEntries.map((entry, idx) => `
[条目 #${idx + 1}]
条目名称：${entry.comment}
是否常驻：${entry.constant ? '是 (最高优先级常驻)' : '否 (次级优先级)'}
条目内容：${entry.content}
`).join('\n')}
`

    console.log(`[Summarizer] 数据过滤成功！已将冗余参数剔除。世界书提取条目数: ${filteredEntries.length}`)
    console.log('[Summarizer] 正在发起 AI 角色提炼请求...')

    // 4. 性格与核心人设 Soul.md (建议 800 字以内)
    const soulPrompt = `你是一个专业的人格设定提炼专家。请阅读以下仅包含必要字段的精炼角色数据，并为其总结出一份精炼、优雅、格式统一的性格与核心人设文档（Soul.md）。
你的输出必须是标准的 Markdown 格式，包含角色基本信息（姓名、外貌）、性格特征（内在与外在表现）、核心动力与目标、以及其标志性的说话语气与口癖风格。

在分析与总结时，你必须【严格遵守】以下四点人设提取规则：
1. 【核心防混淆规则】主角的名字是：${name}。世界书中大部分条目介绍的是其他 NPC 设定。请注意别弄混，绝对不要把 NPC 的外貌、人设或身份误当成主角 ${name} 的设定！
2. 【主角设定世界书融合】部分角色卡在设计时，偶尔会将属于主角 ${name} 的人设补充写入到世界书条目中。如果发现条目的内容明确属于主角 ${name} 本身，请将其吸收整合进性格与人设中。
3. 【系统名/卡包名真名智能纠偏】原始数据中的卡片姓名（"${name}"）可能会被卡片作者误设为系统、卡包或世界观的名称（例如“xxx系统”、“碧蓝航线背景”）。请你仔细阅读“人设简介（description）”与“开场白”，如果发现原始姓名属于此类系统或背景词，请你【主动识别并提取出真正的主角姓名】，并在性格人设提炼中，全部以该真实主角的视角与设定进行精炼和总结，绝不要把系统当成角色人设本身。
4. 【纯简体中文输出限制】你必须完全使用简体中文（Simplified Chinese）来撰写和提炼所有的性格人设细节，绝对不能输出英文或其他语言的内容。

字数建议控制在 800 字左右。不要说任何“这是提炼后的性格”等分析性废话，直接以 Markdown 标题 (# 角色设定 - 性格与人设) 开始输出。

原始高纯度人设数据：
${cleanSoulInput}

如果在上述人设数据之外，下方的世界书中也明确包含主角 ${name} 的核心设定，请一并提炼总结：
${cleanWorldInput}
`

    // 5. 世界观与背景设定 World.md (建议 1000 字以内)
    const worldPrompt = `你是一个杰出的世界观与背景设定提炼专家。请阅读以下过滤精简后的世界设定与排序后的世界书条目，提炼出一份精炼、设定严谨的世界设定与背景文档（World.md）。
你的输出必须是标准的 Markdown 格式。包含世界观背景设定、核心运行逻辑、以及角色所处的特定社会地位或地理场景。

在总结提炼时，你必须【严格遵守】以下三点规范：
1. 【条目优先级重排提炼】下方世界书条目已按常驻属性排序，常驻（constant=true）条目拥有最高优先级，非常驻（constant=false）条目优先级次之，请在总结时合理赋予相应的设定权重。
2. 【剔除客户端美化与状态栏标准】如果条目中包含任何关于卡片美化、对话框状态栏渲染、特定格式代码展示要求等输出标准规范，请【直接忽略并完全剔除】，绝对不要写入 World.md 中。
3. 【纯简体中文输出限制】你必须完全使用简体中文（Simplified Chinese）来撰写和提炼所有的世界观与背景设定，绝对不能输出英文或其他语言的总结。

字数建议控制在 1000 字左右。不要说任何引言、导语或废话，直接以 Markdown 标题 (# 世界设定 - 世界背景) 开始输出。

原始高纯度世界设定与条目：
${cleanWorldInput}
`

    try {
      // 并行请求主模型进行归纳提炼，提升导入速度
      const soulPromise = adapter.chat([
        { role: 'user', content: soulPrompt }
      ], { usePrimary: true })

      const worldPromise = adapter.chat([
        { role: 'user', content: worldPrompt }
      ], { usePrimary: true })

      const [soulRes, worldRes] = await Promise.all([soulPromise, worldPromise])

      let soulContent = soulRes.content || '# 暂无提炼人设'
      let worldContent = worldRes.content || '# 暂无提炼世界观'

      // 去除可能的大模型 Markdown 代码包裹标记 ```markdown ... ```
      soulContent = this.cleanMarkdownBlock(soulContent)
      worldContent = this.cleanMarkdownBlock(worldContent)

      console.log('[Summarizer] AI 提炼圆满完成！')

      return {
        soul: soulContent,
        world: worldContent
      }
    } catch (error: any) {
      console.error('[Summarizer] 提炼异常:', error)
      throw new Error(`AI 智能提炼设定失败: ${error.message || error}`)
    }
  }

  /**
   * 去除 ```markdown ... ``` 外套
   */
  private static cleanMarkdownBlock(text: string): string {
    let cleaned = text.trim()
    if (cleaned.startsWith('```markdown')) {
      cleaned = cleaned.substring(11)
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3)
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3)
    }
    return cleaned.trim()
  }
}
