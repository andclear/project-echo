import * as fs from 'fs';
import * as path from 'path';

/**
 * 全局总用户画像数据结构接口
 */
export interface GlobalUserProfile {
  name: string;
  age: string;
  occupation: string;
  global_preferences: Record<string, string>;
}

/**
 * 角色专属用户画像数据结构接口 (千人千面)
 */
export interface CharacterUserProfile {
  character_specific_facts: string[];
}

/**
 * UserProfileReaderWriter
 * 负责全局总 USER.md 与分角色专属 USER.md 记忆偏好画像的物理读写与 XML 融合组装。
 * 支撑起 Echo 独特的“千人千面用户画像系统”。
 */
export class UserProfileReaderWriter {
  private static readonly DEFAULT_GLOBAL: GlobalUserProfile = {
    name: '',
    age: '',
    occupation: '',
    global_preferences: {}
  };

  private static readonly DEFAULT_CHAR: CharacterUserProfile = {
    character_specific_facts: []
  };

  /**
   * 确保路径及文件存在
   */
  private static ensureFile(filePath: string, isGlobal: boolean): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      if (isGlobal) {
        // 物理画像初始化只写入空字符串，绝不产生任何占位内容，彻底留白给用户
        fs.writeFileSync(filePath, '', 'utf-8');
      } else {
        this.writeCharacterProfile(filePath, this.DEFAULT_CHAR.character_specific_facts);
      }
    }
  }

  /**
   * 读取全局总 USER.md 画像
   */
  public static readGlobalProfile(filePath: string): GlobalUserProfile {
    const defaultProfile: GlobalUserProfile = {
      name: '',
      age: '',
      occupation: '',
      global_preferences: {}
    };
    try {
      this.ensureFile(filePath, true);
      const content = fs.readFileSync(filePath, 'utf-8');

      // 文件存在但内容为空（0 字节或全空白）时，直接返回空 profile
      if (!content || content.trim() === '') {
        return { ...defaultProfile };
      }
      
      let profile: GlobalUserProfile = { ...defaultProfile };
      
      // 1. 尝试从 HTML 注释中解析 JSON 画像
      const match = content.match(/<!--([\s\S]*?)-->/);
      if (match && match[1]) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (parsed) {
            profile = { ...profile, ...parsed };
          }
        } catch (_) {}
      }
      
      // 2. 双重容错：从自然语言 Markdown 行中强行高精度正则匹配捕获并还原所有字段，支持中英文冒号和空格，杜绝反序列化内存清空与覆盖重置 Bug
      if (!profile.name || profile.name.trim() === '') {
        const nameMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?姓名(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/);
        if (nameMatch && nameMatch[1]) {
          profile.name = nameMatch[1].trim();
        }
      }
      if (!profile.age || profile.age.trim() === '') {
        const ageMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?年龄(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/);
        if (ageMatch && ageMatch[1]) {
          profile.age = ageMatch[1].trim();
        }
      }
      if (!profile.occupation || profile.occupation.trim() === '') {
        const occMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?职业(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/);
        if (occMatch && occMatch[1]) {
          profile.occupation = occMatch[1].trim();
        }
      }

      // 强力逆向还原全局交互偏好列表
      const prefSection = content.split(/## 全局交互偏好/i)[1];
      if (prefSection) {
        const lines = prefSection.split('\n');
        lines.forEach(line => {
          const prefMatch = line.match(/^[-\s*]*\*\*(.*?)\*\*\s*[：:]\s*(.*)/) || line.match(/^[-\s*]*(.*?)\s*[：:]\s*(.*)/);
          if (prefMatch && prefMatch[1] && prefMatch[2]) {
            const key = prefMatch[1].trim();
            const val = prefMatch[2].trim();
            // 排除无用占位及标题
            if (key && val && !key.includes('暂无') && !val.includes('暂无') && !key.includes('全局') && !key.includes('global')) {
              profile.global_preferences[key] = val;
            }
          }
        });
      }
      
      return profile;
    } catch (e) {
      console.error(`[UserProfileReaderWriter] 读取全局画像文件失败: ${filePath}`, e);
    }
    return defaultProfile;
  }

  /**
   * 写入全局总 USER.md 画像
   */
  public static writeGlobalProfile(filePath: string, profile: GlobalUserProfile): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let markdown = '';
    
    // 按照最简洁、无占位的原则生成
    // 如果只有姓名，只写姓名；如果都有，就写对应的行；全部为空则为完全空文件
    const lines: string[] = [];
    if (profile.name && profile.name.trim() !== '') {
      lines.push(`- **姓名**：${profile.name.trim()}`);
    }
    if (profile.age && profile.age.trim() !== '') {
      lines.push(`- **年龄**：${profile.age.trim()}`);
    }
    if (profile.occupation && profile.occupation.trim() !== '') {
      lines.push(`- **职业**：${profile.occupation.trim()}`);
    }

    if (lines.length > 0) {
      markdown += lines.join('\n') + '\n\n';
    }

    const preferences = profile.global_preferences || {};
    const prefKeys = Object.keys(preferences).filter(
      key => preferences[key] && preferences[key].trim() !== ''
    );
    
    if (prefKeys.length > 0) {
      markdown += `## 全局交互偏好\n`;
      prefKeys.forEach((key) => {
        markdown += `- **${key}**：${preferences[key].trim()}\n`;
      });
    }

    fs.writeFileSync(filePath, markdown.trim(), 'utf-8');
  }

  /**
   * 读取分角色专属 USER.md 画像 facts (千人千面)
   */
  public static readCharacterProfile(filePath: string): string[] {
    try {
      this.ensureFile(filePath, false);
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/<!--([\s\S]*?)-->/);
      if (match && match[1]) {
        const data = JSON.parse(match[1].trim()) as CharacterUserProfile;
        return Array.isArray(data.character_specific_facts) ? data.character_specific_facts : [];
      }
    } catch (e) {
      console.error(`[UserProfileReaderWriter] 读取专属角色画像文件失败: ${filePath}`, e);
    }
    return [];
  }

  /**
   * 写入分角色专属 USER.md 画像 facts
   */
  public static writeCharacterProfile(filePath: string, facts: string[]): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const jsonData: CharacterUserProfile = { character_specific_facts: facts };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;

    let markdown = `${jsonComment}\n\n# 角色专属用户侧写\n\n`;
    markdown += `> 本侧写由该 AI 角色在与您的互动交往中，自发通过做梦反思总结提炼生成，展现千人千面的默契。\n\n`;
    markdown += `## 专属画像事实 (Facts)\n`;
    
    if (facts.length === 0) {
      markdown += `*暂无角色专属侧写事实*\n`;
    } else {
      facts.forEach((fact) => {
        markdown += `- ${fact}\n`;
      });
    }

    fs.writeFileSync(filePath, markdown, 'utf-8');
  }

  /**
   * 向角色专属 USER.md 画像追加一条客观陈述句 facts
   */
  public static appendCharacterFact(filePath: string, fact: string): void {
    const facts = this.readCharacterProfile(filePath);
    const cleaned = fact.trim();
    if (cleaned && !facts.includes(cleaned)) {
      facts.push(cleaned);
      this.writeCharacterProfile(filePath, facts);
    }
  }

  /**
   * 组装融合全局与专属画像，输出特定的隔离 XML 格式
   * 用于向大模型进行上下文注入
   */
  public static assembleProfiles(globalPath: string, charPath: string): string {
    const globalProfile = this.readGlobalProfile(globalPath);
    const charFacts = this.readCharacterProfile(charPath);

    // 优先读取并全量送达用户手写定制的 Markdown 全局画像内容
    let globalStr = '';
    if (fs.existsSync(globalPath)) {
      const rawContent = fs.readFileSync(globalPath, 'utf-8').trim();
      // 过滤 HTML 注释，仅提供纯净 Markdown 文本给大模型
      globalStr = rawContent.replace(/<!--[\s\S]*?-->/g, '').trim();
    }

    // 容错降级：如果物理文件为空，则退回至根据字段拼装
    if (!globalStr) {
      globalStr = `- 姓名：${globalProfile.name}\n- 年龄：${globalProfile.age}\n- 职业：${globalProfile.occupation}\n`;
      Object.keys(globalProfile.global_preferences).forEach((key) => {
        globalStr += `- ${key}：${globalProfile.global_preferences[key]}\n`;
      });
    }

    // 格式化专属画像文本
    let charStr = '';
    if (charFacts.length === 0) {
      charStr = '*该角色在以往交往中尚未发现你特异于总设定的偏好*';
    } else {
      charFacts.forEach((fact) => {
        charStr += `- ${fact}\n`;
      });
    }

    // 拼装隔离 XML 标签结构
    let result = `<global-user-profile>\n${globalStr.trim()}\n</global-user-profile>`;
    result += `\n<character-specific-user-profile>\n${charStr.trim()}\n</character-specific-user-profile>`;
    
    return result;
  }
}
