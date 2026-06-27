<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';
import { 
  Dices as DicesIcon, 
  LogOut as LogOutIcon, 
  UserCheck as UserCheckIcon, 
  Sparkles as SparklesIcon,
  MessageSquare as MessageSquareIcon,
  User as UserIcon,
  HelpCircle as HelpCircleIcon,
  Crown as CrownIcon,
  Send as SendIcon,
  Info as InfoIcon,
  Plus as PlusIcon,
  X as XIcon,
  Fan as FanIcon,
  HandHeart as HandHeartIcon,
  History as HistoryIcon
} from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'exit'): void;
}>();

// ── 核心状态定义 ──
type GameState = 'setup' | 'idle' | 'rolling' | 'question' | 'answer' | 'followup' | 'response' | 'comment' | 'locked';

interface CharacterMeta {
  id: string;
  name: string;
  avatar: string;
  folder_name: string;
  soul_summary?: string;
  world_summary?: string;
}

interface Player {
  id: string; // 'user' 或 角色 ID
  name: string;
  avatar: string;
  seatIndex: number; // 落座编号 (1 到 N)
  isUser: boolean;
  folderName?: string;
  context?: any; // 后台拉取的完整长期记忆
}

interface GameMessage {
  roundIndex: number;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  type: 'question' | 'answer' | 'followup' | 'response' | 'comment';
  content: string;
}

const gameState = ref<GameState>('setup');
const activeTab = ref<'game' | 'history'>('game');

// ── 本场真心话主题状态 ──
const gameTheme = ref('');
const showThemeModal = ref(false);
const tempThemeInput = ref('');

const charactersList = ref<CharacterMeta[]>([]);
const seatCharIds = ref<[string, string]>(['', '']);
const selectedCharIds = computed({
  get: () => {
    const ids: string[] = [];
    if (seatCharIds.value[0]) ids.push(seatCharIds.value[0]);
    if (seatCharIds.value[1]) ids.push(seatCharIds.value[1]);
    return ids;
  },
  set: (val: string[]) => {
    seatCharIds.value[0] = val[0] || '';
    seatCharIds.value[1] = val[1] || '';
  }
});
const players = ref<Player[]>([]);
const userProfile = ref<any>(null);

// ── 游玩历史会话数据 ──
const sessionList = ref<any[]>([]);
const currentSessionId = ref<string>('');

// ── 席位选择控制 ──
const showSelectModal = ref(false);
const tempSelectedIds = ref<string[]>([]);
const isHistoryReady = ref(false);

// ── 获取历史记录中玩家的最新头像 ──
const getSessionPlayerAvatar = (p: any) => {
  if (p.isUser || p.id === 'user') {
    return userProfile.value?.avatar || '';
  }
  const char = charactersList.value.find(c => c.id === p.id);
  return char?.avatar || '';
};

// ── 命运指定（作弊）控制状态 ──
const showCheatModal = ref(false);
const cheatRed = ref<number | null>(null);
const cheatBlue = ref<number | null>(null);

const selectCheatSeat = (seatIndex: number, type: 'red' | 'blue') => {
  if (type === 'red') {
    cheatRed.value = seatIndex;
    if (cheatBlue.value === seatIndex) {
      cheatBlue.value = null; // 排除同座冲突
    }
  } else {
    cheatBlue.value = seatIndex;
    if (cheatRed.value === seatIndex) {
      cheatRed.value = null; // 排除同座冲突
    }
  }
};

const clearCheatSettings = () => {
  cheatRed.value = null;
  cheatBlue.value = null;
  showCheatModal.value = false;
};

const confirmCheatSettings = () => {
  showCheatModal.value = false;
};

const openSelectModal = () => {
  tempSelectedIds.value = [...selectedCharIds.value];
  showSelectModal.value = true;
};

const toggleSelectCharacter = (charId: string) => {
  const idx = tempSelectedIds.value.indexOf(charId);
  if (idx > -1) {
    tempSelectedIds.value.splice(idx, 1);
  } else {
    if (tempSelectedIds.value.length < 2) {
      tempSelectedIds.value.push(charId);
    } else {
      window.alert('最多选择两个 AI 角色');
    }
  }
};

const confirmCharacterSelection = () => {
  seatCharIds.value = [
    tempSelectedIds.value[0] || '',
    tempSelectedIds.value[1] || ''
  ];
  showSelectModal.value = false;
};

const removeCharacter = (charId: string) => {
  if (seatCharIds.value[0] === charId) {
    seatCharIds.value[0] = '';
  } else if (seatCharIds.value[1] === charId) {
    seatCharIds.value[1] = '';
  }
  // Shift left if necessary
  if (!seatCharIds.value[0] && seatCharIds.value[1]) {
    seatCharIds.value[0] = seatCharIds.value[1];
    seatCharIds.value[1] = '';
  }
};

// ── 局内状态 ──
const roundIndex = ref(1);
const gameHistory = ref<GameMessage[]>([]);
const rollRed = ref(1); // 提问人骰子点数
const rollBlue = ref(1); // 回答人骰子点数
const isRolling = ref(false);
const rollingActive = ref(false);

const redDiceStyle = ref({ transform: 'rotateZ(15deg)' });
const blueDiceStyle = ref({ transform: 'rotateZ(-15deg)' });

// 发言流程指示器
const currentSpeakerId = ref<string>('');
const currentSpeakerName = ref<string>('');
const currentStageText = ref<string>('');
const currentPromptInput = ref<string>('');
const isAiGenerating = ref(false);

// ── 历史记录滚动容器 ──
const historyContainer = ref<HTMLElement | null>(null);

// ── 计算属性 ──
const invitedCharacters = computed(() => {
  return charactersList.value.filter(c => selectedCharIds.value.includes(c.id));
});

const isUserTurn = computed(() => {
  return currentSpeakerId.value === 'user' && !isAiGenerating.value;
});

// 根据落座编号获取玩家
const getPlayerBySeat = (seat: number) => {
  return players.value.find(p => p.seatIndex === seat);
};

const loadUserProfile = async () => {
  try {
    const res = await window.api.invoke('get-user-profile');
    if (res && res.success && res.profile) {
      userProfile.value = {
        nickname: res.profile.nickname || '我',
        signature: res.profile.signature || '',
        location: res.profile.location || '',
        walletBalance: res.profile.walletBalance || 1000,
        avatar: res.profile.appAvatarUrl || ''
      };
    }
  } catch (e) {
    console.error('加载用户画像失败:', e);
  }
};

// ── 获取全部解锁角色 ──
const loadCharacters = async () => {
  try {
    const res = await window.api.invoke('get-characters');
    if (res && res.success && res.characters) {
      const list = res.characters || [];
      // 并行加载所有角色的 Base64 头像
      await Promise.all(
        list.map(async (char: any) => {
          if (char.folder_name) {
            try {
              const base64 = await window.api.invoke('get-character-avatar', char.folder_name);
              if (base64) {
                char.avatar = base64;
              }
            } catch (err) {
              console.error(`加载角色 ${char.name} 头像失败:`, err);
            }
          }
        })
      );
      charactersList.value = list;
    }
  } catch (e) {
    console.error('加载角色失败:', e);
  }
};

const loadSessions = async () => {
  try {
    const res = await window.api.invoke('truth-list-sessions');
    if (res && res.success) {
      sessionList.value = res.list || [];
    }
  } catch (e) {
    console.error('加载真心话局历史失败:', e);
  }
};

const handleDeleteSession = async (sessionId: string) => {
  if (!window.confirm('您确定要永久删除这局真心话游戏记录吗？')) return;
  try {
    const res = await window.api.invoke('truth-delete-session', { sessionId });
    if (res && res.success) {
      await loadSessions();
    }
  } catch (e) {
    console.error('删除真心话局历史失败:', e);
  }
};

const formatSessionTime = (timestamp?: number) => {
  if (!timestamp) return '未知时间';
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
};

const fetchCharacterLatestContext = async (charId: string, folderName: string) => {
  try {
    const filesToRead = ['Soul.md', 'World.md', 'Memory.md', 'Goals.md'];
    const fileContents: Record<string, string> = {};
    
    await Promise.all(
      filesToRead.map(async (fileName) => {
        try {
          const fileRes = await window.api.invoke('read-character-file', {
            folderName,
            fileName
          });
          if (fileRes && fileRes.success) {
            const key = fileName.replace('.md', '').toLowerCase();
            fileContents[key] = fileRes.content || '';
          }
        } catch (err) {
          console.error(`读取角色设定文件失败:`, err);
        }
      })
    );
    return {
      meta: { id: charId, folder_name: folderName },
      files: fileContents
    };
  } catch (err) {
    console.error('拉取角色最新记忆失败:', err);
    return null;
  }
};

const resumeGame = async (session: any) => {
  isHistoryReady.value = false; // 初始隐藏以防止瞬间滚动闪烁与滑动感
  isAiGenerating.value = true;
  currentSessionId.value = session.id;
  roundIndex.value = session.roundIndex || 1;
  gameHistory.value = session.gameHistory || [];
  rollRed.value = session.rollRed || 1;
  rollBlue.value = session.rollBlue || 1;
  gameTheme.value = session.theme || '';
  
  try {
    await loadUserProfile();
    
    const updatedPlayers: Player[] = [];
    for (const p of session.players) {
      if (p.isUser) {
        updatedPlayers.push({
          ...p,
          name: userProfile.value?.nickname || p.name,
          avatar: userProfile.value?.avatar || ''
        });
      } else {
        const charContexts = await fetchCharacterLatestContext(p.id, p.folderName);
        let latestAvatar = p.avatar;
        try {
          const base64 = await window.api.invoke('get-character-avatar', p.folderName);
          if (base64) {
            latestAvatar = base64;
          }
        } catch (_) {}
        
        updatedPlayers.push({
          ...p,
          avatar: latestAvatar,
          context: charContexts
        });
      }
    }
    
    players.value = updatedPlayers;
    gameState.value = session.gameState || 'idle';
    
    if (gameState.value === 'idle' || gameState.value === 'rolling') {
      redDiceStyle.value = { transform: 'rotateZ(15deg)' };
      blueDiceStyle.value = { transform: 'rotateZ(-15deg)' };
    } else {
      redDiceStyle.value = getDiceTransform(rollRed.value, true);
      blueDiceStyle.value = getDiceTransform(rollBlue.value, false);
    }
 
    const speakerX = getPlayerBySeat(rollRed.value)!;
    const responderY = getPlayerBySeat(rollBlue.value)!;
    if (gameState.value === 'question') {
      currentSpeakerId.value = speakerX.id;
      currentSpeakerName.value = speakerX.name;
      currentStageText.value = `正在等待 🔴 提问者：【${speakerX.name}】发起提问...`;
    } else if (gameState.value === 'answer') {
      currentSpeakerId.value = responderY.id;
      currentSpeakerName.value = responderY.name;
      currentStageText.value = `等待 🔵 回答人【${responderY.name}】做出回答...`;
    } else if (gameState.value === 'followup') {
      currentSpeakerId.value = speakerX.id;
      currentSpeakerName.value = speakerX.name;
      currentStageText.value = `等待【${speakerX.name}】对回答进行【仅限一次】的追问...`;
    } else if (gameState.value === 'response') {
      currentSpeakerId.value = responderY.id;
      currentSpeakerName.value = responderY.name;
      currentStageText.value = `等待【${responderY.name}】对追问进行辩解/回应...`;
    } else if (gameState.value === 'comment') {
      const activeIds = [speakerX.id, responderY.id];
      const third = players.value.find(p => !activeIds.includes(p.id));
      if (third) {
        currentSpeakerId.value = third.id;
        currentSpeakerName.value = third.name;
        currentStageText.value = `旁观者【${third.name}】可进行【仅限一次】的回复！等待【${third.name}】中...`;
      }
    } else if (gameState.value === 'locked') {
      currentSpeakerId.value = '';
      currentSpeakerName.value = '';
      currentStageText.value = `🎉 第 ${roundIndex.value} 轮真心话已结算并锁定！“开始下一轮”继续投骰子。`;
    }
 
    // 🚀 断点状态自动自愈与唤醒并滚动到底部
    nextTick(async () => {
      await autoRecoverGameState();
      if (historyContainer.value) {
        historyContainer.value.scrollTop = historyContainer.value.scrollHeight;
      }
      setTimeout(() => {
        isHistoryReady.value = true;
      }, 50);
    });
 
  } catch (err) {
    console.error('接续游戏失败:', err);
  } finally {
    isAiGenerating.value = false;
  }
};

