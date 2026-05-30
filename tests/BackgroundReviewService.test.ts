import { describe, test, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { BackgroundReviewService } from '../src/main/services/BackgroundReviewService';
import { ModelAdapter } from '../src/main/models/ModelAdapter';
import { CharacterStorageManager } from '../src/main/utils/CharacterStorageManager';

describe('BackgroundReviewService 后台睡眠做梦进化反思服务测试', () => {

  test('挫败信号捕获与物理 SKILL.md/Soul.md 偏好 Patch 局部追加测试', async () => {
    // 1. 在本地 Echo-UserData-Test/characters 下创建测试角色
    const storageManager = new CharacterStorageManager();
    const testFolderName = 'test_yeningning';
    
    // 使用 saveCharacter 初始化角色及其技能包 play-music
    storageManager.saveCharacter(
      testFolderName,
      Buffer.from([]),
      '# 性格人设\n杨宁宁是一个温柔的人。',
      '# 世界设定\n回音平台开发背景。'
    );

    const soulPath = path.join(storageManager.getBaseDir(), testFolderName, 'Soul.md');
    const dreamPath = path.join(storageManager.getBaseDir(), testFolderName, 'DREAM.md');

    // 2. 模拟大模型适配器，直接返回带有挫败信号纠偏的反思 JSON 结果
    const mockModelAdapter = {
      chat: vi.fn().mockResolvedValue({
        content: `
          {
            "behavior_patches": [
              {
                "category": "play-music",
                "patch_content": "深夜禁止推荐摇滚乐，优先推荐舒缓钢琴曲。"
              }
            ]
          }
        `
      })
    } as unknown as ModelAdapter;

    // 3. 模拟最近 3 轮对话历史，其中包含用户的挫败纠错抱怨
    const mockTurns = [
      { role: 'user', content: '点个摇滚乐听听。' },
      { role: 'assistant', content: '好的！正在为您播放超吵的摇滚乐！' },
      { role: 'user', content: '别在深夜给我放这种吵闹的歌，脑壳都要炸了！' }
    ];

    const reviewService = new BackgroundReviewService();
    
    // 4. 执行反思进化 Patch 物理写盘
    await reviewService.reviewAndPatch(
      testFolderName,
      'test_char_id',
      mockTurns,
      mockModelAdapter
    );

    // 5. 验证物理文件是否已成功局部 Patch 追加补丁
    const patchedSoul = fs.readFileSync(soulPath, 'utf8');
    const patchedDream = fs.readFileSync(dreamPath, 'utf8');

    // 验证 Soul.md 未被修改（梦境自省不应当修改 Soul.md）
    expect(patchedSoul).toContain('杨宁宁是一个温柔的人。');
    expect(patchedSoul).not.toContain('* 修正偏好补丁：');

    // 验证 DREAM.md 避坑补丁追加成功
    expect(patchedDream).toContain('避坑补丁（play-music）：深夜禁止推荐摇滚乐，优先推荐舒缓钢琴曲。');

    // 6. 清理物理测试生成文件夹
    try {
      fs.unlinkSync(path.join(storageManager.getBaseDir(), testFolderName, 'avatar.png'));
      fs.unlinkSync(soulPath);
      fs.unlinkSync(dreamPath);
      fs.unlinkSync(path.join(storageManager.getBaseDir(), testFolderName, 'World.md'));
      fs.unlinkSync(path.join(storageManager.getBaseDir(), testFolderName, 'Memory.md'));
      fs.unlinkSync(path.join(storageManager.getBaseDir(), testFolderName, 'Diary.md'));
      fs.rmdirSync(path.join(storageManager.getBaseDir(), testFolderName, 'assets'));
      fs.rmdirSync(path.join(storageManager.getBaseDir(), testFolderName));
    } catch (_) {}
  });
});
