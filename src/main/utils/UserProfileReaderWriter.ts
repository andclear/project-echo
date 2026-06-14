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
  gender?: string;
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
  private static getUserNameCallback?: (folderName: string) => string | null;

  /**
   * 物理扫描并获取 config/user_profiles/ 下所有人设卡中注册的用户真实姓名列表
   */
  public static getAllUserProfileNames(): string[] {
    const names: string[] = [];
    try {
      const { app } = require('electron');
      const userDataPath = app.getPath('userData');
      const targetProfilesDir = path.join(userDataPath, 'config', 'user_profiles');
      if (fs.existsSync(targetProfilesDir)) {
        const files = fs.readdirSync(targetProfilesDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const filePath = path.join(targetProfilesDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          
          let userName = '';
          // 1. 尝试解析 HTML 注释中的 JSON 块以获得姓名
          const match = content.match(/<!--([\s\S]*?)-->/);
          if (match && match[1]) {
            try {
              const parsed = JSON.parse(match[1].trim());
              if (parsed && parsed.name) {
                userName = String(parsed.name).trim();
              }
            } catch (_) {}
          }
          // 2. 备用容错：如果注释中无姓名，则从 Markdown 语法行正则捕获姓名
          if (!userName) {
            const nameMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?姓名(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/);
            if (nameMatch && nameMatch[1]) {
              userName = nameMatch[1].trim();
            }
          }
          if (userName && !names.includes(userName)) {
            names.push(userName);
          }
        }
      }
    } catch (e) {
      console.error('[UserProfileReaderWriter] 获取所有人设卡姓名失败:', e);
    }
    return names;
  }

  /**
   * 将传入文本中包含的指定用户名，正则收缩替换为 {{user}} 占位符
   */
  public static replaceUserNameToPlaceholder(content: string, userName: string | null): string {
    if (!content || !userName || userName.trim() === '') return content;
    const cleanName = userName.trim();
    // 漏洞防护：限制名字必须大于等于 2 个字，防范极短的常用单字（如“我”、“李”）在文中发生大面积误杀
    if (cleanName.length < 2) return content;
    const userNameRegex = new RegExp(cleanName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
    return content.replace(userNameRegex, '{{user}}');
  }

  public static setGetUserNameCallback(cb: (folderName: string) => string | null): void {
    this.getUserNameCallback = cb;
  }

  public static getUserNameByFolder(folderName: string): string | null {
    return this.getUserName(folderName);
  }

  private static getUserName(folderName: string): string | null {
    if (this.getUserNameCallback) {
      try {
        return this.getUserNameCallback(folderName);
      } catch (e) {
        console.error('[UserProfileReaderWriter] 获取用户姓名回调失败:', e);
      }
    }
    return null;
  }

  private static readonly DEFAULT_GLOBAL: GlobalUserProfile = {
    name: '',
    age: '',
    occupation: '',
    gender: '其他',
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
      gender: '其他',
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
      if (profile.gender !== undefined && profile.gender !== null) {
        profile.gender = String(profile.gender);
      } else {
        // 双重容错：从自然语言 Markdown 正则还原
        const genderMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?性别(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/);
        if (genderMatch && genderMatch[1]) {
          profile.gender = genderMatch[1].trim();
        }
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

    const jsonData = {
      name: profile.name,
      age: profile.age,
      occupation: profile.occupation,
      gender: profile.gender || '其他',
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
      replaceOrAppend('性别', profile.gender || '其他');
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
    if (profile.gender && profile.gender.trim() !== '') {
      lines.push(`- **性别**：${profile.gender.trim()}`);
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
      
      // 1. 优先尝试解析 HTML 注释中的 JSON 块
      const match = content.match(/<!--([\s\S]*?)-->/);
      if (match && match[1]) {
        try {
          const data = JSON.parse(match[1].trim()) as CharacterUserProfile;
          if (data && Array.isArray(data.character_specific_facts)) {
            return data.character_specific_facts;
          }
        } catch (je) {
          console.warn(`[UserProfileReaderWriter] JSON 注释解析失败，将降级尝试 Markdown 解析:`, je);
        }
      }

      // 2. 物理降级防线：如果 JSON 解析失败或注释损坏，从底部的 Markdown 自然语言列表中正则匹配捕获并还原 Facts
      const facts: string[] = [];
      const lines = content.split('\n');
      let startCapture = false;
      for (const line of lines) {
        const cleanLine = line.trim();
        if (cleanLine.includes('## 专属画像事实 (Facts)') || cleanLine.includes('## 专属画像事实')) {
          startCapture = true;
          continue;
        }
        if (startCapture && cleanLine.startsWith('#')) {
          // 到了下一个大标题，结束捕获
          break;
        }
        if (startCapture && cleanLine.startsWith('-')) {
          const fact = cleanLine.substring(1).trim();
          if (fact && !fact.includes('暂无角色专属侧写事实') && !fact.includes('暂无')) {
            facts.push(fact);
          }
        }
      }
      return facts;
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

    const folderName = path.basename(dir);
    // 使用回调获取数据库里的 userName，避免打包后 require('../db/database') MODULE_NOT_FOUND 报错
    const userName = this.getUserName(folderName);

    let processedFacts = [...facts];
    if (userName) {
      const userNameRegex = new RegExp(userName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
      processedFacts = facts.map(fact => fact.replace(userNameRegex, '{{user}}'));
    }

    const jsonData: CharacterUserProfile = { character_specific_facts: processedFacts };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;

    let markdown = `${jsonComment}\n\n# 角色专属用户侧写\n\n`;
    markdown += `> 本侧写由该 AI 角色在与您的互动交往中，自发通过做梦反思总结提炼生成，展现千人千面的默契。\n\n`;
    markdown += `## 专属画像事实 (Facts)\n`;
    
    if (processedFacts.length === 0) {
      markdown += `*暂无角色专属侧写事实*\n`;
    } else {
      processedFacts.forEach((fact) => {
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