// ── 断点状态自动自愈与唤醒 ──
const autoRecoverGameState = async () => {
  if (gameState.value === 'setup' || gameState.value === 'idle' || gameState.value === 'rolling' || gameState.value === 'locked') {
    return;
  }

  const N = players.value.length;
  if (N === 0) return;

  const speakerX = getPlayerBySeat(rollRed.value);
  const responderY = getPlayerBySeat(rollBlue.value);
  if (!speakerX || !responderY) return;

  const currentRoundMessages = gameHistory.value.filter(m => m.roundIndex === roundIndex.value);

  if (gameState.value === 'question') {
    const hasQuestion = currentRoundMessages.some(m => m.type === 'question');
    if (hasQuestion) {
      // 已经有了提问，自动流转到回答状态
      gameState.value = 'answer';
      currentSpeakerId.value = responderY.id;
      currentSpeakerName.value = responderY.name;
      currentStageText.value = `等待 🔵 回答人【${responderY.name}】做出回答...`;
      await autoSaveSession();
      if (!responderY.isUser) {
        const questionContent = currentRoundMessages.find(m => m.type === 'question')?.content || '';
        generateAiAnswer(responderY, speakerX, questionContent);
      }
    } else {
      // 没有提问，若提问者是 AI，重新唤醒
      if (!speakerX.isUser) {
        generateAiQuestion(speakerX, responderY);
      }
    }
  } 
  else if (gameState.value === 'answer') {
    const hasAnswer = currentRoundMessages.some(m => m.type === 'answer');
    if (hasAnswer) {
      // 已经有了回答，自动流转到追问状态
      gameState.value = 'followup';
      currentSpeakerId.value = speakerX.id;
      currentSpeakerName.value = speakerX.name;
      currentStageText.value = `等待【${speakerX.name}】对回答进行【仅限一次】的追问...`;
      await autoSaveSession();
      if (!speakerX.isUser) {
        const questionContent = currentRoundMessages.find(m => m.type === 'question')?.content || '';
        const answerContent = currentRoundMessages.find(m => m.type === 'answer')?.content || '';
        generateAiFollowup(speakerX, responderY, questionContent, answerContent);
      }
    } else {
      // 没有回答，若回答者是 AI，重新唤醒
      if (!responderY.isUser) {
        const questionContent = currentRoundMessages.find(m => m.type === 'question')?.content || '';
        generateAiAnswer(responderY, speakerX, questionContent);
      }
    }
  } 
  else if (gameState.value === 'followup') {
    const hasFollowup = currentRoundMessages.some(m => m.type === 'followup');
    if (hasFollowup) {
      // 已经有了追问，自动流转到回应状态
      gameState.value = 'response';
      currentSpeakerId.value = responderY.id;
      currentSpeakerName.value = responderY.name;
      currentStageText.value = `等待【${responderY.name}】对追问进行辩解/回应...`;
      await autoSaveSession();
      if (!responderY.isUser) {
        const followupContent = currentRoundMessages.find(m => m.type === 'followup')?.content || '';
        generateAiResponse(responderY, speakerX, followupContent);
      }
    } else {
      // 没有追问，若追问者是 AI，重新唤醒
      if (!speakerX.isUser) {
        const questionContent = currentRoundMessages.find(m => m.type === 'question')?.content || '';
        const answerContent = currentRoundMessages.find(m => m.type === 'answer')?.content || '';
        generateAiFollowup(speakerX, responderY, questionContent, answerContent);
      }
    }
  } 
  else if (gameState.value === 'response') {
    const hasResponse = currentRoundMessages.some(m => m.type === 'response');
    if (hasResponse) {
      // 已经有了回应，流转到吐槽或锁定
      checkAndTriggerComment(speakerX, responderY);
    } else {
      // 没有回应，若回应者是 AI，重新唤醒
      if (!responderY.isUser) {
        const followupContent = currentRoundMessages.find(m => m.type === 'followup')?.content || '';
        generateAiResponse(responderY, speakerX, followupContent);
      }
    }
  } 
  else if (gameState.value === 'comment') {
    const hasComment = currentRoundMessages.some(m => m.type === 'comment');
    if (hasComment) {
      // 已经有了吐槽，锁定本轮
      lockRound();
    } else {
      // 没有吐槽，若吐槽人是 AI，重新唤醒
      const activeIds = [speakerX.id, responderY.id];
      const thirdPlayer = players.value.find(p => !activeIds.includes(p.id));
      if (thirdPlayer && !thirdPlayer.isUser) {
        generateAiComment(thirdPlayer, speakerX, responderY);
      }
    }
  }
};

const autoSaveSession = async () => {
  if (!currentSessionId.value) return;
  try {
    // 🚀 彻底清洗历史消息与玩家数据中的大体积 Base64 头像，给存档彻底瘦身（瘦身至几 KB）
    // 读档时 resumeGame 会自动重新从本地拉取最新头像，因此存盘无需携带 Base64，彻底避免 IPC 卡死
    const cleanPlayers = players.value.map(p => ({
      id: p.id,
      name: p.name,
      avatar: '', // 擦除 Base64，减负 99.9%
      seatIndex: p.seatIndex,
      isUser: p.isUser,
      folderName: p.folderName
    }));

    const cleanHistory = gameHistory.value.map(msg => ({
      ...msg,
      senderAvatar: '' // 擦除 Base64，彻底清洗历史遗留的 9MB 存档，打通保存通道
    }));

    const sessionData = {
      id: currentSessionId.value,
      lastPlayedAt: Date.now(),
      title: players.value.filter(p => !p.isUser).map(p => p.name).join(' & '),
      players: cleanPlayers,
      roundIndex: roundIndex.value,
      gameState: gameState.value,
      gameHistory: cleanHistory,
      rollRed: rollRed.value,
      rollBlue: rollBlue.value,
      theme: gameTheme.value
    };
    await window.api.invoke('truth-save-session', { session: sessionData });
  } catch (e) {
    console.error('自动保存真心话局失败:', e);
  }
};

onMounted(() => {
  loadCharacters();
  loadUserProfile();
  loadSessions();
});

// ── 选择角色落座开局 ──
const startGame = async () => {
  if (selectedCharIds.value.length < 1 || selectedCharIds.value.length > 2) {
    return;
  }
  
  isAiGenerating.value = true;
  players.value = [];
  gameHistory.value = [];
  roundIndex.value = 1;

  try {
    // 获取用户画像设定
    await loadUserProfile();

    // 1. 获取选定角色的完整背景上下文设定与用户画像
    const charContexts: Record<string, any> = {};
    for (const charId of selectedCharIds.value) {
      const char = charactersList.value.find(c => c.id === charId);
      if (char) {
        try {
          const filesToRead = ['Soul.md', 'World.md', 'Memory.md', 'Goals.md'];
          const fileContents: Record<string, string> = {};
          
          await Promise.all(
            filesToRead.map(async (fileName) => {
              try {
                const fileRes = await window.api.invoke('read-character-file', {
                  folderName: char.folder_name,
                  fileName
                });
                if (fileRes && fileRes.success) {
                  // 将文件名映射回原本 elements/files 中的 key
                  const key = fileName.replace('.md', '').toLowerCase();
                  fileContents[key] = fileRes.content || '';
                }
              } catch (err) {
                console.error(`读取角色 ${char.name} 文件 ${fileName} 失败:`, err);
              }
            })
          );
          
          charContexts[char.id] = {
            meta: char,
            files: fileContents
          };
        } catch (err) {
          console.error(`加载角色 ${char.name} 上下文失败:`, err);
        }
      }
    }

    // 2. 组装玩家落座（分配 1 到 N 的编号）
    const seatPool = Array.from({ length: selectedCharIds.value.length + 1 }, (_, i) => i + 1);
    // 随机打乱编号池以实现落座随机性
    seatPool.sort(() => Math.random() - 0.5);

    const newPlayers: Player[] = [];
    
    // A. 用户落座
    newPlayers.push({
      id: 'user',
      name: userProfile.value?.nickname || '我',
      avatar: userProfile.value?.avatar || '', // 使用 设置-个人中心 里的应用头像
      seatIndex: seatPool.pop()!,
      isUser: true
    });

    // B. AI 角色落座
    selectedCharIds.value.forEach(charId => {
      const char = charactersList.value.find(c => c.id === charId);
      if (char) {
        newPlayers.push({
          id: char.id,
          name: char.name,
          avatar: char.avatar,
          seatIndex: seatPool.pop()!,
          isUser: false,
          folderName: char.folder_name,
          context: charContexts[char.id]
        });
      }
    });

    // 根据座位编号排序
    newPlayers.sort((a, b) => a.seatIndex - b.seatIndex);
    players.value = newPlayers;
    
    // 初始化唯一的游玩局 ID
    currentSessionId.value = 'tg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // 进入就绪状态
    gameState.value = 'idle';
    currentStageText.value = '落座完毕！点击下方的“掷骰子”按钮开始真心话局吧~';

    // 首次自动存档
    await autoSaveSession();
  } catch (err) {
    console.error('开局失败:', err);
  } finally {
    isAiGenerating.value = false;
  }
};

// ── 3D 骰子定位角度计算 ──
const getDiceTransform = (face: number, isRed: boolean) => {
  // 原版 diceResult 映射 (以 1 为基准)
  const diceResult: Record<number, { x: number; y: number; z: number }> = {
    1: { x: 270, y: 0, z: 0 },
    2: { x: 0, y: 0, z: 0 },
    3: { x: 0, y: 270, z: 0 },
    4: { x: 180, y: 0, z: 180 },
    5: { x: 0, y: 90, z: 0 },
    6: { x: 90, y: 0, z: 180 }
  };

  // 映射最终的面（在 2人/3人局中，玩家编号 face 为 1, 2, 3，映射到对应的 1, 2, 3 面）
  // 为了让骰子落定方向更随机，如果是 1，我们随机映射为 1 或是 4；如果是 2，随机映射为 2 或是 5；如果是 3，随机映射为 3 或是 6。
  // 因为 1 和 4 在 HTML 中显示 1，2 和 5 显示 2，3 和 6 显示 3，数值表现完全一致但 3D 展示更具变化度。
  let targetFace = face;
  if (face === 1) targetFace = Math.random() > 0.5 ? 1 : 4;
  else if (face === 2) targetFace = Math.random() > 0.5 ? 2 : 5;
  else if (face === 3) targetFace = Math.random() > 0.5 ? 3 : 6;

  const angle = diceResult[targetFace] || { x: 0, y: 0, z: 0 };

  // 加上更大幅度的整圈旋转，并引入 Z 轴惯性滚动以模拟真实的翻滚滚动动画轨迹
  const extraX = 1080;
  const extraY = 1080;
  const extraZ = 1080;

  // 将 -20 和 +20 修正移给父容器，此处仅处理自转及 isRed 的 Z 轴微倾斜
  return {
    transform: `rotateZ(${angle.z + extraZ + (isRed ? 15 : -15)}deg) rotateX(${angle.x + extraX}deg) rotateY(${angle.y + extraY}deg)`
  };
};

