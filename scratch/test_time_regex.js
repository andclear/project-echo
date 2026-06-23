const regex = /[\[［(（]\s*(?:发送时间|Send Time)\s*[:：]?\s*[^\])）]+[\]］)）]\s*\n?/gi;

const testCases = [
  "[发送时间: 2026/6/9 22:53:30]\n手机屏幕亮起来的时候，凌月正在改期末论文。",
  "[发送时间：2026-06-09 22:53:30] 手机屏幕亮起来的时候，凌月正在改期末论文。",
  "［发送时间：2026/6/9 22:53:30］\n手机屏幕亮起来的时候",
  "(发送时间: 2026/6/9 22:53:30)手机屏幕",
  "（发送时间: 2026/6/9 22:53:30） 手机屏幕",
  "[Send Time: 2026/6/9]手机",
  "[发送时间 2026/6/9 22:53:30]手机"
];

testCases.forEach((tc, idx) => {
  const cleaned = tc.replace(regex, '');
  console.log(`Test ${idx + 1}:`);
  console.log(`  Original: ${JSON.stringify(tc)}`);
  console.log(`  Cleaned:  ${JSON.stringify(cleaned)}`);
});
