import { getDatabaseService } from '../db/database';
import { net } from 'electron';

interface WeatherCache {
  text: string;
  timestamp: number;
}

export class WeatherService {
  private static cache: Map<string, WeatherCache> = new Map();
  private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1小时缓存时间限制

  private static readonly weatherConditionMap: Record<string, string> = {
    'sunny': '晴',
    'clear': '晴',
    'partly cloudy': '多云',
    'cloudy': '阴',
    'overcast': '阴',
    'mist': '雾',
    'fog': '雾',
    'patchy rain nearby': '小雨',
    'patchy rain possible': '小雨',
    'light rain': '小雨',
    'light drizzle': '小雨',
    'light rain shower': '阵雨',
    'moderate rain': '中雨',
    'heavy rain': '大雨',
    'torrential rain shower': '大暴雨',
    'thundery outbreaks possible': '雷阵雨',
    'thunderstorm': '雷阵雨',
    'snow': '雪',
    'light snow': '小雪',
    'heavy snow': '大雪'
  };

  private static translateCondition(englishCond: string): string {
    const normalized = englishCond.trim().toLowerCase();
    for (const [eng, chn] of Object.entries(this.weatherConditionMap)) {
      if (normalized.includes(eng)) {
        return chn;
      }
    }
    return englishCond;
  }

  private static getCountyLevel(location: string): string {
    let loc = location.trim();
    // 1. 如果包含 "省"，去掉 "xx省"
    const provinceIdx = loc.indexOf('省');
    if (provinceIdx !== -1) {
      loc = loc.substring(provinceIdx + 1);
    }
    // 2. 如果包含 "自治区"，去掉 "xx自治区"
    const autoRegionIdx = loc.indexOf('自治区');
    if (autoRegionIdx !== -1) {
      loc = loc.substring(autoRegionIdx + 3);
    }
    return loc;
  }

  private static getCityLevel(location: string): string {
    const countyLoc = this.getCountyLevel(location);
    // 提取 "市" 级，如 "深圳市宝安区" -> "深圳市"
    const cityMatch = countyLoc.match(/^([^市]+市)/);
    if (cityMatch && cityMatch[1]) {
      return cityMatch[1];
    }
    return countyLoc;
  }

  private static async fetchRawWeather(queryLoc: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 单个请求限时 4 秒

    try {
      const url = `https://wttr.in/${encodeURIComponent(queryLoc)}?format=%C+%t`;
      const res = await net.fetch(url, {
        headers: {
          'User-Agent': 'curl/7.85.0' // 物理锁死 User-Agent 头部，强制 wttr.in 回归极简纯文本格式
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      if (text.includes('location not found') || text.includes('upstream error') || text.length > 60) {
        throw new Error('Location not found or upstream error');
      }

      // 解析返回格式，如 "Sunny +30°C" 或 "Patchy rain nearby +22°C"
      const lastPlus = text.lastIndexOf('+');
      const lastMinus = text.lastIndexOf('-');
      const splitIndex = Math.max(lastPlus, lastMinus);

      let condition = text;
      let temp = '';
      if (splitIndex !== -1) {
        condition = text.substring(0, splitIndex).trim();
        temp = text.substring(splitIndex).trim();
      }

      const translatedCond = this.translateCondition(condition);
      return temp ? `${translatedCond} ${temp}` : translatedCond;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * 预取并缓存特定城市的天气信息 (支持两阶段区县-市级降级与强刷)
   */
  public static async prefetchWeather(location: string, forceRefresh = false): Promise<string> {
    const loc = (location || '').trim();
    if (!loc) {
      console.log('[WeatherService] prefetchWeather: 传入地理位置为空字符串');
      return '';
    }

    const now = Date.now();
    const cached = this.cache.get(loc);
    console.log(`[WeatherService] prefetchWeather: loc="${loc}", forceRefresh=${forceRefresh}, 是否命中有用缓存:`, (!forceRefresh && cached && now - cached.timestamp < this.CACHE_DURATION));
    if (!forceRefresh && cached && now - cached.timestamp < this.CACHE_DURATION) {
      console.log(`[WeatherService] prefetchWeather: 命中缓存, 直接返回: "${cached.text}"`);
      return cached.text;
    }

    // 内存中暂时置为空值，避免接口等待中被并发重复调用
    this.cache.set(loc, { text: cached?.text || '', timestamp: now });

    const countyLoc = this.getCountyLevel(loc);
    const cityLoc = this.getCityLevel(loc);
    console.log(`[WeatherService] prefetchWeather: 开始两阶段查询. 区县级="${countyLoc}", 城市级="${cityLoc}"`);

    // 第一阶段：优先精确尝试区县级
    try {
      console.log(`[WeatherService] [第一阶段] 正在请求区县天气: "${countyLoc}"`);
      const weatherText = await this.fetchRawWeather(countyLoc);
      console.log(`[WeatherService] [第一阶段] 成功获取区县天气: "${weatherText}"`);
      this.cache.set(loc, { text: weatherText, timestamp: Date.now() });
      return weatherText;
    } catch (err: any) {
      console.warn(`[WeatherService] [第一阶段] 失败 [${countyLoc}], 准备降级至市级 [${cityLoc}]. 错误原因:`, err.message || err);

      // 第二阶段：降级尝试市级
      try {
        console.log(`[WeatherService] [第二阶段] 正在请求城市天气: "${cityLoc}"`);
        const weatherText = await this.fetchRawWeather(cityLoc);
        console.log(`[WeatherService] [第二阶段] 成功获取城市天气: "${weatherText}"`);
        this.cache.set(loc, { text: weatherText, timestamp: Date.now() });
        return weatherText;
      } catch (err2: any) {
        console.error(`[WeatherService] [第二阶段] 失败 [${cityLoc}]. 彻底获取失败. 错误原因:`, err2.message || err2);

        // 彻底失败：容错降级，返回旧值
        const fallbackText = cached?.text || '';
        this.cache.set(loc, { text: fallbackText, timestamp: now - this.CACHE_DURATION + 10 * 60 * 1000 }); // 10分钟后重试
        return fallbackText;
      }
    }
  }

  /**
   * 快速、静力同步读取当前城市天气缓存
   */
  public static getWeatherSync(location: string): string {
    const loc = (location || '').trim();
    if (!loc) return '';
    return this.cache.get(loc)?.text || '';
  }

  /**
   * 获取用户个人配置中的完整所在地名称与实时天气并合并，供Prompt注入及前端渲染使用
   */
  public static async getRealtimeWeatherInfo(): Promise<{ location: string; weather: string }> {
    let location = '';
    try {
      const db = getDatabaseService();
      const profileStr = db.getSetting('echo_user_profile');
      if (profileStr) {
        const parsed = JSON.parse(profileStr);
        if (parsed.location) {
          location = parsed.location.trim();
        }
      }
    } catch (_) {}

    if (!location) {
      return { location: '', weather: '' };
    }

    const weatherText = await this.prefetchWeather(location);
    return { location, weather: weatherText };
  }
}
