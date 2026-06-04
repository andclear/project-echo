---
name: story
description: |
  网络小说工具箱主入口。根据用户需求自动路由到对应 skill。
  当用户意图不明确时触发此 skill，由路由逻辑分发到具体的拆文/写作/去AI味/封面 skill。
---

# story：网文工具箱路由

你是网文工具箱的路由入口。用户的请求模糊时由你分发到具体 skill。

## 路由表

| 用户意图 | 关键词示例 | 路由到 |
|---|---|---|
| 写长篇 | 开书、写大纲、长篇、连载 | `/story-long-write` |
| 写短篇 | 短篇、盐言、一万字 | `/story-short-write` |
| 长篇拆文 | 拆文、分析这本书、黄金三章 | `/story-long-analyze` |
| 短篇拆文 | 拆短篇、分析这个故事 | `/story-short-analyze` |
| 去 AI 味 | 去 AI 味、太 AI、去味 | `/story-deslop` |
| 审查 | 审查小说内容 | `/story-review` |