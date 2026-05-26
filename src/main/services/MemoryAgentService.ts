import * as path from 'path';
import { BrowserWindow } from 'electron';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { InferenceMutex } from '../utils/InferenceMutex';
import { MemoryReaderWriter } from '../utils/MemoryReaderWriter';
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter';
import { StateReaderWriter } from '../utils/StateReaderWriter';

/**
 * MemoryAgentService
 * 负责在对话完成后，静默进行长期记忆（LTM）与专属用户偏好画像（USER.md）的后台提取与物理更新。
 * 同时，将状态系统（State.md）的动态更新（Delta 增量）也合入本轮自省流程，实现零额外费用开销！
 */
export class MemoryAgentService {
  private modelAdapter: ModelAdapter;

  constructor(modelAdapter: ModelAdapter) {
    this.modelAdapter = modelAdapter;
  }

  /**
   * 核心后台反思任务：从最新一轮交互中提取并沉淀记忆、画像以及评估心情状态的 Delta 并落盘
   * @param memoryPath 专属 Memory.md 绝对路径
   * @param charUserPath 专属 USER.md 绝对路径
   * @param userMessage 本回合用户输入
   * @param assistantMessage 本回合 AI 角色流式输出的完整回复
   */
  public async extractMemoryAndProfile(
    memoryPath: string,
    charUserPath: string,
    userMessage: string,
    assistantMessage: string
  ): Promise<void> {
    
    // 1. 获取非阻塞并发互斥锁，确保前台 Stream 对话没有任何卡顿
    await InferenceMutex.lock();

    try {
      console.log('[MemoryAgentService] 互斥锁获取成功，开始后台长期记忆、专属画像与状态 Delta 自省提取...');

      // 获取当前角色的状态，并格式化为上下文 (提取 rule 自然语言 AI 更新规则)
      const statePath = path.join(path.dirname(memoryPath), 'State.md');
      const currentState = StateReaderWriter.readState(statePath);
      const stateContext = currentState.items
        .map(i => {
          const meaningDesc = i.meaning ? ` (指标含义：${i.meaning})` : '';
          const ruleDesc = i.rule ? ` (AI更新规则：${i.rule})` : '';
          const minVal = i.min ?? 0;
          const maxVal = i.max ?? 100;
          return `- ${i.label} (${i.key}): 当前值 ${i.value}${meaningDesc}${ruleDesc} (取值范围 ${minVal}-${maxVal}) ${i.emoji}`;
        })
        .join('\n');

      // 组装反思 System Prompt（合入 state_updates 评估，并赋予模型阅读自然语言自定义规则与指标含义的能力）
      const systemPrompt = `You are a background cognitive extraction sub-agent for the Echo platform. Your sole task is to analyze the latest dialogue turn between the User ({{user}}) and the Character, extract durable facts about the user, and evaluate how this turn affected the Character's inner states (intimacy, mood, energy, and custom rules).

CRITICAL INSTRUCTIONS:
1. Write facts as declarative, objective, third-person facts (e.g. "User prefers concise answers" or "User birthday is September 10th").
2. NEVER write imperative instructions to yourself (e.g. Do NOT write "Always respond concisely").
3. Filter out task-specific details, temporary TODOs, or any progress detail that will be stale within 7 days.
4. Distinguish between LTM Updates, STM updates and Character-Specific User Persona facts:
   - "ltm_updates": Persistent environment facts, user general habits, stable conventions, things learned.
   - "stm_updates": Fresh short-term facts from THIS specific conversation turn only (1-3 concise facts).
   - "char_user_facts": Facts specific to how the User interacts with THIS specific Character (not globally generic).
5. Evaluate the emotional impact on the Character's states. Review the Character's Current States, their values, their meanings ("指标含义"), and their specific custom update rules ("AI更新规则") (if any).
   - If the User is warm, caring, supportive, or complimentary: mood delta increases (+5 to +10), intimacy delta grows slightly (+1 to +3).
   - If the User is cold, critical, argumentative, or silent: mood delta drops significantly (-10 to -20), intimacy delta decreases (-2 to -5), energy drops (-5).
   - Every dialogue turn naturally consumes the character's energy, so energy delta should almost always decrease (-2 to -5) unless the interaction is specifically restorative or energy-boosting.
   - For any custom numeric states (like custom_st_xxxx), you MUST evaluate their delta updates based on their natural language meanings ("指标含义") and natural language update rules ("AI更新规则") described in the states list. Apply positive or negative deltas according to how the dialogue content conforms to the rules.
   - For custom text-based states (type is 'text', e.g. clothing), you CAN also output state updates for them. Evaluate if the dialogue implied any changes to these text states based on their descriptions and rules. Provide the updated text content in the 'value' field (do NOT provide 'delta' for text states).
6. ALL extracted facts (ltm_updates, stm_updates, char_user_facts) MUST be written in Simplified Chinese (简体中文).

Character's Current States:
${stateContext}

You MUST reply with a single JSON object matching this structure EXACTLY. Do not wrap it in markdown code blocks unless they are standard json fences, and do not append any conversation or explanation.

Target JSON format:
{
  "ltm_updates": {
    "key_describing_habit": "declarative fact content"
  },
  "stm_updates": [
    "short-term fact from this turn"
  ],
  "char_user_facts": [
    "declarative fact content"
  ],
  "state_updates": [
    { "key": "intimacy", "delta": 2 },
    { "key": "clothing", "value": "白大褂" }
  ]
}`;

      // 组装聊天内容快照
      const userContent = `[LATEST DIALOGUE TURN]\nUser: ${userMessage}\nCharacter: ${assistantMessage}`;
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ];

      // 2. 调用大模型进行静默推理 (首选辅助大模型 options.useSecondary: true)
      const response = await this.modelAdapter.chat(messages, { useSecondary: true });
      const rawContent = response.content.trim();

      // 3. 正则捕获 JSON 内容区
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];
        const parsed = JSON.parse(jsonStr) as {
          ltm_updates: Record<string, string>;
          stm_updates: string[];
          char_user_facts: string[];
          state_updates?: { key: string; delta?: number; value?: any }[];
        };

