/**
 * VectorMemoryService.ts
 * 负责向量记忆系统的全局管理：
 * 1. 本地 ONNX 模型的下载、校验与热加载
 * 2. 在线 Embedding API 调用（SiliconFlow 等）
 * 3. 向量化异步写入队列（非阻塞，火了即忘）
 * 4. 存量历史消息的批量补向量化
 * 5. 内存 KNN 余弦相似度检索（第一阶段）
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { getDatabaseService } from '../db/database'

// 向量记忆配置类型
export interface VectorMemoryConfig {
  enabled: boolean
  mode: 'local' | 'online'  // 本地 ONNX 或在线 API
  // 在线模式配置
  onlineApiBase: string
  onlineApiKey: string
  onlineModel: string
  // 本地模式配置
  localMirrorUrl: string  // 模型下载镜像源 URL
}

/** RAG 检索结果项 */
export interface RecalledRound {
  roundId: string
  contentText: string  // user+assistant 已合并的原始文本
  timestamp: number
  score: number
}

/** 异步入队项目 */
interface QueueItem {
  roundId: string
  characterId: string
  text: string
  timestamp: number
}

const MODEL_NAME = 'bge-small-zh-v1.5'
const DEFAULT_MIRROR = 'https://hf-mirror.com'

export class VectorMemoryService {
  private static instance: VectorMemoryService | null = null

  // 本地 ONNX 推理管道
  private extractor: any = null
  private modelLoading = false
  private modelReady = false

  // 异步写入队列
  private queue: QueueItem[] = []
  private processing = false

  // 存量补向量化状态
  private backfilling = false
  private backfillCancelFlag = false

  // 正在进行的模型下载控制器
  private downloadAbortController: AbortController | null = null

  private constructor() {}

  public static getInstance(): VectorMemoryService {
    if (!VectorMemoryService.instance) {
      VectorMemoryService.instance = new VectorMemoryService()
    }
    return VectorMemoryService.instance
  }

  // ===========================================================
  // 配置读写
  // ===========================================================

  public getConfig(): VectorMemoryConfig {
    try {
      const db = getDatabaseService()
      const raw = db.getSetting('vector_memory_config')
      if (raw) {
        return JSON.parse(raw) as VectorMemoryConfig
      }
    } catch (_) {}
    return {
      enabled: false,
      mode: 'local',
      onlineApiBase: 'https://api.siliconflow.cn/v1',
      onlineApiKey: '',
      onlineModel: 'BAAI/bge-large-zh-v1.5',
      localMirrorUrl: DEFAULT_MIRROR
    }
  }

  public saveConfig(config: VectorMemoryConfig): void {
    const db = getDatabaseService()
    try {
      const oldConfigStr = db.getSetting('vector_memory_config')
      if (oldConfigStr) {
        const oldConfig = JSON.parse(oldConfigStr) as VectorMemoryConfig
        const modeChanged = oldConfig.mode !== config.mode
        const modelChanged = oldConfig.mode === 'online' && config.mode === 'online' && oldConfig.onlineModel !== config.onlineModel
        if (modeChanged || modelChanged) {
          console.log('[VectorMemory] 检测到向量计算模式或在线模型变更，自动物理重置 MessageEmbeddings 数据表以允许重新补录！')
          db.db.prepare('DELETE FROM MessageEmbeddings').run()
        }
      }
    } catch (e) {
      console.error('[VectorMemory] 检查模式变更自动重置失败:', e)
    }
    db.setSetting('vector_memory_config', JSON.stringify(config))
  }

  // ===========================================================
  // 硬件资源检测
  // ===========================================================

  public getHardwareInfo(): { freeMemMB: number; cpuCores: number; totalMemMB: number } {
    return {
      freeMemMB: Math.round(os.freemem() / 1024 / 1024),
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      cpuCores: os.cpus().length
    }
  }

  // ===========================================================
  // 本地模型文件管理
  // ===========================================================

  public getModelDir(): string {
    return path.join(app.getPath('userData'), 'models', MODEL_NAME)
  }

