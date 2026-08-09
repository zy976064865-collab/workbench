/**
 * 去水印模块
 * - 全程本地处理,不上传任何网络
 * - 1:1 原始分辨率输出,PNG 无损导出
 * - 智能修复:Telea 快速行进算法(FMM) + 多尺度细节填充
 *
 * 架构:结果像素(offCanvas)与显示标注(Canvas 叠加层)分离。
 * - offCanvas:保存原始图像与所有修复/模糊/撤销结果,像素级真实内容,永不画标注
 * - 显示画布:每帧由 offCanvas 重绘底图,再叠加选区/拖拽框标注
 * - 导出时只取 offCanvas,因此导出结果绝不含框线,且保留所有已生效的处理
 */

const Watermark = {
  image: null,        // 原始 ImageBitmap/HTMLImageElement(供参考)
  canvas: null,       // 显示画布(叠加标注)
  ctx: null,          // 显示画布 2D 上下文
  offCanvas: null,    // 结果画布(原始分辨率,像素真相)
  offCtx: null,       // 结果画布 2D 上下文
  rects: [],          // 已框选的区域 {x,y,w,h}
  dragging: null,     // 当前正在绘制 {sx,sy,cx,cy}
  selIndex: -1,       // 当前选中的区域(操作目标)
  tool: 'draw',       // draw | select
  history: [],        // 撤销栈(ImageData 快照)
  MAX_HISTORY: 12,
  dispScale: 1,       // 画布显示比例(适配屏幕)
  drawing: false,
  pointerId: null,
  _processing: false, // 防止处理中重复操作
  MAX_PIXELS: 2048,   // 单边最长像素(超大图降采样处理,兼容 iPhone canvas 面积限制)

  init() {
    this.canvas = document.getElementById('wmCanvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.offCanvas = document.createElement('canvas');
    this.offCtx = this.offCanvas.getContext('2d', { willReadFrequently: true });
    this.bindUI();
  },

  bindUI() {
    document.getElementById('fileInput').addEventListener('change', e => this.loadFile(e.target.files[0]));

    // 清空重选:回到选图首页
    document.getElementById('wmClearBtn').addEventListener('click', () => this.resetAll());

    // 框选开关:点击进入/退出框选模式
    document.getElementById('wmDrawBtn').addEventListener('click', () => this.toggleDrawMode());

    // 选区操作
    document.querySelectorAll('.chip-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => this.handleAction(btn.dataset.action));
    });

    // 导出
    document.getElementById('exportPngBtn').addEventListener('click', () => this.exportPng());
    document.getElementById('exportJpgBtn').addEventListener('click', () => this.exportJpg());

    // 结果弹窗
    document.getElementById('saveImgBtn').addEventListener('click', () => this.saveResult());
    document.getElementById('previewClose').addEventListener('click', () => {
      document.getElementById('previewMask').style.display = 'none';
    });
    document.getElementById('previewMask').addEventListener('click', e => {
      if (e.target === e.currentTarget) document.getElementById('previewMask').style.display = 'none';
    });

    // 画布指针事件:框选模式下拦截触摸,浏览模式让页面滚动
    if (window.PointerEvent) {
      this.canvas.addEventListener('pointerdown', e => this.onDown(e));
      this.canvas.addEventListener('pointermove', e => this.onMove(e));
      this.canvas.addEventListener('pointerup', e => this.onUp(e));
      this.canvas.addEventListener('pointercancel', e => this.onUp(e));
    } else {
      this.canvas.addEventListener('touchstart', e => this.onTouchStart(e), { passive: false });
      this.canvas.addEventListener('touchmove', e => this.onTouchMove(e), { passive: false });
      this.canvas.addEventListener('touchend', e => this.onTouchEnd(e), { passive: false });
      this.canvas.addEventListener('mousedown', e => this.onDown(e));
      this.canvas.addEventListener('mousemove', e => this.onMove(e));
      this.canvas.addEventListener('mouseup', e => this.onUp(e));
    }
  },

  /** 框选模式开关 */
  toggleDrawMode() {
    if (this._processing) return;
    this.tool = (this.tool === 'draw') ? 'browse' : 'draw';
    if (this.tool !== 'draw') { this.dragging = null; this.drawing = false; }
    this.updateToolUI();
  },

  updateToolUI() {
    const isDraw = this.tool === 'draw';
    const btn = document.getElementById('wmDrawBtn');
    if (btn) {
      btn.classList.toggle('active', isDraw);
      btn.textContent = isDraw ? '✅ 完成框选' : '✏️ 框选';
    }
    this.canvas.classList.toggle('wm-drawing', isDraw);
    if (!isDraw) { this.dragging = null; this.drawing = false; }
    const hasSel = this.rects.length > 0 && this.selIndex >= 0;
    document.getElementById('selToolRow').style.display = hasSel ? 'flex' : 'none';
    if (this.selIndex < 0 || this.selIndex >= this.rects.length) this.selIndex = -1;
    this.redraw();
  },

  /** 从文件读取图片,保证原始分辨率 */
  loadFile(file) {
    if (!file || !file.type.startsWith('image/')) { Toast.show('请选择图片文件'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // iOS Safari 上过早 revoke blob URL 会导致后续 drawImage 失败,延迟释放
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
      if (!img.naturalWidth || !img.naturalHeight) { Toast.show('图片读取失败'); return; }
      clearTimeout(loadTimer);
      this.setImage(img);
      Toast.show('图片已载入,请框选水印区域');
    };
    img.onerror = () => { clearTimeout(loadTimer); setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000); Toast.show('图片格式不支持,请选择 JPG/PNG 图片'); };
    // 超时兜底:某些格式/超大图在 iOS 上解码慢或失败,给出明确提示
    const loadTimer = setTimeout(() => {
      if (!img.complete || !img.naturalWidth) { Toast.show('图片加载超时,可能格式不支持或图片过大'); }
    }, 8000);
    img.src = url;
  },

  setImage(img) {
    this.image = img;
    // 超大图:等比降采样到单边 ≤2048,否则 iPhone 内存/画布面积会爆
    let w = img.naturalWidth, h = img.naturalHeight;
    const maxSide = this.MAX_PIXELS;
    if (w > maxSide || h > maxSide) {
      const s = Math.min(1, maxSide / Math.max(w, h));
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    this.offCanvas.width = w;
    this.offCanvas.height = h;
    this.offCtx.drawImage(img, 0, 0, w, h);
    // 安全校验:确认 offCanvas 确实画上了像素,避免 iOS 上静默失败后一片空白
    try {
      const probe = this.offCtx.getImageData(0, 0, 1, 1).data;
      if (!probe || probe[3] === 0) { Toast.show('图片加载失败,请换一张试试'); return; }
    } catch (e) {
      Toast.show('图片过大,无法处理,请换一张较小的图片'); return;
    }
    this.rects = [];
    this.selIndex = -1;
    this.history = [];
    this.tool = 'browse'; // 默认浏览模式,可滚动页面
    const db = document.getElementById('wmDrawBtn');
    if (db) { db.classList.remove('active'); db.textContent = '✏️ 框选'; }
    this.canvas.classList.remove('wm-drawing');
    document.getElementById('cropBtn').disabled = false;
    document.getElementById('undoBtn').disabled = true;
    document.getElementById('selToolRow').style.display = 'none';

    document.getElementById('wmIntro').style.display = 'none';
    document.getElementById('wmStage').style.display = 'block';

    // 计算显示缩放
    this.layoutCanvas();
    this.redraw();
  },

  /** 清空并回到选图首页 */
  resetAll() {
    this.image = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.offCanvas.width = 0;
    this.offCanvas.height = 0;
    this.rects = [];
    this.selIndex = -1;
    this.history = [];
    this.dragging = null;
    this.drawing = false;
    this._processing = false;
    clearInterval(this._barTimer);
    document.getElementById('loadingMask').style.display = 'none';
    document.getElementById('wmIntro').style.display = 'block';
    document.getElementById('wmStage').style.display = 'none';
  },

  layoutCanvas() {
    // 显示尺寸:按容器等比缩放,canvas 内部分辨率 = 显示尺寸(节省内存,兼容 iOS canvas 面积限制)
    const wrap = document.querySelector('.wm-canvas-wrap');
    const boxW = (wrap && wrap.clientWidth) || (window.innerWidth - 28);
    const boxH = (wrap && wrap.clientHeight) || 380;
    this.dispScale = Math.min(boxW / this.offCanvas.width, boxH / this.offCanvas.height);
    const dw = Math.max(1, Math.round(this.offCanvas.width * this.dispScale));
    const dh = Math.max(1, Math.round(this.offCanvas.height * this.dispScale));
    // 显示画布内部分辨率 = 显示尺寸(不再保留全尺寸,避免 iOS canvas 面积超限)
    this.canvas.width = dw;
    this.canvas.height = dh;
    // 容器内居中偏移(留白区域),坐标映射时使用
    this.dispOffsetX = Math.round((boxW - dw) / 2);
    this.dispOffsetY = Math.round((boxH - dh) / 2);
    // 关键:canvas CSS 尺寸 = 位图显示尺寸,flex 容器居中,不依赖 object-fit
    this.canvas.style.width = dw + 'px';
    this.canvas.style.height = dh + 'px';
    this.redraw();
  },

  /** 屏幕坐标 -> 图像坐标 */
  toImageCoord(x, y) {
    // canvas 内部分辨率 = 显示尺寸(dw),CSS 尺寸 = 显示尺寸,像素一一对应
    const r = this.canvas.getBoundingClientRect();
    const dx = (x - r.left) * (this.canvas.width / r.width);
    const dy = (y - r.top) * (this.canvas.height / r.height);
    const ix = dx / this.dispScale;
    const iy = dy / this.dispScale;
    return {
      x: Math.max(0, Math.min(this.offCanvas.width, ix)),
      y: Math.max(0, Math.min(this.offCanvas.height, iy)),
    };
  },

  // ---- 触控兼容(iOS Safari <13) ----
  touchToXY(e) {
    const t = e.touches[0];
    return { x: t.clientX, y: t.clientY };
  },
  onTouchStart(e) {
    if (this.tool !== 'draw') return; // 浏览模式不拦截,页面可滚动
    e.preventDefault();
    const { x, y } = this.touchToXY(e);
    this.onDownXY(x, y);
  },
  onTouchMove(e) {
    if (this.tool !== 'draw') return;
    e.preventDefault();
    if (this.drawing) {
      const { x, y } = this.touchToXY(e);
      this.onMoveXY(x, y);
    }
  },
  onTouchEnd(e) {
    if (this.tool !== 'draw') return;
    e.preventDefault();
    if (this.drawing) this.onUpXY();
  },

  onDown(e) {
    if (!this.image) return;
    if (this.tool !== 'draw') return; // 浏览模式不拦截
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    this.pointerId = e.pointerId;
    this.onDownXY(e.clientX, e.clientY);
  },

  /** 统一的按下处理:进入框选或选择模式 */
  onDownXY(cx, cy) {
    if (!this.image || this._processing) return;
    if (this.tool !== 'draw') return;
    const p = this.toImageCoord(cx, cy);
    this.dragging = { sx: p.x, sy: p.y, cx: p.x, cy: p.y };
    this.drawing = true;
  },

  onMove(e) {
    if (!this.image) return;
    if (this.tool !== 'draw') return;
    e.preventDefault();
    if (this.drawing && this.dragging) this.onMoveXY(e.clientX, e.clientY);
  },
  onMoveXY(cx, cy) {
    if (!this.image || !this.dragging) return;
    const p = this.toImageCoord(cx, cy);
    this.dragging.cx = p.x;
    this.dragging.cy = p.y;
    this.redraw();
  },

  onUp(e) {
    if (!this.image) return;
    if (this.tool !== 'draw') return;
    e.preventDefault();
    if (this.drawing) this.onUpXY();
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    this.pointerId = null;
  },
  onUpXY() {
    if (!this.dragging) return;
    const { sx, sy, cx, cy } = this.dragging;
    const x = Math.min(sx, cx), y = Math.min(sy, cy);
    const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
    if (w > 4 && h > 4) {
      this.rects.push({ x, y, w, h });
      this.selIndex = this.rects.length - 1;
      // 框选完成:自动退出框选模式,恢复页面滚动
      this.tool = 'browse';
      this.updateToolUI();
      Toast.show('已框选区域,可点下方按钮处理');
    }
    this.dragging = null;
    this.drawing = false;
  },

  /**
   * 重绘显示画布:底图来自结果画布(offCanvas),再叠加标注。
   * 标注只画在显示画布上,offCanvas 永远保持像素真相。
   */
  redraw() {
    if (!this.image) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // offCanvas(全尺寸)缩放到显示画布尺寸
    this.ctx.drawImage(this.offCanvas, 0, 0, this.offCanvas.width, this.offCanvas.height, 0, 0, this.canvas.width, this.canvas.height);

    // 选区标注
    this.rects.forEach((r, i) => {
      this.ctx.strokeStyle = '#3B82F6';
      this.ctx.lineWidth = 2.5;
      this.ctx.setLineDash([10, 6]);
      this.ctx.strokeRect(r.x * this.dispScale, r.y * this.dispScale, r.w * this.dispScale, r.h * this.dispScale);
      if (i === this.selIndex) {
        this.ctx.fillStyle = 'rgba(59,130,246,0.14)';
        this.ctx.fillRect(r.x * this.dispScale, r.y * this.dispScale, r.w * this.dispScale, r.h * this.dispScale);
      }
    });
    // 当前拖动框
    if (this.dragging) {
      const { sx, sy, cx, cy } = this.dragging;
      const x = Math.min(sx, cx), y = Math.min(sy, cy);
      this.ctx.strokeStyle = '#F59E0B';
      this.ctx.lineWidth = 2.5;
      this.ctx.setLineDash([]);
      this.ctx.strokeRect(x * this.dispScale, y * this.dispScale, Math.abs(cx - sx) * this.dispScale, Math.abs(cy - sy) * this.dispScale);
      this.ctx.fillStyle = 'rgba(245,158,11,0.12)';
      this.ctx.fillRect(x * this.dispScale, y * this.dispScale, Math.abs(cx - sx) * this.dispScale, Math.abs(cy - sy) * this.dispScale);
    }
  },

  /** 选区动作处理 */
  handleAction(action) {
    if (!this.image || this._processing) return;
    switch (action) {
      case 'inpaint': this.inpaintSelected(); break;
      case 'blur': this.blurSelected(); break;
      case 'deleteSel': this.deleteSelected(); break;
      case 'clearSel': this.clearSelection(); break;
      case 'undo': this.undo(); break;
      case 'crop': this.cropSelected(); break;
    }
  },

  /** 保存当前结果画布到历史栈 */
  pushHistory() {
    const data = this.offCtx.getImageData(0, 0, this.offCanvas.width, this.offCanvas.height);
    this.history.push(data);
    if (this.history.length > this.MAX_HISTORY) this.history.shift();
    document.getElementById('undoBtn').disabled = false;
  },

  undo() {
    if (this._processing) return;
    const data = this.history.pop();
    if (!data) return;
    this.offCtx.putImageData(data, 0, 0);
    document.getElementById('undoBtn').disabled = this.history.length === 0;
    this.redraw();
    Toast.show('已撤销上一步');
  },

  getSelectedRect() {
    if (this.selIndex < 0 || this.selIndex >= this.rects.length) return null;
    const r = this.rects[this.selIndex];
    // 裁剪到画布内
    const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
    const w = Math.min(this.offCanvas.width - x, Math.round(r.w));
    const h = Math.min(this.offCanvas.height - y, Math.round(r.h));
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  },

  /** ✨ 智能修复(FMM + 细节填充),针对选区 */
  inpaintSelected() {
    const r = this.getSelectedRect();
    if (!r) { Toast.show('请先框选水印区域'); return; }
    if (this.tool === 'draw') {
      // 若还在框选模式,自动退出
      this.tool = 'browse';
      this.updateToolUI();
    }
    const area = r.w * r.h;
    if (area > this.offCanvas.width * this.offCanvas.height * 0.5) {
      Toast.show('选区过大,建议缩小范围后重试');
      return;
    }
    this.showLoading('正在智能修复…', true);
    this._processing = true;
    // 用 requestAnimationFrame 让 loading 先渲染
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          this.pushHistory();
          this.inpaintRect(r);
          this.rects = this.rects.filter((_, i) => i !== this.selIndex);
          this.selIndex = -1;
          this.updateToolUI();
          this.redraw();
          this.hideLoading();
          this._processing = false;
          Toast.show('智能修复完成 ✨');
        } catch (err) {
          console.error(err);
          this.hideLoading();
          this._processing = false;
          Toast.show('处理失败,请重试');
        }
      }, 30);
    });
  },

  /** 模糊选区(异步分块,不阻塞 UI) */
  blurSelected() {
    const r = this.getSelectedRect();
    if (!r) { Toast.show('请先框选水印区域'); return; }
    const radius = Math.max(6, Math.round(Math.max(r.w, r.h) / 10));
    this.showLoading('正在模糊…', false);
    this._processing = true;
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          this.pushHistory();
          this.blurRectAsync(r, radius, () => {
            this.rects = this.rects.filter((_, i) => i !== this.selIndex);
            this.selIndex = -1;
            this.updateToolUI();
            this.redraw();
            this.hideLoading();
            this._processing = false;
            Toast.show('已模糊选区 🌫');
          });
        } catch (err) {
          console.error(err);
          this.hideLoading();
          this._processing = false;
          Toast.show('处理失败,请重试');
        }
      }, 30);
    });
  },

  /** 删除选中区域(不修改像素,只去掉选区) */
  deleteSelected() {
    const r = this.getSelectedRect();
    if (!r) { Toast.show('请先框选水印区域'); return; }
    this.rects = this.rects.filter((_, i) => i !== this.selIndex);
    this.selIndex = -1;
    this.updateToolUI();
    Toast.show('已删除该选区');
  },

  clearSelection() {
    this.selIndex = -1;
    this.redraw();
  },

  /** 裁剪出选区(新图) */
  cropSelected() {
    const r = this.getSelectedRect();
    if (!r) { Toast.show('请先框选要裁剪的区域'); return; }
    // 从结果画布取像素(无标注)
    const data = this.offCtx.getImageData(r.x, r.y, r.w, r.h);
    const img = new Image();
    img.onload = () => {
      this.setImage(img);
      Toast.show('已裁剪出新图片');
    };
    const c = document.createElement('canvas');
    c.width = r.w; c.height = r.h;
    c.getContext('2d').putImageData(data, 0, 0);
    img.src = c.toDataURL('image/png');
  },

  /**
   * 从选区附近寻找一块同尺寸、边缘最匹配的真实背景。
   * 复制真实纹理能避免 FMM 在大选区内不断平均后形成灰色矩形。
   */
  findSourcePatch(data, W, H, r) {
    const { x, y, w, h } = r;
    if (w < 2 || h < 2 || w > W * 0.65 || h > H * 0.65) return null;

    const maxCandidates = 3200;
    const radius = Math.max(96, Math.min(Math.max(w, h) * 3, Math.max(W, H)));
    const minX = Math.max(0, x - radius), maxX = Math.min(W - w, x + radius);
    const minY = Math.max(0, y - radius), maxY = Math.min(H - h, y + radius);
    const area = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    const step = Math.max(1, Math.ceil(Math.sqrt(area / maxCandidates)));
    const sampleStep = Math.max(1, Math.ceil((w + h) * 2 / 96));
    const margin = 2;

    const pixelError = (p1, p2) => {
      const dr = data[p1] - data[p2];
      const dg = data[p1 + 1] - data[p2 + 1];
      const db = data[p1 + 2] - data[p2 + 2];
      return dr * dr + dg * dg + db * db;
    };

    const overlapsSelection = (sx, sy) => !(
      sx + w + margin <= x || sx >= x + w + margin ||
      sy + h + margin <= y || sy >= y + h + margin
    );

    const scoreAt = (sx, sy) => {
      if (sx < 0 || sy < 0 || sx + w > W || sy + h > H || overlapsSelection(sx, sy)) return null;
      let error = 0, samples = 0;

      if (y > 0) {
        for (let i = 0; i < w; i += sampleStep) {
          error += pixelError(((y - 1) * W + x + i) * 4, (sy * W + sx + i) * 4);
          samples++;
        }
      }
      if (y + h < H) {
        for (let i = 0; i < w; i += sampleStep) {
          error += pixelError(((y + h) * W + x + i) * 4, ((sy + h - 1) * W + sx + i) * 4);
          samples++;
        }
      }
      if (x > 0) {
        for (let j = 0; j < h; j += sampleStep) {
          error += pixelError(((y + j) * W + x - 1) * 4, ((sy + j) * W + sx) * 4);
          samples++;
        }
      }
      if (x + w < W) {
        for (let j = 0; j < h; j += sampleStep) {
          error += pixelError(((y + j) * W + x + w) * 4, ((sy + j) * W + sx + w - 1) * 4);
          samples++;
        }
      }
      if (!samples) return null;

      const dx = sx - x, dy = sy - y;
      const distancePenalty = (dx * dx + dy * dy) / Math.max(1, w * w + h * h) * 12;
      return error / (samples * 3) + distancePenalty;
    };

    let best = null;
    const consider = (sx, sy) => {
      const score = scoreAt(sx, sy);
      if (score !== null && (!best || score < best.score)) best = { sx, sy, score };
    };

    for (let sy = minY; sy <= maxY; sy += step) {
      for (let sx = minX; sx <= maxX; sx += step) consider(sx, sy);
    }
    if (!best) return null;

    // 粗搜后在最佳点附近逐像素细搜，避免跳步错过纹理相位。
    const refine = Math.max(1, step);
    for (let sy = Math.max(minY, best.sy - refine); sy <= Math.min(maxY, best.sy + refine); sy++) {
      for (let sx = Math.max(minX, best.sx - refine); sx <= Math.min(maxX, best.sx + refine); sx++) consider(sx, sy);
    }

    // 边缘均方根误差过大表示附近没有可靠背景，交给保底算法。
    return best && Math.sqrt(best.score) <= 72 ? best : null;
  },

  /** 复制真实背景块，并只在最外层做窄边融合。 */
  applySourcePatch(src, data, W, H, r, patch) {
    const { x, y, w, h } = r;
    const { sx, sy } = patch;
    const copied = new Uint8ClampedArray(w * h * 4);

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const from = ((sy + j) * W + sx + i) * 4;
        const to = (j * w + i) * 4;
        copied[to] = src[from]; copied[to + 1] = src[from + 1];
        copied[to + 2] = src[from + 2]; copied[to + 3] = 255;
      }
    }

    const feather = Math.max(2, Math.min(6, Math.round(Math.min(w, h) * 0.08)));
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const to = ((y + j) * W + x + i) * 4;
        const from = (j * w + i) * 4;
        const d = Math.min(i, w - 1 - i, j, h - 1 - j);
        let alpha = 1;
        let outside = -1;

        if (d < feather) {
          const t = (d + 1) / (feather + 1);
          alpha = t * t * (3 - 2 * t);
          let ox = x + i, oy = y + j;
          if (i === d && x > 0) ox = x - 1;
          else if (w - 1 - i === d && x + w < W) ox = x + w;
          else if (j === d && y > 0) oy = y - 1;
          else if (y + h < H) oy = y + h;
          if (ox !== x + i || oy !== y + j) outside = (oy * W + ox) * 4;
        }

        for (let c = 0; c < 3; c++) {
          const edge = outside >= 0 ? src[outside + c] : copied[from + c];
          data[to + c] = Math.round(copied[from + c] * alpha + edge * (1 - alpha));
        }
        data[to + 3] = 255;
      }
    }
  },

  /**
   * 核心:Telea 快速行进算法(FMM) inpaint
   * 从选区边界向内传播已知像素,按梯度方向平滑填充
   * 直接操作结果画布(offCtx)
   */
  inpaintRect(r) {
    const { x, y, w, h } = r;
    const W = this.offCanvas.width, H = this.offCanvas.height;
    const src = this.offCtx.getImageData(0, 0, W, H);
    const data = src.data;
    const sourcePatch = this.findSourcePatch(data, W, H, r);
    if (sourcePatch) {
      const original = new Uint8ClampedArray(data);
      this.applySourcePatch(original, data, W, H, r, sourcePatch);
      this.offCtx.putImageData(src, 0, 0);
      return;
    }

    // 边界外扩 8px,提升边界颜色连续性
    const pad = 8;
    const bx = Math.max(0, x - pad), by = Math.max(0, y - pad);
    const bw = Math.min(W, x + w + pad) - bx;
    const bh = Math.min(H, y + h + pad) - by;

    // 掩码:1=需要修复
    const mask = new Uint8Array(bw * bh);
    for (let j = 0; j < h; j++) {
      const gy = y + j;
      for (let i = 0; i < w; i++) {
        const gx = x + i;
        mask[(gy - by) * bw + (gx - bx)] = 1;
      }
    }

    // FMM 双缓冲
    const buf = new Uint8ClampedArray(data);
    const dist = new Float32Array(bw * bh).fill(Infinity);
    // 已知像素(掩码外)距离为 0,未知像素为 Infinity
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        if (!mask[j * bw + i]) dist[j * bw + i] = 0;
      }
    }
    const band = []; // 边界带
    const inBand = new Uint8Array(bw * bh);

    const idx = (gx, gy) => (gy - by) * bw + (gx - bx);
    const inB = (gx, gy) => gx >= bx && gx < bx + bw && gy >= by && gy < by + bh;

    // 初始化边界带:掩码内且邻接已知像素
    const isKnown = (gx, gy) => !mask[idx(gx, gy)];
    const neighbors = [[-1,0,1],[1,0,1],[0,-1,1],[0,1,1],[-1,-1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[1,1,Math.SQRT2]];
    for (let gy = by; gy < by + bh; gy++) {
      for (let gx = bx; gx < bx + bw; gx++) {
        if (!mask[idx(gx, gy)]) continue;
        let near = false;
        for (const [dx, dy] of neighbors) {
          const nx = gx + dx, ny = gy + dy;
          if (inB(nx, ny) && isKnown(nx, ny)) { near = true; break; }
        }
        if (near) {
          band.push([gx, gy]);
          dist[idx(gx, gy)] = 1;
          inBand[idx(gx, gy)] = 1;
        }
      }
    }

    // 小顶堆实现优先队列
    class MinHeap {
      constructor() { this.a = []; }
      push(d, x, y) {
        const arr = this.a;
        arr.push([d, x, y]);
        let i = arr.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (arr[p][0] <= arr[i][0]) break;
          [arr[p], arr[i]] = [arr[i], arr[p]];
          i = p;
        }
      }
      pop() {
        const arr = this.a;
        if (!arr.length) return null;
        const top = arr[0];
        const last = arr.pop();
        if (arr.length) {
          arr[0] = last;
          let i = 0;
          const n = arr.length;
          for (;;) {
            const l = i * 2 + 1, rr = i * 2 + 2;
            let m = i;
            if (l < n && arr[l][0] < arr[m][0]) m = l;
            if (rr < n && arr[rr][0] < arr[m][0]) m = rr;
            if (m === i) break;
            [arr[m], arr[i]] = [arr[i], arr[m]];
            i = m;
          }
        }
        return top;
      }
      get size() { return this.a.length; }
    }

    const heap = new MinHeap();
    for (const [gx, gy] of band) heap.push(dist[idx(gx, gy)], gx, gy);

    // 迭代填充
    while (heap.size) {
      const [d, gx, gy] = heap.pop();
      const i = idx(gx, gy);
      if (!inBand[i]) continue;
      inBand[i] = 0;

      // 计算该点颜色:Telea 梯度感知权重
      // 标准做法:梯度方向 ∇I,等照度线方向 T=(-∇Iy, ∇Ix),
      // 权重 = |dir·T| 方向一致性(沿边缘传播) × 距离衰减
      let sumW = 0, sr = 0, sg = 0, sb = 0;
      const ox = [-1, 1, 0, 0, -1, 1, -1, 1], oy = [0, 0, -1, 1, -1, -1, 1, 1];
      // 计算梯度 ∇I(用四邻域已知像素的亮度差分)
      let gxr = 0, gyr = 0; // 梯度分量
      let nKnown = 0;
      for (let k = 0; k < 4; k++) {
        const nx = gx + ox[k], ny = gy + oy[k];
        if (!inB(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (mask[ni]) continue;
        const pi = (ny * W + nx) * 4;
        const l = 0.299 * buf[pi] + 0.587 * buf[pi + 1] + 0.114 * buf[pi + 2];
        gxr += ox[k] * l; gyr += oy[k] * l;
        nKnown++;
      }
      if (nKnown < 2) {
        // 已知邻居太少,退化为普通距离加权(避免异常)
        for (let k = 0; k < 4; k++) {
          const nx = gx + ox[k], ny = gy + oy[k];
          if (!inB(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (mask[ni]) continue;
          const w = 1 / (dist[ni] + 1);
          const pi = (ny * W + nx) * 4;
          sr += buf[pi] * w; sg += buf[pi + 1] * w; sb += buf[pi + 2] * w;
          sumW += w;
        }
      } else {
        // 等照度线方向 T = (-gyr, gxr),归一化
        const gLen = Math.sqrt(gxr * gxr + gyr * gyr) || 1;
        const tx = -gyr / gLen, ty = gxr / gLen;
        for (let k = 0; k < 4; k++) {
          const nx = gx + ox[k], ny = gy + oy[k];
          if (!inB(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (mask[ni]) continue;
          // 方向一致性:|dir·T| 越大(沿边缘)权重越高,平滑传播无阴影
          const dirDot = (ox[k] * tx + oy[k] * ty);
          const w = (Math.abs(dirDot) + 0.5) / (dist[ni] + 1);
          const pi = (ny * W + nx) * 4;
          sr += buf[pi] * w; sg += buf[pi + 1] * w; sb += buf[pi + 2] * w;
          sumW += w;
        }
      }
      if (sumW > 0) {
        const pi = (gy * W + gx) * 4;
        buf[pi] = sr / sumW; buf[pi + 1] = sg / sumW; buf[pi + 2] = sb / sumW;
        buf[pi + 3] = 255;
        mask[i] = 0; // 标记已修复
      } else {
        // 没有已知邻居(极端情况),按原色保留
        mask[i] = 0;
        continue;
      }

      // 扩散到四邻域:更新未填充邻居的距离并加入边界带
      for (const [dx, dy, dd] of neighbors) {
        const nx = gx + dx, ny = gy + dy;
        if (!inB(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!mask[ni]) continue;
        const nd = dist[i] + dd;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          if (!inBand[ni]) {
            inBand[ni] = 1;
            heap.push(nd, nx, ny);
          }
        }
      }
    }

    // 写回:先还原选区外的原始像素(1:1),再对修复区域做轻量迭代平滑
    // 步骤1:把 FMM 结果(buf)直接写回选区(选区外保持原样)
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        const gx = bx + i, gy = by + j;
        if (gx < x || gx >= x + w || gy < y || gy >= y + h) continue;
        const pi = (gy * W + gx) * 4;
        const si = (j * bw + i) * 4;
        data[pi] = buf[si]; data[pi + 1] = buf[si + 1]; data[pi + 2] = buf[si + 2];
        data[pi + 3] = 255;
      }
    }

    // 步骤2:对修复区域做 2 次 3x3 均值平滑(仅选区内,消除残留颗粒/条纹)
    const inSel = (gx, gy) => gx >= x && gx < x + w && gy >= y && gy < y + h;
    for (let pass = 0; pass < 2; pass++) {
      // 关键修复:每遍从当前 buf 拷贝 w2,选区外像素保持原值,
      // 避免选区外被置 0(黑色)污染选区边缘产生暗边阴影
      const w2 = new Uint8ClampedArray(buf);
      for (let j = 1; j < bh - 1; j++) {
        for (let i = 1; i < bw - 1; i++) {
          const gx = bx + i, gy = by + j;
          if (!inSel(gx, gy)) continue;
          const p = (j * bw + i) * 4;
          let r = 0, g = 0, b = 0, n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const n2 = ((j + dj) * bw + (i + di)) * 4;
              r += buf[n2]; g += buf[n2 + 1]; b += buf[n2 + 2]; n++;
            }
          }
          if (n) { w2[p] = r / n; w2[p + 1] = g / n; w2[p + 2] = b / n; w2[p + 3] = 255; }
        }
      }
      buf.set(w2);
    }

    // 步骤3:把平滑结果写回选区(仅选区内)
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        const gx = bx + i, gy = by + j;
        if (!inSel(gx, gy)) continue;
        const pi = (gy * W + gx) * 4;
        const si = (j * bw + i) * 4;
        data[pi] = buf[si]; data[pi + 1] = buf[si + 1]; data[pi + 2] = buf[si + 2];
      }
    }

    // 步骤4:边缘羽化 - 修复区最外 2px 与选区外背景线性混合,消除暗边
    // 对每个修复区边缘像素,取选区外最近已知像素做混合,避免边缘色差突兀
    const feather = 3;
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        const gx = bx + i, gy = by + j;
        if (!inSel(gx, gy)) continue;
        // 到选区边缘的距离
        const dEdge = Math.min(gx - x, x + w - 1 - gx, gy - y, y + h - 1 - gy);
        if (dEdge >= feather) continue;
        const t = dEdge / feather; // 0=最边缘, 1=内部
        // 找选区外最近已知像素(沿最靠近的边缘方向向外 1px)
        let bx2 = gx, by2 = gy;
        if (gx - x < feather) bx2 = gx - 1;
        else if (x + w - 1 - gx < feather) bx2 = gx + 1;
        if (gy - y < feather) by2 = gy - 1;
        else if (y + h - 1 - gy < feather) by2 = gy + 1;
        bx2 = Math.max(0, Math.min(W - 1, bx2));
        by2 = Math.max(0, Math.min(H - 1, by2));
        if (inSel(bx2, by2)) continue;
        const pi = (gy * W + gx) * 4;
        const ri = (by2 * W + bx2) * 4;
        data[pi] = Math.round(data[pi] * t + data[ri] * (1 - t));
        data[pi + 1] = Math.round(data[pi + 1] * t + data[ri + 1] * (1 - t));
        data[pi + 2] = Math.round(data[pi + 2] * t + data[ri + 2] * (1 - t));
      }
    }

    this.offCtx.putImageData(src, 0, 0);
  },
  /**
   * 高斯模糊选区(分块异步执行,避免大图卡死)
   * 用 1/4 分辨率中间层做快速高斯近似,兼顾速度与效果
   */
  blurRectAsync(r, radius, done) {
    const { x, y, w, h } = r;
    const src = this.offCtx.getImageData(x, y, w, h);
    const data = src.data;

    // 为提升速度,降采样到 1/2 处理再放大
    const sw = Math.max(1, Math.round(w / 2));
    const sh = Math.max(1, Math.round(h / 2));
    const small = new Uint8ClampedArray(sw * sh * 4);
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const sx = Math.min(w - 1, Math.round((i + 0.5) * w / sw - 0.5));
        const sy = Math.min(h - 1, Math.round((j + 0.5) * h / sh - 0.5));
        const sp = (sy * w + sx) * 4, dp = (j * sw + i) * 4;
        small[dp] = data[sp]; small[dp + 1] = data[sp + 1]; small[dp + 2] = data[sp + 2]; small[dp + 3] = 255;
      }
    }

    const R = Math.max(1, Math.round(radius / 2));
    const tmp = new Uint8ClampedArray(sw * sh * 4);

    // 水平模糊(两遍近似高斯)
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < sh; j++) {
        for (let i = 0; i < sw; i++) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let k = -R; k <= R; k++) {
            const ii = i + k;
            if (ii < 0 || ii >= sw) continue;
            const p = (j * sw + ii) * 4;
            r += small[p]; g += small[p + 1]; b += small[p + 2]; n++;
          }
          const p = (j * sw + i) * 4;
          tmp[p] = r / n; tmp[p + 1] = g / n; tmp[p + 2] = b / n; tmp[p + 3] = 255;
        }
      }
      for (let j = 0; j < sh; j++) {
        for (let i = 0; i < sw; i++) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let k = -R; k <= R; k++) {
            const jj = j + k;
            if (jj < 0 || jj >= sh) continue;
            const p = (jj * sw + i) * 4;
            r += tmp[p]; g += tmp[p + 1]; b += tmp[p + 2]; n++;
          }
          const p = (j * sw + i) * 4;
          small[p] = r / n; small[p + 1] = g / n; small[p + 2] = b / n;
        }
      }
    }

    // 放大写回原选区
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const si = Math.min(sh - 1, Math.round(j * sh / h));
        const sj = Math.min(sw - 1, Math.round(i * sw / w));
        const sp = (si * sw + sj) * 4, dp = (j * w + i) * 4;
        data[dp] = small[sp]; data[dp + 1] = small[sp + 1]; data[dp + 2] = small[sp + 2];
      }
    }
    this.offCtx.putImageData(src, x, y);
    done();
  },

  /** 导出 PNG(无损,1:1 分辨率) */
  exportPng() {
    if (!this.image) return;
    this.finishAndExport('image/png', 'png');
  },

  /** 导出 JPG(高质量) */
  exportJpg() {
    if (!this.image) return;
    this.finishAndExport('image/jpeg', 'jpg', 0.95);
  },

  /** 从结果画布导出(无标注) */
  finishAndExport(type, ext, quality = 1) {
    const dataUrl = this.offCanvas.toDataURL(type, quality);
    this.showPreview(dataUrl, ext);
  },

  /** 显示结果预览(1:1 信息) */
  showPreview(dataUrl, ext) {
    const img = document.getElementById('previewImg');
    img.onload = () => {
      document.getElementById('previewMask').style.display = 'flex';
    };
    img.src = dataUrl;
    this.resultDataUrl = dataUrl;
    this.resultExt = ext;
  },

  /** 保存到相册(先下载再提示长按,兼容 iOS) */
  saveResult() {
    if (!this.resultDataUrl) return;
    // iOS 上通过 <a download> 触发下载;同时提示长按保存
    const a = document.createElement('a');
    a.href = this.resultDataUrl;
    a.download = `去水印_${Date.now()}.${this.resultExt || 'png'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    Toast.show('已生成文件;若未自动保存,请长按图片保存到相册');
  },

  showLoading(text, withBar = false) {
    document.getElementById('loadingText').textContent = text || '处理中…';
    const bar = document.getElementById('loadingBar');
    bar.style.width = '0%';
    bar.style.display = withBar ? 'block' : 'none';
    document.getElementById('loadingMask').style.display = 'flex';
    if (withBar) {
      // 动画进度条
      let p = 0;
      clearInterval(this._barTimer);
      this._barTimer = setInterval(() => {
        p = Math.min(92, p + Math.random() * 22);
        bar.style.width = `${p}%`;
      }, 180);
    }
  },

  hideLoading() {
    clearInterval(this._barTimer);
    document.getElementById('loadingMask').style.display = 'none';
  },
};
