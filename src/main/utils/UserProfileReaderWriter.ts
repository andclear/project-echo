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
    if (!filePath || !filePath.trim()) {
      return defaultProfile;
    }
    try {
      if (!fs.existsSync(filePath)) {
        return defaultProfile;
      }
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

      // 强力防崩溃：规整 JSON 读取出的各字段为 String，以防存为 Number 时 trim() 抛出 TypeError
      if (profile.name !== undefined && profile.name !== null) profile.name = String(profile.name);
      if (profile.age !== undefined && profile.age !== null) profile.age = String(profile.age);
      if (profile.occupation !== undefined && profile.occupation !== null) profile.occupation = String(profile.occupation);
      
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

    const jsonData = {
      name: profile.name,
      age: profile.age,
      occupation: profile.occupation,
      global_preferences: profile.global_preferences
    };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;

    // 🚀 大师级高容错全量增量更新策略：
    // 如果原文件存在且含有自定义大量 Markdown 内容，我们进行精密行替换，并重新灌入 HTML 注释，绝不覆写擦除其它 Markdown
    if (fs.existsSync(filePath)) {
      let rawContent = fs.readFileSync(filePath, 'utf-8');
      
      // 过滤剥离以往残留的 HTML 注释
      let content = rawContent.replace(/<!--[\s\S]*?-->/g, '').trim();
      
      const replaceOrAppend = (label: string, value: string) => {
        if (value === undefined) return;
        const regex = new RegExp(`(^|\\n)([-\\s*]*(?:\\*\\*|)?${label}(?:\\*\\*)?\\s*[：:]\\s*)([^\n\r]*)`);
        if (content.match(regex)) {
          // 如果原文件有这行，直接局部精确替换为新值
          content = content.replace(regex, `$1$2${value.trim()}`);
        } else if (value.trim() !== '') {
          // 如果原文件没有这行且新值不为空，我们在头部追加
          content = `- **${label}**：${value.trim()}\n${content}`;
        }
      };

      replaceOrAppend('姓名', profile.name);
      replaceOrAppend('年龄', profile.age);
      replaceOrAppend('职业', profile.occupation);

      const finalMarkdown = `${jsonComment}\n\n${content.trim()}\n`;
      fs.writeFileSync(filePath, finalMarkdown, 'utf-8');
      return;
    }

    // 如果原文件不存在，使用最简洁的格式初始化写入
    let markdown = `${jsonComment}\n\n`;
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

    fs.writeFileSync(filePath, markdown.trim() + '\n', 'utf-8');
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
    const charFacts = this.readCharacterProfile(charPath);

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
    let result = '';

    // 只有当全局画像路径非空且文件存在时，才进行解析并装配
    if (globalPath && fs.existsSync(globalPath)) {
      let globalStr = '';
      const rawContent = fs.readFileSync(globalPath, 'utf-8').trim();
      // 过滤 HTML 注释，仅提供纯净 Markdown 文本给大模型
      globalStr = rawContent.replace(/<!--[\s\S]*?-->/g, '').trim();

      // 容错降级：如果物理文件为空，则退回至根据字段拼装
      if (!globalStr) {
        const globalProfile = this.readGlobalProfile(globalPath);
        globalStr = `- 姓名：${globalProfile.name}\n- 年龄：${globalProfile.age}\n- 职业：${globalProfile.occupation}\n`;
        if (globalProfile.global_preferences) {
          Object.keys(globalProfile.global_preferences).forEach((key) => {
            globalStr += `- ${key}：${globalProfile.global_preferences[key]}\n`;
          });
        }
      }

      if (globalStr.trim()) {
        result += `<global-user-profile>\n${globalStr.trim()}\n</global-user-profile>\n`;
      }
    }

    result += `<character-specific-user-profile>\n${charStr.trim()}\n</character-specific-user-profile>`;
    
    return result;
  }
}
