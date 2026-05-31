import crypto from 'crypto';
import axios from 'axios';
import { getDatabaseService } from '../db/database';

/**
 * 微信个人号 iLink API 客户端类，负责所有官方 API 通信与端到端 AES 媒体加解密。
 */
export class WeChatClient {
  private baseUri: string = 'https://ilinkai.weixin.qq.com';
  private cdnBaseUri: string = 'https://novac2c.cdn.weixin.qq.com/c2c';
  private apiTimeoutMs: number = 30000;

  constructor() {}

  /**
   * 规范化基础 URL 地址
   */
  public setBaseUrl(url: string): void {
    if (url) {
      this.baseUri = url.trim().replace(/\/+$/, '');
    }
  }

  /**
   * 计算经过 AES PKCS7 填充对齐后的预期密文尺寸
   */
  public getAesPaddedSize(size: number): number {
    return size + (16 - (size % 16) || 16);
  }

  /**
   * 生成恒定的、唯一的设备 HTTP Headers 报头以杜绝多终端冲突限流
   */
  private buildHeaders(token?: string): Record<string, string> {
    let uin = '';
    try {
      const db = getDatabaseService();
      uin = db.getSetting('wechat_uin') || '';
      if (!uin) {
        uin = crypto.randomBytes(4).readUInt32BE(0).toString();
        db.setSetting('wechat_uin', uin);
      }
    } catch (_) {
      // 降级使用恒定兜底设备
      uin = '8610092144';
    }
    const encodedUin = Buffer.from(uin).toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': encodedUin,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  /**
   * 统一 JSON API 请求封装 (支持自定义超长超时设置)
   */
  public async requestJson(
    method: 'GET' | 'POST',
    endpoint: string,
    payload: any = null,
    token: string | null = null,
    params: any = null,
    customTimeoutMs: number | null = null
  ): Promise<any> {
    const url = `${this.baseUri}/${endpoint.replace(/^\/+/, '')}`;
    const headers = this.buildHeaders(token || undefined);

    try {
      const response = await axios({
        method,
        url,
        data: payload,
        params,
        headers,
        timeout: customTimeoutMs || this.apiTimeoutMs
      });
      return response.data;
    } catch (err: any) {
      const detailedErr = err.response?.data ? `${err.message} | 详情: ${JSON.stringify(err.response.data)}` : err.message;
      console.error(`[WeChatClient] API 请求失败 [${method} ${endpoint}]:`, detailedErr);
      throw err;
    }
  }

  /**
   * 本地 AES-128 ECB 加密二进制字节，底层自动进行 PKCS7 Padding
   */
  public encryptAesEcb(plainBuffer: Buffer, aesKeyHex: string): Buffer {
    const key = Buffer.from(aesKeyHex, 'hex');
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  }

  /**
   * 本地 AES-128 ECB 解密二进制字节，支持 hex 或 Base64 格式的密钥，底层自动剥离 PKCS7 Padding
   */
  public decryptAesEcb(encryptedBuffer: Buffer, aesKeyStr: string): Buffer {
    let key: Buffer;
    const cleanKey = aesKeyStr.trim();

    try {
      // 优先尝试 16 进制解析
      key = Buffer.from(cleanKey, 'hex');
      if (key.length !== 16) {
        throw new Error('Hex key length is not 16');
      }
    } catch (_) {
      // 降级为 Base64 解析
      key = Buffer.from(cleanKey, 'base64');
      if (key.length === 32) {
        // 部分 Base64 密钥解码后为 32位十六进制字符串，需进一步转化
        key = Buffer.from(key.toString('ascii'), 'hex');
      }
    }

    if (key.length !== 16) {
      throw new Error(`非法的 AES 密钥尺寸，期望 16 字节，实际为 ${key.length} 字节`);
    }

    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  }

  /**
   * 加密媒体二进制文件并提交上传至腾讯微信 C2C CDN
   */
  public async uploadToCDN(
    uploadFullUrl: string,
    uploadParam: string,
    fileKey: string,
    aesKeyHex: string,
    rawBuffer: Buffer
  ): Promise<string> {
    // 1. 本地进行 AES 加密
    const encryptedData = this.encryptAesEcb(rawBuffer, aesKeyHex);

    // 2. 拼接完整的上传目标 URL
    let targetUrl = uploadFullUrl;
    if (!targetUrl) {
      targetUrl = `${this.cdnBaseUri}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
    }

    // 3. POST 二进制密文数据至 CDN
    try {
      const response = await axios.post(targetUrl, encryptedData, {
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        timeout: this.apiTimeoutMs
      });

      // 4. 从 Response Headers 中提取 x-encrypted-param 作为下载凭证
      const downloadParam = response.headers['x-encrypted-param'];
      if (!downloadParam) {
        throw new Error('CDN 上传成功，但响应头中未包含关键的 x-encrypted-param 下载凭证');
      }
      return downloadParam as string;
    } catch (err: any) {
      console.error('[WeChatClient] 二进制加密流上传 CDN 失败:', err.message);
      throw err;
    }
  }

  /**
   * 从微信 C2C CDN 下载加密二进制数据
   */
  public async downloadCdnBytes(encryptQueryParam: string): Promise<Buffer> {
    const downloadUrl = `${this.cdnBaseUri}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;

    try {
      const response = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: this.apiTimeoutMs
      });
      return Buffer.from(response.data);
    } catch (err: any) {
      console.error('[WeChatClient] 从 CDN 下载密文流失败:', err.message);
      throw err;
    }
  }

  /**
   * 从微信 CDN 下载密文流并在本地实时 AES 解密还原出明文文件
   */
  public async downloadAndDecryptMedia(encryptQueryParam: string, aesKeyStr: string): Promise<Buffer> {
    const encryptedBytes = await this.downloadCdnBytes(encryptQueryParam);
    return this.decryptAesEcb(encryptedBytes, aesKeyStr);
  }
}
