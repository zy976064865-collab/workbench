/**
 * AI 图像修复模块 —— 基于 MI-GAN 深度学习模型,彻底替代传统"贴纹理块"算法
 *
 * 背景: 旧算法(findSourcePatch/fillByBoundary)本质是"从图内别处找纹理块贴进选区",
 * 无论怎么调参都无法生成与周围结构一致的纹理, 这就是"透明镜像感/痕迹"的来源。
 * 本模块在浏览器端直接运行深度学习修复模型(MI-GAN, ICCV 2023, 专为移动端设计, ~28MB),
 * 修复区域由模型生成与背景语义一致的真实纹理。
 *
 * 技术栈:
 * - onnxruntime-web 1.16.3 (CDN 加载, WebGPU 优先, WASM 回退)
 * - 模型: MI-GAN pipeline (含自动 bbox 裁剪/缩放/软融合, 输入全图输出全图)
 * - 模型来源: hf-mirror.com (国内可达, 已实测 CORS 允许 GitHub Pages 跨域)
 * - 模型缓存: IndexedDB, 首次下载 ~27MB, 之后离线可用
 *
 * 全程本地推理, 图片不上传任何服务器。
 */

const AIInpaint = {
  // 模型下载地址(hf-mirror 实测: 302 回显 Origin + CDN allow-origin:*)
  // 模型下载地址: 多源自动切换(huggingface.co 直连可用时优先; hf-mirror 国内可达)
  // 模型下载地址: 多源自动切换(hf-mirror 国内可达; huggingface.co 直连可用时更快)
  MODEL_URLS: [
    'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    'https://hf-mirror.com/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
  ],
  // 模型下载地址: 同源(自己仓库)优先, 彻底摆脱第三方源; 之后是 huggingface.co / hf-mirror 兜底
  MODEL_URLS: [
    './models/migan.onnx',
    'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    'https://hf-mirror.com/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
  ],
  MODEL_NAME: 'migan.onnx',
  MODEL_SIZE: 28079181,
  // onnxruntime-web CDN(jsdelivr, 已实测带 CORS 头)
  ORT_CDN: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.16.3/dist/',

  _session: null,      // 缓存的推理会话
  _loadPromise: null,  // 防止并发重复加载

  /**
   * 动态加载 onnxruntime 运行时(按能力加载 webgpu 版,内含 wasm 后端可回退)
   */
  loadRuntime() {
    if (window.ort) return Promise.resolve(window.ort);
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.ORT_CDN + 'ort.webgpu.min.js';
      s.async = true;
      s.onload = () => resolve(window.ort);
      s.onerror = () => { this._loadPromise = null; reject(new Error('AI 推理引擎加载失败')); };
      document.head.appendChild(s);
    });
    return this._loadPromise;
  },

  /**
   * 获取模型 ArrayBuffer: 优先 IndexedDB 缓存, 无则下载(带进度回调)
   */
  getModel(onProgress) {
    return new Promise((resolve, reject) => {
      let db = null;
      const open = indexedDB.open('workbench-ai', 1);
      open.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('models')) d.createObjectStore('models');
      };
      open.onsuccess = (e) => {
        db = e.target.result;
        const tx = db.transaction('models', 'readonly');
        const req = tx.objectStore('models').get(this.MODEL_NAME);
        req.onsuccess = () => {
          if (req.result && req.result instanceof ArrayBuffer) {
            if (onProgress) onProgress('AI 模型已就绪(本地缓存)', 100);
            resolve(req.result);
          } else {
            this.downloadModel(onProgress).then((buf) => {
              try {
                const tx2 = db.transaction('models', 'readwrite');
                tx2.objectStore('models').put(buf, this.MODEL_NAME);
              } catch (e) { console.warn('AI 模型缓存失败:', e); }
              resolve(buf);
            }).catch(reject);
          }
        };
        req.onerror = () => {
          this.downloadModel(onProgress).then(resolve).catch(reject);
        };
      };
      open.onerror = () => {
        // IndexedDB 不可用(隐私模式等), 直接下载不缓存
        this.downloadModel(onProgress).then(resolve).catch(reject);
      };
    });
  },

  /**
   * 下载模型并显示真实进度(ReadableStream; 不支持时退化为无进度下载)
   */
  /** 带超时的 fetch: 60 秒内无响应则中止, 避免卡死在一个源上 */
  fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { mode: 'cors', signal: ctrl.signal }).finally(() => clearTimeout(timer));
  },

  async downloadModel(onProgress) {
    // 多源依次尝试: 第一个成功的源继续
    let lastErr = null;
    for (const url of this.MODEL_URLS) {
      try {
        if (onProgress) onProgress('正在连接模型源…(首次使用需下载 27MB)', 5);
        const res = await this.fetchWithTimeout(url, 60000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await this.readModelStream(res, onProgress);
      } catch (err) {
        lastErr = err;
        console.warn('[AI修复] 模型源不可用:', url, err);
      }
    }
    throw new Error('AI 模型下载失败(所有源均不可用)' + (lastErr ? ': ' + lastErr.message : ''));
  },

  /** 流式读取响应体并显示进度 */
  async readModelStream(res, onProgress) {
    const total = Number(res.headers.get('content-length')) || this.MODEL_SIZE;
    // 优先流式读取显示进度
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      let lastDataAt = Date.now();
      // 停滞看门狗: 30 秒无新数据则取消本次读取(触发切换下一源)
      const watchdog = setInterval(() => {
        if (Date.now() - lastDataAt > 30000) { try { reader.cancel(); } catch (e) {} }
      }, 5000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastDataAt = Date.now();
          chunks.push(value);
          received += value.length;
          if (onProgress) {
            onProgress(
              '首次使用,正在下载 AI 模型 ' + (received / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB',
              Math.min(90, Math.round(received / total * 100))
            );
          }
        }
      } finally {
        clearInterval(watchdog);
      }
      const buf = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      return buf.buffer;
    }
    // 老浏览器退化: 一次性下载
    if (onProgress) onProgress('正在下载 AI 模型(约27MB)…', 50);
    const buf = await res.arrayBuffer();
    return buf;
  },

  /**
   * 创建推理会话: WebGPU 优先(速度快), 失败自动回退 WASM
   */
  async getSession(onProgress) {
    if (this._session) return this._session;
    const ort = await this.loadRuntime();
    // wasm 文件从 CDN 加载; 无 SharedArrayBuffer 时线程版会失败, 强制单线程
    ort.env.wasm.wasmPaths = this.ORT_CDN;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.simd = true;

    const modelBuf = await this.getModel(onProgress);
    if (onProgress) onProgress('正在初始化 AI 引擎…', 92);

    const providers = [];
    if (typeof navigator !== 'undefined' && navigator.gpu) providers.push('webgpu');
    providers.push('wasm');

    let session = null;
    for (const p of providers) {
      try {
        session = await ort.InferenceSession.create(modelBuf, { executionProviders: [p] });
        console.log('[AI修复] 执行后端:', p);
        break;
      } catch (err) {
        console.warn('[AI修复] 后端不可用:', p, err);
      }
    }
    if (!session) {
      try {
        session = await ort.InferenceSession.create(modelBuf);
      } catch (err) {
        throw new Error('AI 推理引擎初始化失败');
      }
    }
    this._session = session;
    return session;
  },

  /**
   * 对选区执行 AI 修复, 结果写回 offCtx
   * @param {object} r 选区 {x,y,w,h} (offCanvas 像素坐标)
   * @param {object} opts { offCtx, onProgress }
   * @returns {Promise<boolean>} true=AI 修复成功
   */
  async inpaintRect(r, opts) {
    const { offCtx, onProgress } = opts;
    const W = offCtx.canvas.width, H = offCtx.canvas.height;
    if (!W || !H) throw new Error('画布为空');

    // ① 构建全图 mask: 255=已知区域(保留), 0=待修复区域
    const maskFull = new Uint8Array(W * H);
    maskFull.fill(255);
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(W, Math.round(r.x + r.w)), y1 = Math.min(H, Math.round(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) maskFull[y * W + x] = 0;
    }

    // ② 计算带上下文的裁剪区域(padding 128, 给模型足够周边信息)
    const pad = 128;
    const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad);
    const bx1 = Math.min(W, x1 + pad), by1 = Math.min(H, y1 + pad);
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw <= 0 || bh <= 0) throw new Error('选区无效');

    // ③ 读取画布像素(RGBA), 构建 CHW uint8 输入
    const region = offCtx.getImageData(bx0, by0, bw, bh);
    const rgba = region.data;
    const img = new Uint8Array(3 * bw * bh);
    const mask = new Uint8Array(bw * bh);
    const hw = bw * bh;
    for (let j = 0; j < bh; j++) {
      const gy = by0 + j;
      for (let i = 0; i < bw; i++) {
        const gx = bx0 + i;
        const di = j * bw + i;
        img[di] = rgba[di * 4];
        img[hw + di] = rgba[di * 4 + 1];
        img[2 * hw + di] = rgba[di * 4 + 2];
        mask[di] = maskFull[gy * W + gx];
      }
    }

    // ④ 创建会话并推理
    const session = await this.getSession(onProgress);
    if (onProgress) onProgress('正在 AI 修复中…', 95);
    const ort = window.ort;
    const results = await session.run({
      image: new ort.Tensor('uint8', img, [1, 3, bh, bw]),
      mask: new ort.Tensor('uint8', mask, [1, 1, bh, bw]),
    });
    const out = results['result'] || results[Object.keys(results)[0]];
    const d = out.data;
    const oh = out.dims[2], ow = out.dims[3];
    if (ow !== bw || oh !== bh) throw new Error('AI 输出尺寸异常');

    // ⑤ 写回修复结果到裁剪区域, 边缘 16px 羽化融合避免外接缝
    const rd = region.data;
    const feather = 16;
    for (let j = 0; j < bh; j++) {
      const gy = by0 + j;
      for (let i = 0; i < bw; i++) {
        const gx = bx0 + i;
        // 像素到原始选区的距离(0=选区内)
        const dx = Math.max(x0 - gx, gx - (x1 - 1), 0);
        const dy = Math.max(y0 - gy, gy - (y1 - 1), 0);
        const dist = Math.max(dx, dy);
        const di = j * bw + i;
        const nR = d[di], nG = d[hw + di], nB = d[2 * hw + di];
        if (dist === 0) {
          // 选区内: 完全采用 AI 修复结果
          rd[di * 4] = nR; rd[di * 4 + 1] = nG; rd[di * 4 + 2] = nB; rd[di * 4 + 3] = 255;
        } else if (dist < feather) {
          // 过渡带: 与原始像素线性混合, 消除外接缝
          const a = 1 - dist / feather;
          rd[di * 4] = Math.round(nR * a + rd[di * 4] * (1 - a));
          rd[di * 4 + 1] = Math.round(nG * a + rd[di * 4 + 1] * (1 - a));
          rd[di * 4 + 2] = Math.round(nB * a + rd[di * 4 + 2] * (1 - a));
        }
        // dist >= feather: 保持原图, 不动
      }
    }
    offCtx.putImageData(region, bx0, by0);
    return true;
  },

  /** 是否可用(供 UI 提示) */
  isAvailable() {
    return typeof window !== 'undefined' && !!window.ort;
  },
};

// const 声明不挂 window, 显式挂载供 watermark.js 检测使用
if (typeof window !== 'undefined') window.AIInpaint = AIInpaint;