  /**
   * 检查本地 ONNX 模型文件是否完整存在
   * 需要以下关键文件：config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx
   */
  public isModelDownloaded(): boolean {
    const dir = this.getModelDir()
    const requiredFiles = [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      path.join('onnx', 'model_quantized.onnx')
    ]
    return requiredFiles.every(f => fs.existsSync(path.join(dir, f)))
  }

  /**
   * 尝试热加载本地 ONNX 模型
   * 不会抛异常，失败时仅记录日志，保证不影响主流程
   */
  public async tryLoadModel(): Promise<boolean> {
    if (this.modelReady) return true
    if (this.modelLoading) return false
    if (!this.isModelDownloaded()) {
      console.log('[VectorMemory] 本地 ONNX 模型未下载，跳过加载')
      return false
    }

    this.modelLoading = true
    try {
      // 动态导入，避免在模块不存在时导致应用启动失败
      const { pipeline, env } = await import('@xenova/transformers')
      env.localModelPath = path.join(app.getPath('userData'), 'models')
      env.allowRemoteModels = false
      env.allowLocalModels = true
      this.extractor = await pipeline('feature-extraction', MODEL_NAME, { revision: 'main' })
      this.modelReady = true
      console.log('[VectorMemory] 本地 ONNX 模型热加载成功！')
      return true
    } catch (err) {
      console.error('[VectorMemory] 本地 ONNX 模型加载失败:', err)
      this.modelReady = false
      return false
    } finally {
      this.modelLoading = false
    }
  }

  public isModelReady(): boolean {
    return this.modelReady
  }

  public isModelLoading(): boolean {
    return this.modelLoading
  }

  /** 当前是否可以进行向量化操作（本地模型已就绪 或 在线配置完整） */
  public isOperational(): boolean {
    const cfg = this.getConfig()
    if (!cfg.enabled) return false
    if (cfg.mode === 'local') return this.modelReady
    return !!(cfg.onlineApiBase && cfg.onlineApiKey && cfg.onlineModel)
  }

  public isEnabled(): boolean {
    return this.getConfig().enabled
  }

  // ===========================================================
  // 模型文件流式下载
  // ===========================================================

  /**
   * 流式下载模型文件列表，支持自定义镜像源
   * 文件列表基于 Xenova/bge-small-zh-v1.5 的实际 HuggingFace 文件结构
   */
  public async downloadModel(
    mirrorUrl: string,
    onProgress: (pct: number, fileName: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const baseUrl = (mirrorUrl || DEFAULT_MIRROR).replace(/\/$/, '')
    const repoUrl = `${baseUrl}/Xenova/${MODEL_NAME}/resolve/main`

    // Xenova/bge-small-zh-v1.5 所需的完整文件列表
    const files = [
      'config.json',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx'
    ]

    const modelDir = this.getModelDir()
    const onnxDir = path.join(modelDir, 'onnx')
    if (!fs.existsSync(onnxDir)) fs.mkdirSync(onnxDir, { recursive: true })

    this.downloadAbortController = new AbortController()
    const signal = this.downloadAbortController.signal

    try {
      const axios = (await import('axios')).default

      for (let i = 0; i < files.length; i++) {
        if (signal.aborted) {
          return { success: false, error: '下载已取消' }
        }

        const file = files[i]
        const destPath = path.join(modelDir, file)
        const fileUrl = `${repoUrl}/${file}`

        // 小配置文件已存在则跳过，onnx 主模型始终重新下载确保完整
        if (file !== 'onnx/model_quantized.onnx' && fs.existsSync(destPath)) {
          onProgress(Math.round(((i + 1) / files.length) * 100), file)
          continue
        }

        const response = await axios.get(fileUrl, {
          responseType: 'arraybuffer',
          signal,
          onDownloadProgress: (evt) => {
            const fileProgress = evt.total ? evt.loaded / evt.total : 0
            const overallProgress = Math.round(((i + fileProgress) / files.length) * 100)
            onProgress(overallProgress, file)
          }
        })

        fs.writeFileSync(destPath, Buffer.from(response.data))
        onProgress(Math.round(((i + 1) / files.length) * 100), file)
      }

      console.log('[VectorMemory] 模型文件全部下载完成！')
      return { success: true }
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
        return { success: false, error: '下载已取消' }
      }
      console.error('[VectorMemory] 模型下载失败:', err)
      return { success: false, error: err.message || String(err) }
    } finally {
      this.downloadAbortController = null
    }
  }

