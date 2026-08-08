/**
 * 任务/待办模块
 * 数据: { id, title, priority: 'high'|'medium'|'low', due: 'YYYY-MM-DD'|'', note, done, createdAt }
 */
const Tasks = {
  list: [],
  filter: 'today', // today | all
  editingId: null,
  priMap: { high: '高', medium: '中', low: '低' },

  init() {
    this.list = Store.getTasks();
    this.bindUI();
    this.render();
  },

  bindUI() {
    // 筛选切换
    document.querySelectorAll('#taskFilter .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#taskFilter .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.filter;
        this.render();
      });
    });

    // 保存/取消
    document.getElementById('taskSave').addEventListener('click', () => this.saveFromSheet());
    document.getElementById('taskCancel').addEventListener('click', () => this.closeSheet());
    document.getElementById('taskMask').addEventListener('click', e => {
      if (e.target === e.currentTarget) this.closeSheet();
    });

    // 优先级选择
    document.querySelectorAll('#taskPriority .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#taskPriority .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  },

  /** 添加/编辑 */
  openSheet(task = null) {
    this.editingId = task ? task.id : null;
    document.getElementById('taskSheetTitle').textContent = task ? '编辑任务' : '添加任务';
    document.getElementById('taskTitle').value = task ? task.title : '';
    document.getElementById('taskDue').value = task && task.due ? task.due : '';
    document.getElementById('taskNote').value = task && task.note ? task.note : '';
    const p = (task && task.priority) || 'medium';
    document.querySelectorAll('#taskPriority .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.p === p);
    });
    document.getElementById('taskMask').style.display = 'flex';
    setTimeout(() => document.getElementById('taskTitle').focus(), 60);
  },

  closeSheet() {
    document.getElementById('taskMask').style.display = 'none';
    this.editingId = null;
  },

  saveFromSheet() {
    const title = document.getElementById('taskTitle').value.trim();
    if (!title) {
      Toast.show('请输入任务名称');
      return;
    }
    const due = document.getElementById('taskDue').value || '';
    const note = document.getElementById('taskNote').value.trim();
    const priority = document.querySelector('#taskPriority .seg-btn.active').dataset.p;

    if (this.editingId) {
      const t = this.list.find(x => x.id === this.editingId);
      if (t) { Object.assign(t, { title, due, note, priority }); }
    } else {
      this.list.unshift({
        id: Util.uid(),
        title, priority, due, note,
        done: false,
        createdAt: Date.now(),
      });
    }
    this.persist();
    this.closeSheet();
    this.render();
    App.refreshCalendarIfActive();
    Toast.show(isEdit ? '任务已更新' : '任务已添加');
  },

  toggle(id) {
    const t = this.list.find(x => x.id === id);
    if (!t) return;
    t.done = !t.done;
    this.persist();
    this.render();
    App.refreshCalendarIfActive();
  },

  remove(id) {
    this.list = this.list.filter(x => x.id !== id);
    this.persist();
    this.render();
    App.refreshCalendarIfActive();
    Toast.show('任务已删除');
  },

  persist() {
    Store.setTasks(this.list);
  },

  getFiltered() {
    if (this.filter === 'all') return [...this.list];
    const today = Util.todayStr();
    return this.list.filter(t => !t.done && (!t.due || t.due === today));
  },

  /** 渲染任务列表 + 今日卡片 */
  render() {
    const container = document.getElementById('taskList');
    const items = this.getFiltered();

    // 排序: 未完成在前,按优先级(高>中>低)、截止日期
    const priWeight = { high: 0, medium: 1, low: 2 };
    const sorted = [...items].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (priWeight[a.priority] !== priWeight[b.priority]) return priWeight[a.priority] - priWeight[b.priority];
      if ((a.due || '') !== (b.due || '')) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
      return b.createdAt - a.createdAt;
    });

    if (!sorted.length) {
      container.innerHTML = '';
      document.getElementById('taskEmpty').style.display = 'block';
    } else {
      document.getElementById('taskEmpty').style.display = 'none';
      container.innerHTML = sorted.map(t => this.itemHtml(t)).join('');
      // 绑定事件
      container.querySelectorAll('.task-check').forEach(el => {
        el.addEventListener('click', () => this.toggle(el.dataset.id));
      });
      container.querySelectorAll('.task-item .task-main').forEach(el => {
        el.addEventListener('click', () => this.openSheet(this.list.find(t => t.id === el.dataset.id)));
      });
      container.querySelectorAll('.task-del').forEach(el => {
        el.addEventListener('click', () => this.remove(el.dataset.id));
      });
    }

    this.renderTodayCard();
  },

  itemHtml(t) {
    const dueText = this.dueText(t.due);
    return `
      <div class="task-item ${t.done ? 'done' : ''}">
        <div class="task-check" data-id="${t.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
        </div>
        <div class="task-main" data-id="${t.id}">
          <div class="task-title">${Util.escapeHtml(t.title)}</div>
          <div class="task-meta">
            <span class="pri-tag pri-${t.priority}">${this.priMap[t.priority] || '中'}</span>
            ${dueText ? `<span class="due-tag ${t.due && !t.done && Util.dayDiff(t.due) < 0 ? 'overdue' : ''}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              ${dueText}</span>` : ''}
          </div>
          ${t.note ? `<div class="task-note">${Util.escapeHtml(t.note)}</div>` : ''}
        </div>
        <button class="task-del" data-id="${t.id}" title="删除">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>`;
  },

  dueText(due) {
    if (!due) return '';
    const diff = Util.dayDiff(due);
    if (diff === null) return due;
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    if (diff < -1) return `${due} 已逾期`;
    const d = Util.parseDate(due);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  },

  /** 今日卡片: 进度 + 鼓励语 */
  renderTodayCard() {
    const today = Util.todayStr();
    const todayTasks = this.list.filter(t => !t.done && t.due === today);
    const allToday = this.list.filter(t => t.due === today);
    const done = allToday.filter(t => t.done).length;
    const total = allToday.length;

    document.getElementById('todayWeek').textContent = Util.weekName(new Date());
    const d = new Date();
    document.getElementById('todayDate').textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
    document.getElementById('todayProgressNum').textContent = `${done}/${total}`;
    document.getElementById('todayProgressFill').style.width = total ? `${Math.round(done / total * 100)}%` : '0%';

    let tip;
    if (!total) tip = '今天没有任务,轻松的一天 ☕';
    else if (done === total) tip = '今日任务全部完成,太棒了!🎉';
    else if (done > 0) tip = `已完成 ${done} 项,还剩 ${total - done} 项,继续加油 💪`;
    else tip = `今日共 ${total} 项待办,开始行动吧 🚀`;
    document.getElementById('todayTip').textContent = tip;
  },
};
