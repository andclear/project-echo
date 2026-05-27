import zlib from 'zlib'

export interface NovelAiConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  negativePrompt?: string
  confirmMode?: boolean // true: 二次确认模式, false: 静默模式
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
      // 兼容性降级：如果返回的已经是 PNG 文件流，直接返回
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      if (zipBuffer.subarray(0, 4).equals(pngSignature)) {
        return zipBuffer
      }
      throw new Error('无效的图像响应：未在流中匹配到 ZIP 归档或 PNG 签名')
    }

    try {
      const compressionMethod = zipBuffer.readUInt16LE(headerIndex + 8)
      const compressedSize = zipBuffer.readUInt32LE(headerIndex + 18)
      const fileNameLength = zipBuffer.readUInt16LE(headerIndex + 26)
      const extraFieldLength = zipBuffer.readUInt16LE(headerIndex + 28)

      const dataOffset = headerIndex + 30 + fileNameLength + extraFieldLength
      const fileData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize)

      if (compressionMethod === 0) {
        // STORED 存储模式
        return fileData
      } else if (compressionMethod === 8) {
        // DEFLATED 压缩模式
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
    const url = `${baseUrl}/anime/generate-image`

    // 默认尺寸匹配
    let width = 832
    let height = 1216
    if (dimensions === 'landscape') {
      width = 1216
      height = 832
    } else if (dimensions === 'square') {
      width = 1024
      height = 1024
    }

    // 负面提示词
    const negativePrompt =
      config.negativePrompt ||
      'low quality, bad anatomy, worst quality, 3d, monochrome, sketch'

    const payload = {
      input: prompt,
      model: config.model || 'nai-diffusion-4-5-full',
      action: 'generate',
      parameters: {
        width,
        height,
        scale: 5.0,
        sampler: 'euler_ancestral',
        steps: 28,
        seed: -1,
        n_samples: 1,
        ucPreset: 0,
        uc: negativePrompt,
        sm: false,
        sm_dyn: false,
        dynamic_thresholding: false,
        controlnet_strength: 1.0,
        legacy: false,
        add_original_image: true,
        cfg_rescale: 0.0,
        noise: 0.2,
        strength: 0.7
      }
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
    console.log('[NovelAiService] /user/data 完整响应数据:', JSON.stringify(data))
    
    try {
      const fs = require('fs')
      fs.writeFileSync('/Users/lillian/github/project-echo/nai_debug.json', JSON.stringify(data, null, 2))
      fs.writeFileSync('/Users/lillian/Library/Application Support/project-echo/nai_debug.json', JSON.stringify(data, null, 2))
    } catch (fsErr) {
      console.error('[NovelAiService] 写入诊断文件失败:', fsErr)
    }
    
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