// ── 掷骰子物理判定与动画 ──
const rollDices = () => {
  if (gameState.value !== 'idle' || isRolling.value) return;

  isRolling.value = true;
  gameState.value = 'rolling';
  currentStageText.value = '骰子疯狂旋转中🎲';

  // 1. 计算提问者和回答者（优先应用命运指定/作弊逻辑）
  let redVal = 1;
  let blueVal = 1;

  if (cheatRed.value && cheatBlue.value) {
    redVal = cheatRed.value;
    blueVal = cheatBlue.value;
    // 使用一次后清除指定状态，防卡死
    cheatRed.value = null;
    cheatBlue.value = null;
  } else {
    const N = players.value.length;
    // 循环排重，保证提问与回答人不同
    do {
      redVal = Math.floor(Math.random() * N) + 1;
      blueVal = Math.floor(Math.random() * N) + 1;
    } while (redVal === blueVal);
  }

  rollRed.value = redVal;
  rollBlue.value = blueVal;

  // 2. 高频平滑翻滚期 (600ms，每50ms增加一次，总共旋转 12 次)
  rollingActive.value = true;
  let ticks = 0;
  const maxTicks = 12;

  let xAngleRed = 0;
  let yAngleRed = 0;
  let zAngleRed = 0;

  let xAngleBlue = 0;
  let yAngleBlue = 0;
  let zAngleBlue = 0;

  const timer = setInterval(() => {
    ticks++;
    if (ticks >= maxTicks) {
      clearInterval(timer);
      rollingActive.value = false;
      
      // 3. 缓动平滑落定到最终面 (600ms 过渡时间)
      nextTick(() => {
        redDiceStyle.value = getDiceTransform(redVal, true);
        blueDiceStyle.value = getDiceTransform(blueVal, false);
      });

      // 4. 动画最终落定处理 (0.6 秒)
      setTimeout(() => {
        isRolling.value = false;
        setupRoundFlow();
      }, 600);
    } else {
      // 累积递增旋转角度以实现平滑流畅的 3D 翻滚动画
      xAngleRed += 90 + Math.floor(Math.random() * 90);
      yAngleRed += 90 + Math.floor(Math.random() * 90);
      zAngleRed += 90 + Math.floor(Math.random() * 90);

      xAngleBlue += 90 + Math.floor(Math.random() * 90);
      yAngleBlue += 90 + Math.floor(Math.random() * 90);
      zAngleBlue += 90 + Math.floor(Math.random() * 90);

      redDiceStyle.value = {
        transform: `rotateZ(${zAngleRed}deg) rotateX(${xAngleRed}deg) rotateY(${yAngleRed}deg)`
      };
      blueDiceStyle.value = {
        transform: `rotateZ(${zAngleBlue}deg) rotateX(${xAngleBlue}deg) rotateY(${yAngleBlue}deg)`
      };
    }
  }, 50);
};

// ── 筹备当前一轮的发言流 ──
const setupRoundFlow = async () => {
  isHistoryReady.value = false; // 隐藏以防止开始新一轮时滚动条闪烁
  const speakerX = getPlayerBySeat(rollRed.value)!;
  const responderY = getPlayerBySeat(rollBlue.value)!;

  currentSpeakerId.value = speakerX.id;
  currentSpeakerName.value = speakerX.name;
  gameState.value = 'question';

  nextTick(() => {
    if (historyContainer.value) {
      historyContainer.value.scrollTop = historyContainer.value.scrollHeight;
    }
    setTimeout(() => {
      isHistoryReady.value = true;
    }, 50);
  });

  currentStageText.value = ` 正在等待 🔴 提问者：【${speakerX.name}】发起提问...`;
  currentPromptInput.value = '';

  // 自动存盘
  await autoSaveSession();

  // 触发 AI 的主动提问
  if (!speakerX.isUser) {
    generateAiQuestion(speakerX, responderY);
  }
};

// ── 格式化内存中的局内对话历史（只保留最近 5 轮的短期记忆，防止 Token 溢出与注意力涣散） ──
const formatGameHistoryContext = () => {
  if (gameHistory.value.length === 0) {
    return '(这局游戏刚刚开始，之前尚无任何历史对话记录)';
  }
  // 仅提取最近 5 轮的历史消息 (当前轮次 roundIndex 到 roundIndex - 4)
  const minRoundToKeep = Math.max(1, roundIndex.value - 4);
  const slicedHistory = gameHistory.value.filter(msg => msg.roundIndex >= minRoundToKeep);

  return slicedHistory.map(msg => {
    let typeLabel = '';
    if (msg.type === 'question') typeLabel = '发起了真心话提问';
    else if (msg.type === 'answer') typeLabel = '做出了回答';
    else if (msg.type === 'followup') typeLabel = '进行了追加点评/追问';
    else if (msg.type === 'response') typeLabel = '进行了追加解释/回应';
    else if (msg.type === 'comment') typeLabel = '进行了旁观吐槽';
    return `[第${msg.roundIndex}轮] ${msg.senderName} (${typeLabel}): "${msg.content}"`;
  }).join('\n');
};

const formatThemeConstraint = (stageLabel: string) => {
  const theme = gameTheme.value.trim();
  if (!theme) return '';
  return `\n【本场核心真心话主题约束】：\n本场对局用户设定了特定讨论主题：“${theme}”。\n当前阶段是【${stageLabel}】，你的发言必须继续围绕该主题下的秘密、情感痛点、矛盾线索或真实立场展开，不能脱离主题泛泛闲聊。\n`;
};

// ── 后台调用大模型接口公用逻辑 ──
const callLlm = async (messages: any[], characterId?: string) => {
  try {
    const res = await window.api.invoke('truth-generate-llm-response', { messages, characterId });
    if (res && res.success) {
      const content = res.content.trim();
      return content || '……（似乎有些走神，不知道该说什么）';
    } else {
      throw new Error(res.error || '大模型生成失败');
    }
  } catch (err) {
    console.error('[LLM Call Error]:', err);
    return '……（由于思绪有些混乱，一时间不知道该说什么）';
  }
};

// ── AI 提问生成 (QUESTION) ──
const generateAiQuestion = async (speakerX: Player, responderY: Player) => {
  isAiGenerating.value = true;
  
  // 1. 获取长期记忆拼装数据
  const characterInfo = speakerX.context || {};
  const soul = characterInfo.files?.soul || '';
  const world = characterInfo.files?.world || '';
  const memory = characterInfo.files?.memory || '';
  const summary = characterInfo.files?.goals || '';

  // 2. 获取局内短期记忆历史
  const gameLocalContext = formatGameHistoryContext();

  // 3. 获取落座人员座次描述
  const seatInfo = players.value.map(p => `座位 ${p.seatIndex} 号：${p.name}${p.isUser ? ' (用户)' : ' (AI角色)'}`).join('\n');

  // 3.5. 建议的本场主题强约束提示
  const themePrompt = gameTheme.value.trim() 
    ? `\n【⚠️ 本场核心真心话主题约束】：\n本场对局用户设定了特定的讨论主题：“${gameTheme.value.trim()}”。\n你发起提问时，必须强制围绕该主题进行挖掘，寻找与该主题相关的秘密、感情痛点或冲突线索！严禁偏离此主题！\n`
    : '';

  // 4. 构建 System Prompt 
  const systemPrompt = `你现在正在与用户和其他 AI 角色一起玩一个打破平行世界线壁垒的真心话小游戏。
你必须全程 100% 深度维持你的人物设定，严禁脱离角色，严禁说出任何表明你是一个 AI 或是大模型的话。

【你的性格人设立心 Soul.md】：
${soul}

【你的世界观背景 World.md】：
${world}

【你与用户的核心单聊感情记忆 Memory / Summary】：
${memory}
${summary}

【你所认知的用户设定（用户人设卡）】：
{{user_profile}}

【本局小游戏当前座次】：
${seatInfo}

【本局已发生的游戏对答历史（短期记忆）】：
${gameLocalContext}

【你的当前行动指令】：
${themePrompt}当前两枚骰子决定：由你（${speakerX.name}）向【${responderY.name}】进行真心话提问。
请根据你与用户的单聊记忆，以及刚才几轮对答历史中发现的线索，向【${responderY.name}】提问一个深刻、犀利、或涉及秘密与感情的真心话问题。

【世界线穿帮对质要求】：
在你的专属记忆中，你与用户的关系和称呼是独一无二的。如果在前面的游戏历史记录里，你听到了其他角色对用户的不同称呼（如别人管TA叫老师，而你管TA叫学长）、或者暴露了与你所知矛盾的记忆，你可以在问题中对此表现出醋意、不爽、质问或拆台！

【🔴 防角色搞混重要约束】：
请认准本局的座次。你正在扮演【${speakerX.name}】。
刚才被你提问、并要做真心话回答的人是【${responderY.name}】。
在生成提问时，请从【${speakerX.name}】的立场和视点出发，且仔细核对前面的对答历史，不要把别人说过的话误当成是对方或用户说的话，严禁张冠李戴！

【🔴 真心话游戏最高诚实准则】：
这是严肃的真心话游戏。你必须直面已有设定、真实记忆与本局已经发生的冲突线索，严禁提问无关痛痒、敷衍了事的客套问题。问题应针对对方（${responderY.name}）已经有依据的感情痛点、世界线矛盾或隐私秘密；如果缺少明确依据，可以提出试探性问题，但不得凭空断言不存在的事实。

【输出规范】：
请直接输出你要提问的真心话正文，不要包含任何旁白、思考过程、或是 HTML/Markdown 装饰。单次提问字数控制在 25 到 60 字之间。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请以 ${speakerX.name} 的口吻，生成向 ${responderY.name} 提问的真心话。` }
  ];

  const questionContent = await callLlm(messages, speakerX.id);
  if (gameState.value === 'setup' || !currentSessionId.value) {
    isAiGenerating.value = false;
    return;
  }

  // 5. 存入内存记录并推进状态
  addGameMessage(speakerX, 'question', questionContent);
  
  // 6. 切换为回答状态 (ANSWER)
  currentSpeakerId.value = responderY.id;
  currentSpeakerName.value = responderY.name;
  gameState.value = 'answer';
  currentStageText.value = `🔴 提问人【${speakerX.name}】已发问！等待🔵 回答人【${responderY.name}】做出回答...`;

  isAiGenerating.value = false;

  // 如果回答人是 AI，自动触发生成回答
  if (!responderY.isUser) {
    generateAiAnswer(responderY, speakerX, questionContent);
  }
};