        // 4. 调用高精度物理写盘引擎，将增量数据安全落盘
        // A. 短期记忆 (STM) 更新
        if (Array.isArray(parsed.stm_updates) && parsed.stm_updates.length > 0) {
          for (const stmFact of parsed.stm_updates) {
            const cleaned = stmFact.trim();
            if (cleaned) {
              MemoryReaderWriter.pushSTM(memoryPath, cleaned);
              console.log(`[MemoryAgentService] 物理短期记忆落盘 STM: ${cleaned}`);
            }
          }
        }

        // B. 长期记忆 (LTM) 更新
        if (parsed.ltm_updates && typeof parsed.ltm_updates === 'object') {
          const ltmKeys = Object.keys(parsed.ltm_updates);
          if (ltmKeys.length > 0) {
            const memory = MemoryReaderWriter.readMemory(memoryPath);
            ltmKeys.forEach((key) => {
              memory.ltm[key.trim()] = parsed.ltm_updates[key].trim();
              console.log(`[MemoryAgentService] 物理记忆落盘 LTM: [${key}] -> ${parsed.ltm_updates[key]}`);
            });
            MemoryReaderWriter.writeMemory(memoryPath, memory.stm, memory.ltm);
          }
        }

        // C. 角色专属千人千面画像 (USER.md) 更新
        if (Array.isArray(parsed.char_user_facts) && parsed.char_user_facts.length > 0) {
          const facts = UserProfileReaderWriter.readCharacterProfile(charUserPath);
          let updated = false;
          parsed.char_user_facts.forEach((fact) => {
            const cleaned = fact.trim();
            if (cleaned && !facts.includes(cleaned)) {
              facts.push(cleaned);
              updated = true;
              console.log(`[MemoryAgentService] 物理专属画像落盘 Fact: ${cleaned}`);
            }
          });
          if (updated) {
            UserProfileReaderWriter.writeCharacterProfile(charUserPath, facts);
          }
        }

        // D. 角色状态 (State.md) Delta 增量更新与物理落盘
        if (Array.isArray(parsed.state_updates) && parsed.state_updates.length > 0) {
          StateReaderWriter.applyStateUpdates(statePath, parsed.state_updates);
          console.log(`[MemoryAgentService] 物理状态增量更新落盘成功:`, parsed.state_updates);

          // 穿透广播给渲染进程前端以驱动仪表盘的动画浮动与数值更新
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('character-state-updated', {
              characterId: path.basename(path.dirname(memoryPath)), // 角色 folderName 作为临时标志，也可以直接传 folderName 
              updates: parsed.state_updates
            });
          }
        }
      } else {
        console.warn('[MemoryAgentService] 无法从大模型响应中截获合法的 JSON 数据块:', rawContent);
      }

    } catch (e) {
      console.error('[MemoryAgentService] 后台记忆与状态自省提取失败:', e);
    } finally {
      // 5. 绝对确保安全地释放锁，激活队列中下一个等待的任务
      InferenceMutex.unlock();
      console.log('[MemoryAgentService] 后台自省任务结束，互斥锁已安全释放。');
    }
  }
}