  public cancelDownload(): void {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort()
      console.log('[VectorMemory] 模型下载已取消')
    }
  }

  // ===========================================================
  // 嵌入向量计算
  // ===========================================================

  /**
   * 计算文本的 Embedding 向量
   * 根据当前配置自动选择本地/在线模式，失败时静默返回 null
   */
  public async computeEmbedding(text: string): Promise<number[] | null> {
    const cfg = this.getConfig()
    // 截断过长文本（bge-small 最大 512 token，按字符数粗略控制）
    const trimmed = text.slice(0, 1000)

    if (cfg.mode === 'local') {
      return this.computeLocalEmbedding(trimmed)
    } else {
      return this.computeOnlineEmbedding(trimmed, cfg)
    }
  }

  private async computeLocalEmbedding(text: string): Promise<number[] | null> {
    if (!this.modelReady || !this.extractor) return null
    try {
      const output = await this.extractor(text, { pooling: 'mean', normalize: true })
      return Array.from(output.data as Float32Array)
    } catch (err) {
      console.error('[VectorMemory] 本地计算 Embedding 失败:', err)
      return null
    }
  }

  private async computeOnlineEmbedding(text: string, cfg: VectorMemoryConfig): Promise<number[] | null> {
    if (!cfg.onlineApiBase || !cfg.onlineApiKey || !cfg.onlineModel) return null
    try {
      const axios = (await import('axios')).default
      let url = cfg.onlineApiBase.replace(/\/$/, '')
      if (!url.endsWith('/embeddings')) {
        url += '/embeddings'
      }
      const res = await axios.post(
        url,
        { model: cfg.onlineModel, input: text },
        {
          headers: { Authorization: `Bearer ${cfg.onlineApiKey}` },
          timeout: 15000
        }
      )
      return res.data?.data?.[0]?.embedding ?? null
    } catch (err) {
      console.error('[VectorMemory] 在线 Embedding API 调用失败:', err)
      return null
    }
  }

  // ===========================================================
  // 余弦相似度计算
  // ===========================================================

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  // ===========================================================
  // 异步写入队列（非阻塞，不影响对话主链路）
  // ===========================================================

  /**
   * 将一条轮次加入向量化写入队列（火了即忘，不等待结果）
   */
  public enqueueVectorize(
    roundId: string,
    characterId: string,
    text: string,
    timestamp: number
  ): void {
    if (!roundId || !text.trim()) return
    // 防重复入队
    if (this.queue.some(q => q.roundId === roundId)) return
    this.queue.push({ roundId, characterId, text, timestamp })
    // 如果队列处理器未运行，则启动
    if (!this.processing) {
      this.processQueue().catch(() => {})
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!
        await this.processItem(item)
        // 每条间隔 50ms，防止 CPU 瞬间占满
        await new Promise(r => setTimeout(r, 50))
      }
    } finally {
      this.processing = false
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    const embedding = await this.computeEmbedding(item.text)
    if (!embedding) return
    try {
      const db = getDatabaseService()
      db.saveEmbedding(
        item.roundId,
        item.characterId,
        JSON.stringify(embedding),
        item.text,
        item.timestamp
      )
    } catch (err) {
      console.error('[VectorMemory] 写入 Embedding 失败:', err)
    }
  }

  // ===========================================================
  // 存量历史消息补向量化
  // ===========================================================

  public isBackfilling(): boolean {
    return this.backfilling
  }

  /**
   * 对指定角色的历史消息进行存量补向量化
   * 逆序处理（最新的优先），batchSize 控制每批处理轮数
   */
  public async backfillHistory(
    characterId: string,
    batchSize = 20,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    if (this.backfilling) return
    this.backfilling = true
    this.backfillCancelFlag = false

    console.log(`[VectorMemory] 开始存量补向量化：${characterId}`)
    let done = 0

    try {
      const db = getDatabaseService()

      if (characterId === 'all') {
        const characters = db.getAllCharacters()
        // 先计算所有角色的 done 和 total 总和
        let overallDone = 0
        let overallTotal = 0
        for (const char of characters) {
          const prog = db.getVectorizationProgress(char.id)
          overallDone += prog.done
          overallTotal += prog.total
        }

        onProgress?.(overallDone, overallTotal)

        for (const char of characters) {
          if (this.backfillCancelFlag) break
          while (!this.backfillCancelFlag) {
            const batch = db.getUnvectorizedRounds(char.id, batchSize)
            if (batch.length === 0) break

            for (const round of batch) {
              if (this.backfillCancelFlag) break
              const text = [round.user_content, round.assistant_content]
                .filter(Boolean).join(' ')
              const embedding = await this.computeEmbedding(text)
              if (embedding) {
                db.saveEmbedding(
                  round.round_id,
                  char.id,
                  JSON.stringify(embedding),
                  text,
                  round.timestamp
                )
              }
              overallDone++
              onProgress?.(overallDone, overallTotal)
              // 每条间隔 80ms，防止卡顿主线程
              await new Promise(r => setTimeout(r, 80))
            }
          }
        }
        console.log(`[VectorMemory] 全量存量补向量化完成：共处理 ${overallDone} 轮`)
      } else {
        const { total } = db.getVectorizationProgress(characterId)

        while (!this.backfillCancelFlag) {
          const batch = db.getUnvectorizedRounds(characterId, batchSize)
          if (batch.length === 0) break

          for (const round of batch) {
            if (this.backfillCancelFlag) break
            const text = [round.user_content, round.assistant_content]
              .filter(Boolean).join(' ')
            const embedding = await this.computeEmbedding(text)
            if (embedding) {
              db.saveEmbedding(
                round.round_id,
                characterId,
                JSON.stringify(embedding),
                text,
                round.timestamp
              )
            }
            done++
            onProgress?.(done, total)
            // 每条间隔 80ms，防止卡顿主线程
            await new Promise(r => setTimeout(r, 80))
          }
        }
        console.log(`[VectorMemory] 存量补向量化完成：共处理 ${done} 轮`)
      }
    } catch (err) {
      console.error('[VectorMemory] 存量补向量化异常:', err)
    } finally {
      this.backfilling = false
    }
  }

  public cancelBackfill(): void {
    this.backfillCancelFlag = true
    console.log('[VectorMemory] 存量补向量化已请求取消')
  }

  // ===========================================================
  // RAG 语义检索
  // ===========================================================

  /**
   * 主检索接口：传入查询向量，返回语义相似的历史对话轮次
   * @param characterId 角色 ID
   * @param queryEmbedding 当前用户发言的向量
   * @param excludeRoundIds 需要排除的轮次 ID（最近 N 轮，避免重复）
   * @param topK 最多返回条数（默认 5）
   * @param minSimilarity 最小相似度阈值（默认 0.7）
   */
  public async retrieveSimilarRounds(
    characterId: string,
    queryEmbedding: number[],
    excludeRoundIds: string[],
    topK = 5,
    minSimilarity = 0.7
  ): Promise<RecalledRound[]> {
    try {
      const db = getDatabaseService()
      const rows = db.getEmbeddingsByCharacter(characterId)
      if (rows.length === 0) return []

      const excludeSet = new Set(excludeRoundIds)
      const scored: { row: typeof rows[0]; score: number }[] = []

      for (const row of rows) {
        if (excludeSet.has(row.round_id)) continue
        let embedding: number[]
        try {
          embedding = JSON.parse(row.embedding_json)
        } catch (_) {
          continue
        }
        const score = this.cosineSimilarity(queryEmbedding, embedding)
        if (score >= minSimilarity) {
          scored.push({ row, score })
        }
      }

      // 按相似度降序排序，取 Top-K
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, topK).map(({ row, score }) => ({
        roundId: row.round_id,
        contentText: row.content_text,
        timestamp: row.timestamp,
        score
      }))
    } catch (err) {
      console.error('[VectorMemory] 检索失败:', err)
      return []
    }
  }
}
