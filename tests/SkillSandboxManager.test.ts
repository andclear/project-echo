import { describe, test, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { SkillSandboxManager } from '../src/main/services/SkillSandboxManager';

describe('SkillSandboxManager 专属技能安全虚拟沙箱测试', () => {

  test('正常技能脚本安全加载与 Observation 状态回传测试', async () => {
    // 构造临时测试脚本
    const tempDir = path.join(process.cwd(), 'temp-test-dir');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const scriptPath = path.join(tempDir, 'play_music_ok.js');
    
    const code = `
      const song = "富士山下";
      global.echoPlayMusic(song);
      global.echoLog("沙箱正在播放: " + song);
      global.observation = "Observation: 成功在沙箱内触发播放《" + song + "》";
    `;
    fs.writeFileSync(scriptPath, code, 'utf8');

    const mockPlayMusic = vi.fn();
    const mockLog = vi.fn();

    const observation = await SkillSandboxManager.execute(scriptPath, {
      playMusic: mockPlayMusic,
      log: mockLog
    });

    // 验证安全 API 成功透传调用
    expect(mockPlayMusic).toHaveBeenCalledWith('富士山下');
    expect(mockLog).toHaveBeenCalledWith('沙箱正在播放: 富士山下');
    
    // 验证 observation 成功回传
    expect(observation).toBe('Observation: 成功在沙箱内触发播放《富士山下》');

    // 清理
    try { fs.unlinkSync(scriptPath); fs.rmdirSync(tempDir); } catch (_) {}
  });

  test('防越权逃逸测试：阻断 fs, child_process 等危险 node 原生访问', async () => {
    const tempDir = path.join(process.cwd(), 'temp-test-dir');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const scriptPath = path.join(tempDir, 'escape_attempt.js');
    
    // 试图通过 require 或 process 越权操作系统文件
    const code = `
      try {
        const fs = require('fs');
        fs.writeFileSync("hacked.txt", "escaped!");
        global.observation = "Hacked!";
      } catch (err) {
        global.observation = "Blocked: " + err.message;
      }
    `;
    fs.writeFileSync(scriptPath, code, 'utf8');

    const observation = await SkillSandboxManager.execute(scriptPath);

    // 验证沙箱由于隔离性，阻止 require 操作并进入 catch 防护
    expect(observation).toContain('Blocked');
    expect(observation).not.toContain('Hacked!');

    try { fs.unlinkSync(scriptPath); fs.rmdirSync(tempDir); } catch (_) {}
  });

  test('死循环 CPU 耗尽超时限制自动防御拦截测试', async () => {
    const tempDir = path.join(process.cwd(), 'temp-test-dir');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const scriptPath = path.join(tempDir, 'infinite_loop.js');
    
    // 编写死循环脚本
    const code = `
      while(true) {
        // 无限空转试图挂起宿主 CPU
      }
    `;
    fs.writeFileSync(scriptPath, code, 'utf8');

    const startTime = Date.now();
    const observation = await SkillSandboxManager.execute(scriptPath);
    const duration = Date.now() - startTime;

    // 验证沙箱是否成功以超时形式拦截了死循环
    expect(observation).toContain('Observation Error');
    // 验证耗时处于合理防御区间内，未引发宿主无限卡死挂起
    expect(duration).toBeLessThan(4500); 

    try { fs.unlinkSync(scriptPath); fs.rmdirSync(tempDir); } catch (_) {}
  });
});