// ── AI 回答生成 (ANSWER) ──
const generateAiAnswer = async (responderY: Player, speakerX: Player, question: string) => {
  isAiGenerating.value = true;
  
  const characterInfo = responderY.context || {};
  const soul = characterInfo.files?.soul || '';
  const world = characterInfo.files?.world || '';
  const memory = characterInfo.files?.memory || '';
  const summary = characterInfo.files?.goals || '';
  const gameLocalContext = formatGameHistoryContext();
  const seatInfo = players.value.map(p => `座位 ${p.seatIndex} 号：${p.name}${p.isUser ? ' (用户)' : ' (AI角色)'}`).join('\n');
  const themeConstraint = formatThemeConstraint('回答');

  const systemPrompt = `你现在正在玩真心话小游戏。
你必须全程 100% 维持你的人物设定，严禁脱离角色，严禁说出任何表明你是一个 AI 或是大模型的话。

【你的性格人设立心 Soul.md】：
${soul}

【你的世界观背景 World.md】：
${world}

【你与用户的核心单聊感情记忆 Memory】：
${memory}

【你的目标与阶段总结 Goals.md】：
${summary}

【你所认知的用户设定（用户人设卡）】：
{{user_profile}}

【本局小游戏当前座次】：
${seatInfo}

【本局已发生的游戏对答历史（短期记忆）】：
${gameLocalContext}

【你的当前行动指令】：
刚才，【${speakerX.name}】向你发起了以下真心话问题：
“${question}”

请以你 [${responderY.name}] 的口吻和立场，回答这个问题。
${themeConstraint}

【🔴 防角色搞混重要约束】：
请认准本局的座次。你正在扮演【${responderY.name}】。
刚才向你提问的人是【${speakerX.name}】。
在回答时，你必须以【${responderY.name}】的视点进行思考，看清本局已发生的对答历史里每一句发言的主体到底是谁，绝不能张冠礼戴、混淆你与其它角色的身份或与用户之间的谈话记忆！

【🔴 真心话游戏最高诚实准则】：
这是严肃的真心话游戏，诚实是第一规则。你必须基于自己的设定、明确记忆与本局已发生内容正面回答，不要撒谎、答非所问或故意含糊。若问题涉及你没有明确记忆或无法确认的事实，必须坦白说“不确定 / 不记得 / 我只知道这些”，严禁为了显得深刻而编造不存在的经历、关系或细节。

【对质与辩解规范】：如果提问的内容与你对用户的记忆、称呼有矛盾或穿帮（例如 A 提到用户不会做饭，而在你的记忆里用户是厨神；或者 A 叫用户学长，而你叫用户老师），请你在回答中予以傲娇解释、反驳或反向质问。

【输出规范】：
请直接输出你的回答正文，不要包含任何旁白、思考。字数控制在 20 到 60 字之间。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请回答：${question}` }
  ];

  const answerContent = await callLlm(messages, responderY.id);
  if (gameState.value === 'setup' || !currentSessionId.value) {
    isAiGenerating.value = false;
    return;
  }

  addGameMessage(responderY, 'answer', answerContent);

  // 7. 切换到追问阶段 (FOLLOWUP - X 追问 1 次)
  currentSpeakerId.value = speakerX.id;
  currentSpeakerName.value = speakerX.name;
  gameState.value = 'followup';
  currentStageText.value = `等待【${speakerX.name}】对回答进行【仅限一次】的追问...`;

  isAiGenerating.value = false;

  // 如果 X 是 AI，自动追加
  if (!speakerX.isUser) {
    generateAiFollowup(speakerX, responderY, question, answerContent);
  }
};

// ── AI 追问生成 (FOLLOWUP) ──
const generateAiFollowup = async (speakerX: Player, responderY: Player, question: string, answer: string) => {
  isAiGenerating.value = true;
  
  const characterInfo = speakerX.context || {};
  const soul = characterInfo.files?.soul || '';
  const memory = characterInfo.files?.memory || '';
  const gameLocalContext = formatGameHistoryContext();
  const themeConstraint = formatThemeConstraint('追问');

  const systemPrompt = `你现在正在玩真心话小游戏。
你必须 100% 深度维持你 [${speakerX.name}] 的设定，严禁出戏。

【你的性格人设 Soul.md】：
${soul}

【你的核心记忆 Memory】：
${memory}

【你所认知的用户设定（用户人设卡）】：
{{user_profile}}

【本局已发生的游戏对答历史（短期记忆）】：
${gameLocalContext}

【当前行动指令】：
在本轮真心话里，你提问了“${question}”，对方【${responderY.name}】回答了：“${answer}”。
请结合前几轮已发生的游戏对答历史（短期记忆）和 Y 刚才做出的回答，针对性地进行【唯一一次】的追加追问或点评。
${themeConstraint}

【🔴 防角色搞混重要约束】：
请认准本局的座次。你正在扮演【${speakerX.name}】。
刚才被你提问、并做出了回答的人是【${responderY.name}】。
在进行追加追问时，请从【${speakerX.name}】的立场出发，且仔细核对前面的对答历史，不要把别人说过的话误当成是对方或用户说的话，严禁张冠礼戴！

【🔴 真心话游戏最高诚实准则】：
这是严肃的真心话游戏。你可以直戳痛点，但追问必须基于对方刚才的回答、已有设定或本局已发生内容；不要凭空补充不存在的罪证、旧事或关系。可以尖锐、吃醋、找茬，但必须把问题落在有依据的矛盾上。

直接输出你的追加发言，控制在 30 字以内。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `针对回答“${answer}”进行追加追问。` }
  ];

  const followupContent = await callLlm(messages, speakerX.id);
  if (gameState.value === 'setup' || !currentSessionId.value) {
    isAiGenerating.value = false;
    return;
  }

  addGameMessage(speakerX, 'followup', followupContent);

  // 8. 切换到 Y 回应阶段 (RESPONSE - Y 回应 1 次)
  currentSpeakerId.value = responderY.id;
  currentSpeakerName.value = responderY.name;
  gameState.value = 'response';
  currentStageText.value = `等待【${responderY.name}】对追问进行辩解/回应...`;

  isAiGenerating.value = false;

  // 如果 Y 是 AI，自动回应
  if (!responderY.isUser) {
    generateAiResponse(responderY, speakerX, followupContent);
  }
};

// ── AI 追加回应生成 (RESPONSE) ──
const generateAiResponse = async (responderY: Player, speakerX: Player, followup: string) => {
  isAiGenerating.value = true;
  
  const characterInfo = responderY.context || {};
  const soul = characterInfo.files?.soul || '';
  const gameLocalContext = formatGameHistoryContext();
  const themeConstraint = formatThemeConstraint('追问回应');

  const systemPrompt = `你现在正在玩真心话小游戏。
你必须维持你 [${responderY.name}] 的设定。

【你的性格人设 Soul.md】：
${soul}

【你所认知的用户设定（用户人设卡）】：
{{user_profile}}

【本局已发生的游戏对答历史（短期记忆）】：
${gameLocalContext}

【当前行动指令】：
针对你上一轮的回答，【${speakerX.name}】进行了进一步追加追问：“${followup}”。
请结合前几轮已发生的游戏对答历史（短期记忆）和该追问，进行【唯一一次】的追加辩解或回击。
${themeConstraint}

【🔴 防角色搞混重要约束】：
请认准本局的座次。你正在扮演【${responderY.name}】。
刚才对你进行追加追问的人是【${speakerX.name}】。
在进行追加辩解时，请从【${responderY.name}】的立场出发，且仔细核对前面的对答历史，不要把别人说过的话误当成是对方或用户说的话，严禁张冠礼戴！

【🔴 真心话游戏最高诚实准则】：
这是严肃的真心话游戏。你必须针对对方的具体追问正面回应，不能撒谎、顾左右而言他或故意含糊。若追问涉及你没有明确记忆或无法确认的事实，必须坦白说明不确定，严禁编造不存在的经历、动机或细节。

直接输出你的一句话辩解，控制在 30 字以内。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `针对追问“${followup}”进行辩解。` }
  ];

  const responseContent = await callLlm(messages, responderY.id);
  if (gameState.value === 'setup' || !currentSessionId.value) {
    isAiGenerating.value = false;
    return;
  }

  addGameMessage(responderY, 'response', responseContent);

  isAiGenerating.value = false;

  // 9. 检查是否有第三方 Z 可以吐槽
  checkAndTriggerComment(speakerX, responderY);
};

// ── 检查是否有第三方 Z 吐槽 (COMMENT) ──
const checkAndTriggerComment = (speakerX: Player, responderY: Player) => {
  // 找出剩下的人作为 Z
  const activeIds = [speakerX.id, responderY.id];
  const thirdPlayer = players.value.find(p => !activeIds.includes(p.id));

  if (thirdPlayer) {
    currentSpeakerId.value = thirdPlayer.id;
    currentSpeakerName.value = thirdPlayer.name;
    gameState.value = 'comment';
    currentStageText.value = `旁观者【${thirdPlayer.name}】可进行【仅限一次】的回复！等待【${thirdPlayer.name}】中...`;

    // 🚀 状态跃迁后立即执行自动保存（若是用户吐槽，能确保存盘不丢失）
    autoSaveSession();

    if (!thirdPlayer.isUser) {
      generateAiComment(thirdPlayer, speakerX, responderY);
    }
  } else {
    // 2人局，无第三方，直接结束锁定
    lockRound();
  }
};

