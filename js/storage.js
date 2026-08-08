/**
 * 存储层 —— 所有数据保存在手机本地 (localStorage)
 * 键名: wt_tasks / wt_events / wt_settings
 */
const Store = {
  KEY_TASKS: 'wt_tasks',
  KEY_EVENTS: 'wt_events',
  KEY_SETTINGS: 'wt_settings',

  load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('读取失败', key, e);
      return fallback;
    }
  },

  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('保存失败', key, e);
      return false;
    }
  },

  getTasks() { return this.load(this.KEY_TASKS, []); },
  setTasks(list) { return this.save(this.KEY_TASKS, list); },
  getEvents() { return this.load(this.KEY_EVENTS, []); },
  setEvents(list) { return this.save(this.KEY_EVENTS, list); },
  getSettings() { return this.load(this.KEY_SETTINGS, {}); },
  setSettings(s) { return this.save(this.KEY_SETTINGS, s); },
};

/** 通用工具 */
const Util = {
  uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /** 格式化为 YYYY-MM-DD(本地时区) */
  fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  todayStr() { return this.fmtDate(new Date()); },

  /** 解析 YYYY-MM-DD 为本地日期 */
  parseDate(s) {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  },

  /** 距离今天的天数(今天=0,明天=1,昨天=-1) */
  dayDiff(dateStr) {
    const t = this.parseDate(dateStr);
    if (!t) return null;
    const today = new Date();
    const a = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const b = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return Math.round((a - b) / 86400000);
  },

  weekName(d) {
    return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
  },

  /** 时间 HH:MM 转为显示(空返回全天) */
  timeText(t) {
    return t && t.length ? t : '全天';
  },

  escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

/** 轻量 Toast 提示 */
const Toast = {
  timer: null,
  show(msg, ms = 2200) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => el.classList.remove('show'), ms);
  },
};
