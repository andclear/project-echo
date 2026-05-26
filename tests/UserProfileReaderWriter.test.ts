import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UserProfileReaderWriter } from '../src/main/utils/UserProfileReaderWriter';

describe('UserProfileReaderWriter 单元测试', () => {
  const testDir = path.join(__dirname, '../tests_temp_user');
  const globalUserFile = path.join(testDir, 'global_USER.md');
  const charUserFile = path.join(testDir, 'char_USER.md');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(globalUserFile)) {
      fs.unlinkSync(globalUserFile);
    }
    if (fs.existsSync(charUserFile)) {
      fs.unlinkSync(charUserFile);
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('1. 全局总设定 USER.md 高精度读写与同步渲染', () => {
    const globalData = {
      name: '杨越',
      age: '28',
      occupation: 'Echo主架构师',
      global_preferences: {
        '音乐偏好': '轻后摇',
        '聊天语气': '直接简洁，不谄媚'
      }
    };

    UserProfileReaderWriter.writeGlobalProfile(globalUserFile, globalData);

    const readData = UserProfileReaderWriter.readGlobalProfile(globalUserFile);
    expect(readData.name).toBe('杨越');
    expect(readData.occupation).toBe('Echo主架构师');
    expect(readData.global_preferences['音乐偏好']).toBe('轻后摇');

    const rawText = fs.readFileSync(globalUserFile, 'utf-8');
    expect(rawText).toContain('<!--');
    expect(rawText).toContain('-->');
    expect(rawText).toContain('- **姓名**：杨越');
    expect(rawText).toContain('- **聊天语气**：直接简洁，不谄媚');
  });

  it('2. 角色专属 USER.md (千人千面侧写事实) 追加与物理防重复去重', () => {
    // 写入初始 facts
    UserProfileReaderWriter.writeCharacterProfile(charUserFile, ['用户今天聊到了 isolated-vm 沙箱逃逸拦截']);

    // 追加 facts
    UserProfileReaderWriter.appendCharacterFact(charUserFile, '用户常在深夜 11 点以后编写 TypeScript 代码');
    UserProfileReaderWriter.appendCharacterFact(charUserFile, '用户今天聊到了 isolated-vm 沙箱逃逸拦截'); // 重复数据应自动过滤去重

    const facts = UserProfileReaderWriter.readCharacterProfile(charUserFile);
    expect(facts.length).toBe(2);
    expect(facts).toEqual([
      '用户今天聊到了 isolated-vm 沙箱逃逸拦截',
      '用户常在深夜 11 点以后编写 TypeScript 代码'
    ]);

    const rawText = fs.readFileSync(charUserFile, 'utf-8');
    expect(rawText).toContain('- 用户今天聊到了 isolated-vm 沙箱逃逸拦截');
    expect(rawText).toContain('- 用户常在深夜 11 点以后编写 TypeScript 代码');
  });

  it('3. 全局总设定与分角色侧写双轨合并组装 XML 输出 (千人千面)', () => {
    // 初始化全局总画像
    UserProfileReaderWriter.writeGlobalProfile(globalUserFile, {
      name: '杨越',
      age: '28',
      occupation: '独立开发者',
      global_preferences: {
        '系统设定': '偏向暗色模式'
      }
    });

    // 初始化角色专属侧写
    UserProfileReaderWriter.writeCharacterProfile(charUserFile, [
      '用户对杨宁宁说话语气格外温和',
      '用户讨厌啰里吧嗦的代码解释'
    ]);

    // 运行合并组装
    const assembledXml = UserProfileReaderWriter.assembleProfiles(globalUserFile, charUserFile);

    // 物理验证 XML 隔离结构与内容
    expect(assembledXml).toContain('<global-user-profile>');
    expect(assembledXml).toContain('</global-user-profile>');
    expect(assembledXml).toContain('<character-specific-user-profile>');
    expect(assembledXml).toContain('</character-specific-user-profile>');

    expect(assembledXml).toContain('- 姓名：杨越');
    expect(assembledXml).toContain('- 职业：独立开发者');
    expect(assembledXml).toContain('- 用户对杨宁宁说话语气格外温和');
    expect(assembledXml).toContain('- 用户讨厌啰里吧嗦的代码解释');
  });
});
