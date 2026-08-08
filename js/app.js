/**
 * 主控制器 —— 视图切换、悬浮按钮、初始化
 */
const App = {
  views: ['tasks', 'calendar', 'watermark'],
  current: 'tasks',

  init() {
    // 初始化三个模块
    Tasks.init();
    Calendar.init();
    Watermark.init();

    this.bindUI();
    this.renderSubtitle();
    this.setupSW();
  },

  bindUI() {
    // 底部导航切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    // 悬浮按钮
    const fab = document.getElementById('fab');
    fab.addEventListener('click', () => {
      if (this.current === 'tasks') Tasks.openSheet();
      else if (this.current === 'calendar') Calendar.openSheet();
      else {
        // 去水印页:若有图则无操作;否则唤起选图
        if (!Watermark.image) document.getElementById('fileInput').click();
        else fab.classList.add('pulse');
      }
    });

    // 窗口尺寸变化重排画布
    window.addEventListener('resize', () => {
      if (this.current === 'watermark' && Watermark.image) Watermark.layoutCanvas();
    });
  },

  switchView(name) {
    if (!this.views.includes(name)) return;
    this.current = name;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${name}`).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    this.renderSubtitle();
    // 切到日历/去水印时刷新
    if (name === 'calendar') Calendar.render();
    if (name === 'watermark' && Watermark.image) setTimeout(() => Watermark.layoutCanvas(), 50);
  },

  renderSubtitle() {
    const title = document.getElementById('pageTitle');
    const sub = document.getElementById('pageSubtitle');
    const headerBtn = document.getElementById('headerBtn');
    if (this.current === 'tasks') {
      title.textContent = '任务';
      sub.textContent = '管理你的待办清单';
      headerBtn.style.display = 'none';
      document.getElementById('fab').style.display = 'flex';
    } else if (this.current === 'calendar') {
      title.textContent = '日程';
      sub.textContent = '规划每一天';
      headerBtn.style.display = 'none';
      document.getElementById('fab').style.display = 'flex';
    } else {
      title.textContent = '去水印';
      sub.textContent = '本地处理 · 1:1 无损';
      headerBtn.style.display = 'none';
      document.getElementById('fab').style.display = 'none';
    }
  },

  /** 日程变化后,若当前在日历视图则重绘 */
  refreshCalendarIfActive() {
    if (this.current === 'calendar') Calendar.render();
  },

  setupSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => {
          console.warn('ServiceWorker 注册失败(不影响使用)', err);
        });
      });
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
