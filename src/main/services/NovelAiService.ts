import zlib from 'zlib'

export interface NovelAiConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  negativePrompt?: string
  confirmMode?: boolean // true: 二次确认模式, false: 静默模式
  artistString?: string
  qualityPrompt?: string
  sampler?: string
  defaultDimensions?: 'portrait' | 'landscape' | 'square'
}

export class NovelAiService {
  /**
   * 从 NovelAI 的 ZIP 响应包中解析出 PNG 二进制数据
   * 采用纯内存字节解析，防范引入外部 adm-zip 等依赖导致包体积及平台兼容问题
   */
  private static extractPngFromZip(zipBuffer: Buffer): Buffer {
    const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    const headerIndex = zipBuffer.indexOf(signature)
    if (headerIndex === -1) {
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      if (zipBuffer.subarray(0, 4).equals(pngSignature)) {
        return zipBuffer
      }
      throw new Error('无效的图像响应：未在流中匹配到 ZIP 归档或 PNG 签名')
    }

    try {
      const compressionMethod = zipBuffer.readUInt16LE(headerIndex + 8)
      const fileNameLength = zipBuffer.readUInt16LE(headerIndex + 26)
      const extraFieldLength = zipBuffer.readUInt16LE(headerIndex + 28)

      const dataOffset = headerIndex + 30 + fileNameLength + extraFieldLength

      // 1. 读取 LFH 头部声明的压缩尺寸
      let compressedSize = zipBuffer.readUInt32LE(headerIndex + 18)
      let fileData: Buffer

      // 2. 如果 compressedSize 为 0 或不正确，通过定位 Data Descriptor 或 Central Directory 来精准截取
      if (compressedSize === 0) {
        // Data Descriptor 签名: 50 4b 07 08
        const descriptorSignature = Buffer.from([0x50, 0x4b, 0x07, 0x08])
        const descriptorIndex = zipBuffer.indexOf(descriptorSignature, dataOffset)

        if (descriptorIndex !== -1) {
          // 精准切片到 Data Descriptor 签名之前，去除所有尾部干扰
          fileData = zipBuffer.subarray(dataOffset, descriptorIndex)
        } else {
          // 尝试 Central Directory 签名 (50 4b 01 02) 作为边界
          const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
          const centralIndex = zipBuffer.indexOf(centralSignature, dataOffset)
          if (centralIndex !== -1) {
            fileData = zipBuffer.subarray(dataOffset, centralIndex)
          } else {
            fileData = zipBuffer.subarray(dataOffset)
          }
        }
      } else {
        // 如果 compressedSize 大于 0，直接切片
        fileData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize)
      }

      if (compressionMethod === 0) {
        const uncompressedSize = zipBuffer.readUInt32LE(headerIndex + 22)
        return fileData.subarray(0, uncompressedSize)
      } else if (compressionMethod === 8) {
        return zlib.inflateRawSync(fileData)
      } else {
        throw new Error(`不支持的 ZIP 压缩格式: ${compressionMethod}`)
      }
    } catch (err: any) {
      throw new Error(`解析 NovelAI 图像 ZIP 包失败: ${err.message || err}`)
    }
  }

  /**
   * 调用 NovelAI 文生图（Text-to-Image）接口生成图片
   */
  public static async generateImage(
    config: NovelAiConfig,
    prompt: string,
    dimensions: 'portrait' | 'landscape' | 'square' = 'portrait'
  ): Promise<Buffer> {
    const apiKey = config.apiKey?.trim()
    if (!apiKey) {
      throw new Error('未配置 NovelAI 密钥 (API Key)，请先前往「AI 绘图」设置页面配置并保存。')
    }

    const baseUrl = (config.baseUrl || 'https://image.novelai.net').replace(/\/$/, '')
    const url = `${baseUrl}/ai/generate-image`

    // 默认尺寸匹配（优先使用传入的 dimensions，其次使用全局默认生图尺寸，最底线以 portrait 兜底）
    const activeDimensions = dimensions || config.defaultDimensions || 'portrait'
    let width = 832
    let height = 1216
    if (activeDimensions === 'landscape') {
      width = 1216
      height = 832
    } else if (activeDimensions === 'square') {
      width = 1024
      height = 1024
    }

    // 负面提示词
    const negativePrompt =
      config.negativePrompt ||
      'low quality, bad anatomy, worst quality, 3d, monochrome, sketch'

    const modelName = config.model || 'nai-diffusion-4-5-full'
    const isV4 = modelName.includes('-4')

    let finalSampler = config.sampler || 'k_euler_ancestral'
    if (!isV4 && finalSampler === 'k_euler_ancestral') {
      finalSampler = 'euler_ancestral'
    }

    const baseParams: any = {
      width,
      height,
      scale: isV4 ? 6.0 : 5.0,
      sampler: finalSampler,
      steps: 28,
      seed: Math.floor(Math.random() * 9999999999),
      n_samples: 1,
      ucPreset: 0,
      uc: negativePrompt
    }

    if (isV4) {
      baseParams.params_version = 3
      baseParams.prefer_brownian = true
      baseParams.negative_prompt = negativePrompt
      baseParams.noise_schedule = 'karras'
      baseParams.qualityToggle = true
      baseParams.add_original_image = false
      baseParams.controlnet_strength = 1.0
      baseParams.deliberate_euler_ancestral_bug = false
      baseParams.dynamic_thresholding = false
      baseParams.legacy = false
      baseParams.legacy_v3_extend = false
      baseParams.sm = false
      baseParams.sm_dyn = false
      baseParams.uncond_scale = 1.0
      baseParams.use_coords = false
      baseParams.characterPrompts = []
      baseParams.reference_image_multiple = []
      baseParams.reference_information_extracted_multiple = []
      baseParams.reference_strength_multiple = []

      // V4/V4.5 正负面核心 Prompt 嵌套包（解决后端 Go 微服务 unmarshal 空指针 500 报错的关键）
      baseParams.v4_negative_prompt = {
        caption: {
          base_caption: negativePrompt,
          char_captions: []
        }
      }

      baseParams.v4_prompt = {
        caption: {
          base_caption: prompt,
          char_captions: []
        },
        use_coords: false,
        use_order: true
      }
    } else {
      baseParams.sm = false
      baseParams.sm_dyn = false
      baseParams.dynamic_thresholding = false
      baseParams.controlnet_strength = 1.0
      baseParams.legacy = false
      baseParams.add_original_image = true
      baseParams.cfg_rescale = 0.0
      baseParams.noise = 0.2
      baseParams.strength = 0.7
    }

    const payload = {
      input: prompt,
      model: modelName,
      action: 'generate',
      parameters: baseParams
    }

    console.log(`[NovelAiService] 正在向 NAI 发起生图请求，尺寸: ${width}x${height}, 模型: ${payload.model}`)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'EchoPlatform/1.0.0'
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error(`[NovelAiService] API 绘图响应失败 (${response.status}):`, errText)
      try {
        const fs = require('fs')
        fs.writeFileSync('/Users/lillian/github/project-echo/nai_error.log', JSON.stringify({
          url,
          payload,
          status: response.status,
          error: errText
        }, null, 2))
      } catch (logErr) {
        console.error('[NovelAiService] 写入错误日志失败:', logErr)
      }
      throw new Error(`NovelAI 绘图接口报错 (${response.status}): ${errText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const zipBuffer = Buffer.from(arrayBuffer)
    return this.extractPngFromZip(zipBuffer)
  }

  /**
   * 获取 NovelAI 账户订阅状态以及 Anlas 点数余额
   */
  public static async fetchAnlas(apiKey: string): Promise<number> {
    const key = apiKey?.trim()
    if (!key) {
      throw new Error('未配置 API Key')
    }

    const url = 'https://api.novelai.net/user/data'
    console.log('[NovelAiService] 正在查询 NovelAI 账户全部 Anlas 余额...')

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': 'EchoPlatform/1.0.0'
      }
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error(`[NovelAiService] 获取 Anlas 余额失败 (${response.status}):`, errText)
      throw new Error(`获取余额失败 (${response.status})`)
    }

    const data = await response.json()

    // 1. 读取付费单独购买点数 (Paid Anlas)
    const paidAnlas = typeof data.anlas === 'number' ? data.anlas : 0

    // 2. 读取月度订阅赠送点数 (Subscription Anlas)
    let subAnlas = typeof data.subscription?.anlas === 'number' ? data.subscription.anlas : 0

    // 🚀 核心智能兜底：
    // 对于 Opus 顶级订阅（tier: 3），NovelAI 官方在接口中不再显式列出 anlas 字段（因为享受无限免点生图特权）。
    // 其月度包含的这 10000+ 点数额度会被以 fixedTrainingStepsLeft (固定训练步数额度) 展现。
    if (subAnlas === 0 && data.subscription) {
      const trainingAnlas = data.subscription.trainingStepsLeft?.fixedTrainingStepsLeft
      if (typeof trainingAnlas === 'number' && trainingAnlas > 0) {
        subAnlas = trainingAnlas
      }
    }

    return paidAnlas + subAnlas
  }
}