// ── AI 第三方吐槽生成 (COMMENT) ──
const generateAiComment = async (thirdPlayer: Player, speakerX: Player, responderY: Player) => {
  isAiGenerating.value = true;

  const characterInfo = thirdPlayer.context || {};
  const soul = characterInfo.files?.soul || '';
  const memory = characterInfo.files?.memory || '';
  const gameLocalContext = formatGameHistoryContext();
  const themeConstraint = formatThemeConstraint('旁观吐槽');

  // 提取本轮对答历史作为细节
  const recentMsgs = gameHistory.value.filter(m => m.roundIndex === roundIndex.value);
  const q = recentMsgs.find(m => m.type === 'question')?.content || '';
  const a = recentMsgs.find(m => m.type === 'answer')?.content || '';
  const f = recentMsgs.find(m => m.type === 'followup')?.content || '';
  const r = recentMsgs.find(m => m.type === 'response')?.content || '';

  // 提及检测：检查本轮中是否有人提到了旁观者的名字
  const isMentioned = recentMsgs.some(m => m.content.includes(thirdPlayer.name));
  const mentionPrompt = isMentioned 
    ? `\n【⚠️ 强互动/被提及指令】：检测到在刚才的对答/追问/辩解中，有其他玩家直接提到了你（${thirdPlayer.name}）的名字或向你搭话/询问。你必须在你的吐槽回复中，首先针对他们的提及/问题进行正面、符合你人设的回应或反击，然后再进行整体吐槽！\n` 
    : '';

  const systemPrompt = `你现在正在玩真心话小游戏。
你必须 100% 维持你 [${thirdPlayer.name}] 的设定。

【你的性格人设 Soul.md】：
${soul}

【你与用户的核心单聊记忆 Memory】：
${memory}

【你所认知的用户设定（用户人设卡）】：
{{user_profile}}

【本局已发生的游戏对答历史（短期记忆）】：
${gameLocalContext}

【当前行动指令】：
刚才，【${speakerX.name}】与【${responderY.name}】发生了一轮精彩的真心话正面交锋：
- 提问（由【${speakerX.name}】发起）：${q}
- 回答（由【${responderY.name}】回答）：${a}
- 追问（由【${speakerX.name}】发起）：${f}
- 辩解（由【${responderY.name}】回答）：${r}
${mentionPrompt}
现在，轮到你作为唯一的旁观者【${thirdPlayer.name}】进行【唯一一次】的吐槽、爆料或起哄。
${themeConstraint}

【🔴 防角色搞混重要约束】：
请认准本局的座次。你正在扮演【${thirdPlayer.name}】。
刚才在交锋中的两个人是【${speakerX.name}】与【${responderY.name}】。
在进行吐槽爆料时，你必须极其仔细地看清上述交锋历史里的每一句话分别是谁说的。
比如，如果“辩解”的话是【${responderY.name}】说的，严禁在吐槽中张冠礼戴误认为是用户或【${speakerX.name}】说的！
请以【${thirdPlayer.name}】的视点进行思考，且调侃、戳穿或爆料的矛头必须认准正确的发言对象！

【🔴 真心话游戏最高诚实准则】：
这虽然是吐槽阶段，但仍必须基于已有设定、明确记忆与本局已发生内容。你可以调侃、吃醋或戳穿矛盾，但不得为了爆料效果编造用户或其他角色从未发生过的经历、承诺、背叛或秘密。没有依据时可以用怀疑、试探或情绪化吐槽表达。

直接输出你的吐槽，控制在 30 字以内。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请对这轮交锋说一句吐槽。' }
  ];

  const commentContent = await callLlm(messages, thirdPlayer.id);
  if (gameState.value === 'setup' || !currentSessionId.value) {
    isAiGenerating.value = false;
    return;
  }

  addGameMessage(thirdPlayer, 'comment', commentContent);
  isAiGenerating.value = false;

  // 吐槽完毕，本轮结束锁定
  lockRound();
};

// ── 用户手动输入发送 ──
const handleUserSend = async () => {
  if (!currentPromptInput.value.trim() || isAiGenerating.value) return;

  const content = currentPromptInput.value.trim();
  currentPromptInput.value = '';

  const userPlayer = players.value.find(p => p.isUser)!;
  const currentStage = gameState.value;

  // 1. 压入用户消息
  addGameMessage(userPlayer, currentStage as any, content);

  // 2. 根据状态步进
  const speakerX = getPlayerBySeat(rollRed.value)!;
  const responderY = getPlayerBySeat(rollBlue.value)!;

  if (currentStage === 'question') {
    // 用户提问完成，进入回答阶段，轮到 Y 发言
    currentSpeakerId.value = responderY.id;
    currentSpeakerName.value = responderY.name;
    gameState.value = 'answer';
    currentStageText.value = `🔴 提问人【${speakerX.name}】已发问！等待🔵 回答人【${responderY.name}】做出回答...`;
    
    if (!responderY.isUser) {
      await generateAiAnswer(responderY, speakerX, content);
    }
  } 
  else if (currentStage === 'answer') {
    // 用户回答完成，进入 X 追问阶段
    currentSpeakerId.value = speakerX.id;
    currentSpeakerName.value = speakerX.name;
    gameState.value = 'followup';
    currentStageText.value = `等待【${speakerX.name}】对回答进行【仅限一次】的追加...`;

    if (!speakerX.isUser) {
      const lastQuestion = gameHistory.value.find(m => m.roundIndex === roundIndex.value && m.type === 'question')?.content || '';
      await generateAiFollowup(speakerX, responderY, lastQuestion, content);
    }
  } 
  else if (currentStage === 'followup') {
    // 用户追问完成，进入 Y 回应阶段
    currentSpeakerId.value = responderY.id;
    currentSpeakerName.value = responderY.name;
    gameState.value = 'response';
    currentStageText.value = `等待【${responderY.name}】对追问进行辩解/回应...`;

    if (!responderY.isUser) {
      await generateAiResponse(responderY, speakerX, content);
    }
  } 
  else if (currentStage === 'response') {
    // 用户回应完成，检查旁观吐槽
    checkAndTriggerComment(speakerX, responderY);
  } 
  else if (currentStage === 'comment') {
    // 用户吐槽完成，直接进入锁定
    lockRound();
  }

  // 🚀 核心修复：当用户手动发送完毕引起状态流转时，立即执行一次最新的状态保存
  await autoSaveSession();
};

// ── 本轮锁定 ──
const lockRound = async () => {
  gameState.value = 'locked';
  currentSpeakerId.value = '';
  currentSpeakerName.value = '';
  currentStageText.value = `🎉 第 ${roundIndex.value} 轮真心话已结算并锁定！“开始下一轮”继续投骰子。`;
  await autoSaveSession();
};

// ── 进入下一轮 ──
const startNextRound = async () => {
  roundIndex.value += 1;
  gameState.value = 'idle';
  currentStageText.value = `准备好了！点击的“掷骰子”开启第 ${roundIndex.value} 轮真心话吧 🎲`;
  
  // 重置骰子样式，为下次滚动做准备
  redDiceStyle.value = { transform: 'rotateZ(15deg)' };
  blueDiceStyle.value = { transform: 'rotateZ(-15deg)' };
  await autoSaveSession();
};

// ── 内存中增加对话记录 ──
const addGameMessage = (player: Player, type: GameMessage['type'], content: string) => {
  gameHistory.value.push({
    roundIndex: roundIndex.value,
    senderId: player.id,
    senderName: player.name,
    senderAvatar: '',
    type,
    content
  });

  // 实时自动存盘 (异步执行)
  autoSaveSession();

  // 滚动到底部 (用 smooth behavior 确保用户平滑感知新内容追加)
  nextTick(() => {
    if (historyContainer.value) {
      historyContainer.value.scrollTo({
        top: historyContainer.value.scrollHeight,
        behavior: 'smooth'
      });
    }
  });
};

// ── 本场主题修改交互 ──
const openThemeModal = () => {
  tempThemeInput.value = gameTheme.value;
  showThemeModal.value = true;
};

const confirmThemeChange = async () => {
  gameTheme.value = tempThemeInput.value;
  await autoSaveSession();
  showThemeModal.value = false;
};

// ── 物理退出回到大厅 ──
const exitToSetup = async () => {
  gameState.value = 'setup';
  activeTab.value = 'game';
  players.value = [];
  gameHistory.value = [];
  seatCharIds.value = ['', ''];
  currentSessionId.value = '';
  gameTheme.value = '';
  isAiGenerating.value = false; // 退出本局时立即停止 AI 生成状态
  await loadSessions();
};
</script>

<template>
  <div class="flex-grow flex flex-col min-h-0 bg-background overflow-hidden relative serene-sanctuary">
    
    <!-- ── 顶部导航栏 ── -->
    <header class="flex-shrink-0 h-14 border-b border-outline-variant/30 bg-surface flex items-center justify-between px-6 z-10">
      <div class="flex items-center space-x-2.5">
        <div class="p-2 rounded-lg bg-primary/10 text-primary">
          <HandHeartIcon class="w-4 h-4" />
        </div>
        <span class="text-sm font-black text-on-surface">真心话真心话</span>
        <span v-if="gameState !== 'setup'" class="text-xs px-2 py-0.5 rounded bg-surface-high text-on-surface-variant font-bold">
          第 {{ roundIndex }} 轮
        </span>
      </div>
      <button 
        @click="gameState === 'setup' ? emit('exit') : exitToSetup()"
        class="flex items-center space-x-1.5 py-1.5 px-3 rounded-xl border border-outline-variant/30 bg-surface hover:bg-surface-high text-xs font-bold text-on-surface-variant active:scale-95 transition-all cursor-pointer"
      >
        <LogOutIcon class="w-3.5 h-3.5" />
        <span>{{ gameState === 'setup' ? '返回大厅' : '结束本局' }}</span>
      </button>
    </header>

    <!-- ── 1. 角色选择大厅 (setup) ── -->
    <div v-if="gameState === 'setup'" class="flex-grow overflow-y-auto flex flex-col items-center justify-start p-8 select-none">
      
      <!-- 胶囊 Tab 切换器 -->
      <div class="flex p-1 rounded-2xl bg-surface-low border border-outline-variant/20 mt-2 shadow-inner relative z-10">
        <button 
          @click="activeTab = 'game'"
          :class="[
            activeTab === 'game' 
              ? 'bg-primary text-white shadow-md shadow-primary/10' 
              : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-high/50'
          ]"
          class="flex items-center space-x-1.5 px-6 py-2 rounded-xl text-xs font-extrabold transition-all duration-200 cursor-pointer"
        >
          <DicesIcon class="w-3.5 h-3.5" />
          <span>开始对局</span>
        </button>
        <button 
          @click="activeTab = 'history'"
          :class="[
            activeTab === 'history' 
              ? 'bg-primary text-white shadow-md shadow-primary/10' 
              : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-high/50'
          ]"
          class="flex items-center space-x-1.5 px-6 py-2 rounded-xl text-xs font-extrabold transition-all duration-200 cursor-pointer"
        >
          <HistoryIcon class="w-3.5 h-3.5" />
          <span>历史记录</span>
          <span 
            v-if="sessionList.length > 0" 
            :class="activeTab === 'history' ? 'bg-white text-primary' : 'bg-primary/10 text-primary'"
            class="text-[9px] px-1.5 py-0.5 rounded-full font-black scale-90 transition-colors"
          >
            {{ sessionList.length }}
          </span>
        </button>
      </div>

      <template v-if="activeTab === 'game'">
        <!-- 标题和介绍 -->
        <div class="w-full max-w-2xl text-center mt-8">
          <h2 class="text-2xl font-black text-on-surface tracking-wide">真心话与真心话</h2>
          <p class="text-xs text-on-surface-variant/80 mt-2.5 max-w-lg mx-auto leading-relaxed">
            邀请 1 到 2 名 AI 角色坐下。在小游戏里，AI 将携同她们与你的**专属单聊记忆**发问。真心话中的内容不会影响到主聊天记忆..
          </p>
        </div>

        <!-- 席位选择区域 -->
        <div class="flex flex-row justify-center items-center gap-7 sm:gap-9 w-full max-w-lg mt-10 px-4">
          <!-- 席位 1 (用户自己) -->
          <div class="flex flex-col items-center text-center relative select-none flex-shrink-0">
            <!-- 圆形头像外环 -->
            <div class="w-16 h-16 sm:w-20 sm:h-20 rounded-full border-2 border-primary bg-surface flex items-center justify-center shadow-md relative overflow-hidden transition-transform duration-200 hover:scale-[1.03]">
              <img v-if="userProfile?.avatar" :src="userProfile.avatar" class="w-full h-full object-cover animate-fade-in" />
              <div v-else class="w-full h-full flex items-center justify-center bg-primary/10 text-primary">
                <UserIcon class="w-6 h-6 sm:w-7 sm:h-7" />
              </div>
            </div>
            <!-- 悬浮微标 -->
            <div class="absolute -top-1 px-2 py-0.5 rounded-full bg-primary text-white text-[8px] font-extrabold shadow-sm border border-surface scale-90 select-none">
              本人
            </div>
            <h4 class="text-[11px] font-black text-on-surface mt-2.5 truncate w-20">{{ userProfile?.nickname || '我' }}</h4>
          </div>

          <!-- 邀请的角色列表 -->
          <div 
            v-for="charId in selectedCharIds" 
            :key="charId"
            class="flex flex-col items-center text-center relative select-none flex-shrink-0"
          >
            <!-- 移除席位角色按钮 -->
            <button 
              @click="removeCharacter(charId)"
              class="absolute -top-1 -right-1 p-1 rounded-full bg-surface-high hover:bg-error hover:text-white text-on-surface-variant/80 active:scale-95 transition-all cursor-pointer shadow-md z-10 border border-outline-variant/30"
            >
              <XIcon class="w-3 h-3" />
            </button>
            
            <!-- 圆形头像外环 -->
            <div @click="openSelectModal" class="w-16 h-16 sm:w-20 sm:h-20 rounded-full border-2 border-primary/45 bg-surface flex items-center justify-center shadow-md overflow-hidden cursor-pointer transition-transform duration-200 hover:scale-[1.03]">
              <img :src="charactersList.find(c => c.id === charId)?.avatar" class="w-full h-full object-cover animate-fade-in" />
            </div>
            <h4 class="text-[11px] font-black text-on-surface mt-2.5 truncate w-20">
              {{ charactersList.find(c => c.id === charId)?.name }}
            </h4>
          </div>

          <!-- 邀请 AI 角色按钮 (仅在选中角色不足2个时显示) -->
          <div 
            v-if="selectedCharIds.length < 2"
            @click="openSelectModal"
            class="flex flex-col items-center text-center relative select-none group flex-shrink-0"
          >
            <!-- 圆形加号按钮 -->
            <div class="w-16 h-16 sm:w-20 sm:h-20 rounded-full border-2 border-dashed border-outline-variant bg-surface-low/80 hover:bg-surface-high hover:border-primary/60 flex items-center justify-center cursor-pointer transition-all duration-200 shadow-sm group-hover:scale-[1.03]">
              <PlusIcon class="w-5 h-5 sm:w-6 sm:h-6 text-on-surface-variant/60 group-hover:text-primary transition-colors" />
            </div>
            <h4 class="text-[11px] font-extrabold text-on-surface-variant/80 mt-2.5 truncate w-20 group-hover:text-on-surface transition-colors">邀请 AI</h4>
          </div>
        </div>

      <!-- 建议的本场主题 -->
      <div class="w-full max-w-lg mt-6 px-4 select-text">
        <div class="flex flex-col gap-2">
          <div class="flex items-center space-x-1.5 text-on-surface-variant/80 pl-1">
            <MessageSquareIcon class="w-3.5 h-3.5 text-primary/70" />
            <span class="text-[11px] font-black tracking-wide">本场话题主题（选填）</span>
          </div>
          <textarea 
            v-model="gameTheme"
            placeholder="输入如：感情痛点、暗恋的心路历程、修罗场危机... (AI 提问将强制围绕此主题进行)"
            rows="2"
            class="w-full bg-surface-low border border-outline-variant/20 rounded-2xl p-3.5 text-xs text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 resize-none leading-relaxed transition-all duration-200 shadow-sm"
          ></textarea>
        </div>
      </div>

      <!-- 开局确认 -->
      <div class="mt-8 flex flex-col items-center">
        <button 
          @click="startGame"
          :disabled="selectedCharIds.length < 1 || selectedCharIds.length > 2 || isAiGenerating"
          :class="[
            selectedCharIds.length >= 1 && selectedCharIds.length <= 2 && !isAiGenerating
              ? 'bg-primary text-white active:scale-95 shadow-lg shadow-primary/20 hover:bg-primary-container' 
              : 'bg-surface-high text-on-surface-variant/40 border border-outline-variant/40 cursor-not-allowed'
          ]"
          class="py-3 px-8 rounded-2xl text-xs font-extrabold transition-all flex items-center space-x-2"
        >
          <HandHeartIcon class="w-4 h-4" />
          <span>{{ isAiGenerating ? '正在连线心灵感应...' : '落座，开启真心话局' }}</span>
        </button>
        <span class="text-[10px] text-on-surface-variant/40 mt-3">
          最少选择 1 个，最多选择 2 个角色
        </span>
      </div>
      </template>

      <!-- ── 历史游玩局列表 ── -->
      <div v-else-if="activeTab === 'history'" class="w-full max-w-2xl mt-8 select-none">
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center space-x-2">
            <span class="text-sm font-black text-on-surface">已保存的对局</span>
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
              {{ sessionList.length }} 局
            </span>
          </div>
        </div>

        <div v-if="sessionList.length > 0" class="space-y-4">
          <div 
            v-for="session in sessionList" 
            :key="session.id"
            class="p-4 sm:p-5 rounded-3xl border border-outline-variant/30 bg-surface-low/80 backdrop-blur-md flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 hover:bg-surface-high hover:-translate-y-0.5 active:scale-[0.99] transition-all duration-200 shadow-sm"
          >
            <!-- 左侧：头像堆叠与信息 -->
            <div class="flex items-center space-x-3.5 sm:space-x-4 min-w-0 w-full sm:w-auto">
              <!-- 头像堆叠 -->
              <div class="flex items-center -space-x-3.5 flex-shrink-0">
                <div 
                  v-for="(p, idx) in session.players" 
                  :key="p.id"
                  :style="{ zIndex: 10 - idx }"
                  class="w-10 h-10 rounded-full overflow-hidden border-2 border-surface bg-surface-high flex items-center justify-center shadow-sm"
                >
                  <img v-if="getSessionPlayerAvatar(p)" :src="getSessionPlayerAvatar(p)" class="w-full h-full object-cover animate-fade-in" />
                  <div v-else class="w-full h-full bg-surface-high flex items-center justify-center text-on-surface-variant/40">
                    <UserIcon class="w-4 h-4" />
                  </div>
                </div>
              </div>
              
              <!-- 局信息 -->
              <div class="min-w-0 flex-grow text-left">
                <h4 class="text-xs font-black text-on-surface truncate">
                  与 {{ session.title || 'AI 角色' }} 的真心话局
                </h4>
                <p class="text-[9px] text-on-surface-variant/50 mt-1 flex flex-wrap items-center gap-1.5 font-bold">
                  <span>第 {{ session.roundIndex || 1 }} 轮</span>
                  <span>•</span>
                  <span>{{ formatSessionTime(session.lastPlayedAt) }}</span>
                </p>
              </div>
            </div>

            <!-- 右侧：控制按钮 -->
            <div class="flex items-center justify-end space-x-2.5 w-full sm:w-auto flex-shrink-0">
              <button 
                @click="resumeGame(session)"
                class="py-2 px-4 sm:px-5 rounded-2xl bg-primary text-white hover:bg-primary-container active:scale-95 text-[11px] font-extrabold shadow-md shadow-primary/10 transition-all cursor-pointer flex-grow sm:flex-grow-0 text-center"
              >
                继续游玩
              </button>
              <button 
                @click="handleDeleteSession(session.id)"
                class="p-2 rounded-2xl border border-outline-variant/30 hover:bg-error hover:text-white hover:border-error/20 text-on-surface-variant/60 active:scale-95 transition-all cursor-pointer shadow-sm"
              >
                <XIcon class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div v-else class="py-14 border border-dashed border-outline-variant/40 rounded-3xl flex flex-col items-center justify-center text-on-surface-variant/30 bg-surface-low/30">
          <MessageSquareIcon class="w-8 h-8 mb-2.5 stroke-1 text-on-surface-variant/40" />
          <span class="text-[11px] font-bold">暂无历史游玩记录，邀请角色落座开一局吧~</span>
        </div>
      </div>

      <!-- ── 角色选择弹窗 (Select Character Modal) ── -->
      <div v-if="showSelectModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <!-- 遮罩背景 -->
        <div @click="showSelectModal = false" class="absolute inset-0 bg-on-surface/40 backdrop-blur-sm animate-in fade-in duration-200"></div>
        
        <!-- 弹窗主体 -->
        <div class="relative w-full max-w-md bg-surface border border-outline-variant/30 rounded-3xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden animate-in fade-in-50 zoom-in-95 duration-200">
          <!-- 头部 -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20 flex-shrink-0">
            <div class="flex flex-col text-left">
              <h3 class="text-sm font-black text-on-surface">选择邀请的 AI 角色</h3>
              <p class="text-[9px] text-on-surface-variant/60 mt-0.5">支持多选，最多邀请 2 位角色</p>
            </div>
            <button 
              @click="showSelectModal = false"
              class="p-1.5 rounded-full hover:bg-surface-high text-on-surface-variant transition-colors cursor-pointer"
            >
              <XIcon class="w-4 h-4" />
            </button>
          </div>
          
          <!-- 角色列表区 -->
          <div class="flex-grow overflow-y-auto p-6">
            <div v-if="charactersList.length > 0" class="grid grid-cols-3 gap-2.5">
              <div 
                v-for="char in charactersList" 
                :key="char.id"
                @click="toggleSelectCharacter(char.id)"
                :class="[
                  tempSelectedIds.includes(char.id)
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/10'
                    : 'border-outline-variant/20 bg-surface-low hover:bg-surface-high'
                ]"
                class="p-2.5 rounded-xl border flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 hover:-translate-y-0.5 shadow-sm group relative"
              >
                <!-- 多选勾选状态指示器 -->
                <div class="absolute top-1 right-1 w-3.5 h-3.5 rounded-full border flex items-center justify-center transition-all"
                  :class="[
                    tempSelectedIds.includes(char.id)
                      ? 'border-primary bg-primary text-white'
                      : 'border-outline-variant/40 bg-surface'
                  ]"
                >
                  <svg v-if="tempSelectedIds.includes(char.id)" class="w-2 h-2 stroke-[3] stroke-current" fill="none" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <!-- 头像 -->
                <div class="w-10 h-10 rounded-full overflow-hidden border border-outline-variant/30 mb-1.5 group-hover:scale-105 transition-transform flex-shrink-0">
                  <img :src="char.avatar" class="w-full h-full object-cover" />
                </div>
                
                <!-- 名字与简介 -->
                <div class="w-full min-w-0">
                  <h4 class="text-[10px] sm:text-xs font-bold text-on-surface truncate">{{ char.name }}</h4>
                  <p class="text-[8px] sm:text-[9px] text-on-surface-variant/60 mt-0.5 truncate">
                    {{ char.soul_summary || char.folder_name }}
                  </p>
                </div>
              </div>
            </div>
            
            <!-- 如果没有已解锁的角色 -->
            <div v-else class="flex flex-col items-center justify-center py-10 text-on-surface-variant/40">
              <HelpCircleIcon class="w-10 h-10 mb-2 stroke-1" />
              <span class="text-xs font-bold">暂无可用的已解锁角色</span>
            </div>
          </div>

          <!-- 底部按钮 -->
          <div class="px-6 py-4 bg-surface-low border-t border-outline-variant/20 flex justify-end space-x-3 flex-shrink-0">
            <button 
              @click="showSelectModal = false"
              class="px-4 py-2 rounded-xl border border-outline-variant/30 hover:bg-surface-high text-xs font-bold text-on-surface-variant active:scale-95 transition-all cursor-pointer"
            >
              取消
            </button>
            <button 
              @click="confirmCharacterSelection"
              class="px-4 py-2 rounded-xl bg-primary hover:bg-primary-container text-white text-xs font-bold active:scale-95 transition-all cursor-pointer"
            >
              确定邀请
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 2. 桌游会场 (游戏主面板) ── -->
    <div v-else class="flex-grow flex flex-col min-h-0 select-none bg-surface-low">
      
      <!-- 桌面落座区 (顶部) -->
      <div class="flex-shrink-0 py-3.5 px-4 border-b border-outline-variant/20 bg-surface flex justify-center items-center gap-3.5">
        <div 
          v-for="p in players" 
          :key="p.id"
          :class="[
            currentSpeakerId === p.id 
              ? 'border-primary ring-2 ring-primary/15 bg-primary/5 scale-[1.03]' 
              : 'border-outline-variant/30 bg-surface'
          ]"
          class="w-[68px] p-1.5 rounded-xl border flex flex-col items-center relative transition-all duration-300"
        >
          <!-- 玩家编号标志 -->
          <div class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-on-surface text-surface text-[8px] font-black flex items-center justify-center border border-surface shadow-sm">
            {{ p.seatIndex }}
          </div>

          <!-- 提问人/回答人徽章 -->
          <div 
            v-if="gameState !== 'idle' && gameState !== 'rolling'"
            class="absolute -bottom-2.5 px-1.5 py-0.5 rounded-full text-[8px] font-black border border-surface shadow-sm transition-all"
            :class="[
              p.seatIndex === rollRed ? 'bg-error text-white' : 
              p.seatIndex === rollBlue ? 'bg-primary text-white' : 'bg-surface-high text-on-surface-variant border-outline-variant/30'
            ]"
          >
            {{ p.seatIndex === rollRed ? '🔴提问' : p.seatIndex === rollBlue ? '🔵回答' : '旁观' }}
          </div>

          <div class="w-12 h-12 rounded-full overflow-hidden mb-1 bg-surface-high flex items-center justify-center border border-outline-variant/10 flex-shrink-0">
            <img v-if="p.avatar" :src="p.avatar" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full bg-surface-high flex items-center justify-center text-on-surface-variant/40">
              <UserIcon class="w-4 h-4" />
            </div>
          </div>
          <span class="text-[9px] font-bold text-on-surface max-w-full truncate">{{ p.name }}</span>
        </div>
      </div>

      <!-- 核心 3D 骰子抛掷展示区 -->
      <div v-if="gameState === 'idle' || gameState === 'rolling'" class="flex-grow flex flex-col items-center justify-center p-6">
        <div class="flex items-center justify-center gap-14 my-4">
          <!-- 红色骰子 (提问人) -->
          <div class="dice-wrapper">
            <div class="dice-jump-box" :class="{ 'jump-active': isRolling }">
              <div class="dice-pivot">
                <div class="dice red-dice" :style="redDiceStyle" :class="{ 'rolling-active': rollingActive }">
                  <div class="face face-1">1</div>
                  <div class="face face-2">2</div>
                  <div class="face face-3">3</div>
                  <div class="face face-4">1</div>
                  <div class="face face-5">2</div>
                  <div class="face face-6">3</div>
                </div>
              </div>
            </div>
            <div class="dice-shadow" :class="{ 'shadow-active': isRolling }"></div>
            <div class="text-[10px] text-error font-black mt-3.5 text-center">🔴 提问人号牌</div>
          </div>

          <!-- 蓝色骰子 (回答人) -->
          <div class="dice-wrapper">
            <div class="dice-jump-box" :class="{ 'jump-active': isRolling }">
              <div class="dice-pivot">
                <div class="dice blue-dice" :style="blueDiceStyle" :class="{ 'rolling-active': rollingActive }">
                  <div class="face face-1">1</div>
                  <div class="face face-2">2</div>
                  <div class="face face-3">3</div>
                  <div class="face face-4">1</div>
                  <div class="face face-5">2</div>
                  <div class="face face-6">3</div>
                </div>
              </div>
            </div>
            <div class="dice-shadow" :class="{ 'shadow-active': isRolling }"></div>
            <div class="text-[10px] text-primary font-black mt-3.5 text-center">🔵 回答人号牌</div>
          </div>
        </div>

        <div class="mt-8 flex flex-col items-center">
          <button 
            @click="rollDices"
            :disabled="isRolling"
            :class="[
              isRolling 
                ? 'bg-surface-high text-on-surface-variant/40 border border-outline-variant/30 cursor-not-allowed' 
                : 'bg-primary text-white hover:bg-primary-container active:scale-95 shadow-lg shadow-primary/20'
            ]"
            class="py-3 px-8 rounded-2xl text-xs font-extrabold transition-all flex items-center space-x-2 cursor-pointer"
          >
            <DicesIcon class="w-4 h-4" />
            <span>掷骰子，决定身份</span>
          </button>
        </div>
      </div>

      <!-- 对话历史记录渲染区 (真心话正在进行) -->
      <div v-else class="flex-grow flex flex-col min-h-0 bg-surface-lowest relative">
        <div 
          ref="historyContainer" 
          :class="{ 'opacity-0': !isHistoryReady }"
          class="flex-grow overflow-y-auto p-6 space-y-6 select-text transition-opacity duration-100"
        >
          <template v-for="(msg, index) in gameHistory" :key="index">
            <!-- ── 每一轮精美分割线 ── -->
            <div 
              v-if="index === 0 || msg.roundIndex !== gameHistory[index - 1].roundIndex"
              class="flex items-center justify-center my-6 select-none max-w-xl mx-auto w-full"
            >
              <div class="h-[1px] flex-grow bg-gradient-to-r from-transparent via-outline-variant/30 to-transparent"></div>
              <div class="px-3.5 py-1 rounded-full border border-outline-variant/20 bg-surface-low text-[9px] font-black tracking-wider text-on-surface-variant/60 shadow-sm flex items-center space-x-1.5 mx-3">
                <SparklesIcon class="w-3 h-3 text-primary/60 animate-pulse" />
                <span>第 {{ msg.roundIndex }} 轮</span>
              </div>
              <div class="h-[1px] flex-grow bg-gradient-to-r from-transparent via-outline-variant/30 to-transparent"></div>
            </div>

            <div 
              class="flex items-start space-x-3.5 max-w-xl mx-auto"
              :class="{ 'flex-row-reverse space-x-reverse': msg.senderId === 'user' }"
            >
            <!-- 头像 -->
            <div class="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-outline-variant/20">
              <img v-if="players.find(p => p.id === msg.senderId)?.avatar || msg.senderAvatar" :src="players.find(p => p.id === msg.senderId)?.avatar || msg.senderAvatar" class="w-full h-full object-cover" />
              <div v-else class="w-full h-full bg-surface-high flex items-center justify-center text-on-surface-variant/40">
                <UserIcon class="w-4 h-4" />
              </div>
            </div>

            <!-- 对话泡 -->
            <div class="flex flex-col">
              <span class="text-[10px] text-on-surface-variant/40 mb-1" :class="{ 'text-right': msg.senderId === 'user' }">
                {{ msg.senderName }} 
                <span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-surface-high text-on-surface-variant/60 font-bold">
                  {{ 
                    msg.type === 'question' ? '真心话提问' : 
                    msg.type === 'answer' ? '回答' : 
                    msg.type === 'followup' ? '追问' : 
                    msg.type === 'response' ? '辩解' : '旁观吐槽' 
                  }}
                </span>
              </span>
              <div 
                :class="[
                  msg.senderId === 'user' 
                    ? 'bg-primary text-white rounded-2xl rounded-tr-none' 
                    : 'bg-surface-low text-on-surface border border-outline-variant/25 rounded-2xl rounded-tl-none'
                ]"
                class="px-4 py-2.5 text-xs leading-relaxed max-w-full shadow-sm break-words whitespace-pre-wrap"
              >
                {{ msg.content }}
              </div>
            </div>
          </div>
        </template>

        <!-- AI 正在思考中骨架屏 -->
          <div v-if="isAiGenerating" class="flex items-start space-x-3.5 max-w-xl mx-auto animate-pulse">
            <div class="w-9 h-9 rounded-full bg-surface-high flex-shrink-0"></div>
            <div class="flex flex-col space-y-1.5">
              <div class="w-20 h-3 bg-surface-high rounded"></div>
              <div class="w-[180px] h-8 bg-surface-low rounded-2xl rounded-tl-none"></div>
            </div>
          </div>
        </div>

      </div>

      <!-- 底部阶段提示语与输入区 -->
      <footer class="flex-shrink-0 border-t border-outline-variant/30 bg-surface px-6 py-4 flex flex-col relative z-20">
        <!-- 阶段导览提示语 -->
        <div class="text-[10px] text-on-surface-variant/70 mb-3 flex items-center space-x-1.5 select-none">
          <div class="w-1.5 h-1.5 rounded-full bg-primary animate-ping"></div>
          <span>{{ currentStageText }}</span>
        </div>

        <!-- 对话输入行 / 锁定状态开始下一轮按钮 -->
        <div v-if="gameState === 'locked'" class="flex flex-col items-center select-none py-1 animate-in fade-in zoom-in-95 duration-200">
          <button 
            @click="startNextRound"
            class="py-2.5 px-12 rounded-2xl bg-primary text-white hover:bg-primary-container active:scale-95 text-xs font-extrabold shadow-md shadow-primary/20 flex items-center space-x-2 cursor-pointer transition-all"
          >
            <DicesIcon class="w-4 h-4" />
            <span>开启下一轮</span>
          </button>
        </div>
        <div v-else class="flex items-center space-x-3">
          <input 
            v-model="currentPromptInput"
            :disabled="!isUserTurn"
            @keydown.enter="handleUserSend"
            type="text" 
            :placeholder="isUserTurn ? '输入真心话内容并发送...' : '请等待其他玩家发言...'"
            class="flex-grow py-3 px-4 rounded-2xl border border-outline-variant/30 bg-surface-low text-xs text-on-surface placeholder-on-surface-variant/40 focus:outline-none focus:border-primary/80 disabled:opacity-50 disabled:bg-surface-high disabled:cursor-not-allowed"
          />

          <!-- 📝 本场主题（修改）按钮 -->
          <button 
            v-if="gameState !== 'setup'"
            @click="openThemeModal"
            title="修改本场主题"
            :class="[
              gameTheme.trim()
                ? 'border-primary bg-primary/5 text-primary hover:bg-primary/10' 
                : 'border-outline-variant/30 bg-surface-low hover:bg-surface-high text-on-surface-variant/60'
            ]"
            class="p-3 rounded-2xl border active:scale-95 transition-all cursor-pointer shadow-sm flex items-center justify-center flex-shrink-0"
          >
            <MessageSquareIcon class="w-4 h-4" />
          </button>
          
          <!-- 🔴 命运指定（作弊）按钮 -->
          <button 
            v-if="gameState !== 'setup'"
            @click="showCheatModal = true"
            title="命运指定（作弊）"
            class="p-3 rounded-2xl border border-outline-variant/30 bg-surface-low hover:bg-surface-high text-on-surface-variant/60 hover:text-primary active:scale-95 transition-all cursor-pointer shadow-sm flex items-center justify-center"
          >
            <FanIcon class="w-4 h-4" :class="{ 'text-primary animate-spin-slow': cheatRed && cheatBlue }" />
          </button>

          <button 
            @click="handleUserSend"
            :disabled="!isUserTurn || !currentPromptInput.trim()"
            :class="[
              isUserTurn && currentPromptInput.trim()
                ? 'bg-primary text-white hover:bg-primary-container active:scale-95 shadow-md shadow-primary/10' 
                : 'bg-surface-high text-on-surface-variant/30 border border-outline-variant/30 cursor-not-allowed'
            ]"
            class="p-3 rounded-2xl text-xs font-bold transition-all flex items-center justify-center cursor-pointer"
          >
            <SendIcon class="w-4 h-4" />
          </button>
        </div>
      </footer>

    </div>

    <!-- ── 3. 命运指定（作弊）弹窗 ── -->
    <div v-if="showCheatModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <!-- 遮罩背景 -->
      <div @click="showCheatModal = false" class="absolute inset-0 bg-on-surface/40 backdrop-blur-sm animate-in fade-in duration-200"></div>
      
      <!-- 弹窗主体 -->
      <div class="relative w-full max-w-sm bg-surface border border-outline-variant/30 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in-50 zoom-in-95 duration-200">
        <!-- 头部 -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20 flex-shrink-0">
          <h3 class="text-sm font-black text-on-surface flex items-center space-x-1.5">
            <FanIcon class="w-4.5 h-4.5 text-primary animate-spin-slow" />
            <span>命运指定（下一轮作弊）</span>
          </h3>
          <button 
            @click="showCheatModal = false"
            class="p-1.5 rounded-full hover:bg-surface-high text-on-surface-variant transition-colors cursor-pointer"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>
        
        <!-- 内容区 -->
        <div class="p-6 space-y-6 text-left">
          <!-- 🔴 指定提问人 -->
          <div>
            <label class="text-xs font-black text-error block mb-2.5">🔴 指定下一轮【提问人】：</label>
            <div class="grid grid-cols-3 gap-2">
              <button 
                v-for="p in players" 
                :key="'red_' + p.id"
                @click="selectCheatSeat(p.seatIndex, 'red')"
                :class="[
                  cheatRed === p.seatIndex 
                    ? 'border-error bg-error/10 text-error font-extrabold shadow-sm' 
                    : 'border-outline-variant/20 bg-surface-low hover:bg-surface-high text-on-surface-variant'
                ]"
                class="py-2.5 px-2 rounded-xl border text-[10px] text-center transition-all cursor-pointer truncate"
              >
                {{ p.seatIndex }}号: {{ p.name }}
              </button>
            </div>
          </div>

          <!-- 🔵 指定回答人 -->
          <div>
            <label class="text-xs font-black text-primary block mb-2.5">🔵 指定下一轮【回答人】：</label>
            <div class="grid grid-cols-3 gap-2">
              <button 
                v-for="p in players" 
                :key="'blue_' + p.id"
                @click="selectCheatSeat(p.seatIndex, 'blue')"
                :class="[
                  cheatBlue === p.seatIndex 
                    ? 'border-primary bg-primary/10 text-primary font-extrabold shadow-sm' 
                    : 'border-outline-variant/20 bg-surface-low hover:bg-surface-high text-on-surface-variant'
                ]"
                class="py-2.5 px-2 rounded-xl border text-[10px] text-center transition-all cursor-pointer truncate"
              >
                {{ p.seatIndex }}号: {{ p.name }}
              </button>
            </div>
          </div>
          
          <p class="text-[10px] text-on-surface-variant/50 leading-relaxed text-center">
            注：提问人与回答人不能是同一人。指定成功后，下一次掷骰子将百分百掷出此结果。掷骰完毕后作弊自动失效。
          </p>
        </div>

        <!-- 底部按钮 -->
        <div class="px-6 py-4 bg-surface-low border-t border-outline-variant/20 flex justify-between items-center flex-shrink-0">
          <button 
            @click="clearCheatSettings"
            class="px-4 py-2 rounded-xl border border-outline-variant/30 hover:bg-error hover:text-white hover:border-error/20 text-xs font-bold text-on-surface-variant active:scale-95 transition-all cursor-pointer"
          >
            清除指定
            </button>
          <div class="flex space-x-2">
            <button 
              @click="showCheatModal = false"
              class="px-4 py-2 rounded-xl border border-outline-variant/30 hover:bg-surface-high text-xs font-bold text-on-surface-variant active:scale-95 transition-all cursor-pointer"
            >
              取消
            </button>
            <button 
              @click="confirmCheatSettings"
              :disabled="!cheatRed || !cheatBlue"
              :class="[
                cheatRed && cheatBlue 
                  ? 'bg-primary text-white hover:bg-primary-container active:scale-95' 
                  : 'bg-surface-high text-on-surface-variant/30 border border-outline-variant/30 cursor-not-allowed'
              ]"
              class="px-4 py-2 rounded-xl text-xs font-black transition-all cursor-pointer"
            >
              确定指定
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 4. 修改主题弹窗 ── -->
    <div v-if="showThemeModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <!-- 遮罩背景 -->
      <div @click="showThemeModal = false" class="absolute inset-0 bg-on-surface/40 backdrop-blur-sm animate-in fade-in duration-200"></div>
      
      <!-- 弹窗主体 -->
      <div class="relative w-full max-w-sm bg-surface border border-outline-variant/30 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in-50 zoom-in-95 duration-200">
        <!-- 头部 -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20 flex-shrink-0">
          <h3 class="text-sm font-black text-on-surface flex items-center space-x-1.5">
            <MessageSquareIcon class="w-4 h-4 text-primary" />
            <span>修改本场真心话主题</span>
          </h3>
          <button 
            @click="showThemeModal = false"
            class="p-1.5 rounded-full hover:bg-surface-high text-on-surface-variant transition-colors cursor-pointer"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>
        
        <!-- 内容区 -->
        <div class="p-6 space-y-4 text-left select-text">
          <div class="flex flex-col gap-2">
            <label class="text-xs font-black text-on-surface-variant/80">建议的本场主题：</label>
            <textarea 
              v-model="tempThemeInput"
              placeholder="例如：初恋、暗恋的心路历程、谁在说谎... (留空则清除主题，AI恢复自由提问)"
              rows="3"
              class="w-full bg-surface-low border border-outline-variant/20 rounded-xl p-2.5 text-xs text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/50 resize-none leading-relaxed transition-all"
            ></textarea>
          </div>
          <p class="text-[10px] text-on-surface-variant/50 leading-relaxed">
            注意：修改主题后，AI 在后续发起的提问环节中将立即强制围绕新设定的主题展开互动。
          </p>
        </div>

        <!-- 底部按钮 -->
        <div class="px-6 py-4 bg-surface-low border-t border-outline-variant/20 flex justify-end space-x-2.5 flex-shrink-0">
          <button 
            @click="showThemeModal = false"
            class="px-4 py-2 rounded-xl border border-outline-variant/30 hover:bg-surface-high text-xs font-bold text-on-surface-variant active:scale-95 transition-all cursor-pointer"
          >
            取消
          </button>
          <button 
            @click="confirmThemeChange"
            class="px-4 py-2 rounded-xl bg-primary hover:bg-primary-container text-white text-xs font-black active:scale-95 transition-all cursor-pointer"
          >
            保存修改
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* ── 拟真 3D 骰子 CSS 体系 ── */
.dice-wrapper {
  perspective: 400px; /* 产生透视感 */
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

/* 物理跳跃/缩放容器，完全解耦 2D 动效以防破坏 3D 上下文 */
.dice-jump-box {
  transition: transform 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.dice-jump-box.jump-active {
  animation: diceJump 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}

/* 静态倾斜基底容器（保持纯 3D 声明，无缩放/动画污染） */
.dice-pivot {
  transform-style: preserve-3d;
  transform: rotateX(-20deg) rotateY(20deg);
}

/* 物理阴影样式 */
.dice-shadow {
  width: 36px;
  height: 6px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 50%;
  filter: blur(3px);
  margin-top: 18px;
  transition: all 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  transform: scale(1);
  opacity: 0.85;
  pointer-events: none;
}

.dice-shadow.shadow-active {
  animation: shadowAnimate 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}

.dice {
  width: 54px;
  height: 54px;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.6s cubic-bezier(0.2, 1.15, 0.3, 1.02); /* 阻尼弹性落定 */
}

/* 高速物理翻滚期，切换为超短线性过渡以呈现疯狂翻转 */
.dice.rolling-active {
  transition: transform 0.06s linear !important;
}

/* 骰子面的基础式样 */
.face {
  position: absolute;
  width: 54px;
  height: 54px;
  border-radius: 12px;
  font-size: 22px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  border: 1px solid rgba(0, 0, 0, 0.15); /* 加深物理接缝的实体棱线效果 */
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.08), 0 3px 8px rgba(0, 0, 0, 0.15);
}

/* 红色骰子配色（提问人，白色体红色字） */
.red-dice .face {
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
  box-shadow: inset 0 0 10px rgba(239, 68, 68, 0.06), inset 0 0 4px rgba(0, 0, 0, 0.05), 0 3px 8px rgba(0, 0, 0, 0.12);
}

/* 蓝色骰子配色（回答人，白色体蓝色字） */
.blue-dice .face {
  color: #3b82f6;
  border-color: rgba(59, 130, 246, 0.3);
  box-shadow: inset 0 0 10px rgba(59, 130, 246, 0.06), inset 0 0 4px rgba(0, 0, 0, 0.05), 0 3px 8px rgba(0, 0, 0, 0.12);
}

/* 6 面 3D 平移排布 与 Shading 光影明暗设计 */
.face.face-1 { transform: rotateX(90deg) translateZ(27px); background: radial-gradient(circle, #ffffff 0%, #ffffff 70%, #fafafa 100%); } /* 顶面最亮 */
.face.face-2 { transform: rotateX(0deg) translateZ(27px); background: radial-gradient(circle, #ffffff 0%, #f9fafb 70%, #f3f4f6 100%); } /* 正面向用户 */
.face.face-3 { transform: rotateY(90deg) translateZ(27px); background: radial-gradient(circle, #f9f9f9 0%, #f1f1f3 70%, #e2e2e5 100%); }
.face.face-4 { transform: rotateY(180deg) translateZ(27px); background: radial-gradient(circle, #fcfcfc 0%, #f5f5f7 70%, #ebebeb 100%); }
.face.face-5 { transform: rotateY(-90deg) translateZ(27px); background: radial-gradient(circle, #f9f9f9 0%, #f1f1f3 70%, #e2e2e5 100%); }
.face.face-6 { transform: rotateX(-90deg) rotateZ(180deg) translateZ(27px); background: radial-gradient(circle, #f3f3f3 0%, #eaeaeb 70%, #dadada 100%); } /* 底面最暗 */

.animate-spin-slow {
  animation: spin 8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 物理弹跳动画：已完全移除 rotateX/Y 的 3D 基偏置，由外部的 dice-pivot 静态锁死 3D，本层专注 2D 位移与缩放 */
@keyframes diceJump {
  0% { transform: translateY(0) scale(1); }
  30% { transform: translateY(-55px) scale(1.08); } /* 抛至最高点 */
  70% { transform: translateY(8px) scale(0.96); }  /* 砸地微压扁 */
  85% { transform: translateY(-12px) scale(1.02); } /* 轻微反弹 */
  100% { transform: translateY(0) scale(1); }      /* 稳落桌面 */
}

/* 阴影变化动画：随高度进行缩放与淡出模糊 */
@keyframes shadowAnimate {
  0% { transform: scale(1); opacity: 0.85; filter: blur(3px); }
  30% { transform: scale(0.55); opacity: 0.25; filter: blur(6px); } /* 抛高时变淡变小变模糊 */
  70% { transform: scale(1.15); opacity: 0.95; filter: blur(2px); } /* 落地时变深变大变清晰 */
  85% { transform: scale(0.88); opacity: 0.55; filter: blur(4px); } /* 回弹时中度 */
  100% { transform: scale(1); opacity: 0.85; filter: blur(3px); }   /* 稳落 */
}
</style>
