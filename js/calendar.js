/**
 * 日程安排模块
 * 数据: { id, title, date: 'YYYY-MM-DD', start, end, category: 'work'|'life'|'personal', note }
 */
const Calendar = {
  events: [],
  viewYear: null,   // 当前展示的年
  viewMonth: null,  // 0-11
  selectedDate: null, // 'YYYY-MM-DD'
  editingId: null,
  catMap: { work: '💼 工作', life: '🏠 生活', personal: '🧘 个人' },
  catColor: { work: 'c-work', life: 'c-life', personal: 'c-personal' },

  init() {
    this.events = Store.getEvents();
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.selectedDate = Util.todayStr();
    this.bindUI();
    this.render();
  },

  bindUI() {
    document.getElementById('calPrev').addEventListener('click', () => this.shiftMonth(-1));
    document.getElementById('calNext').addEventListener('click', () => this.shiftMonth(1));
    document.getElementById('addEventBtn').addEventListener('click', () => this.openSheet());

    document.getElementById('eventSave').addEventListener('click', () => this.saveFromSheet());
    document.getElementById('eventCancel').addEventListener('click', () => this.closeSheet());
    document.getElementById('eventDelete').addEventListener('click', () => this.deleteEditing());
    document.getElementById('eventMask').addEventListener('click', e => {
      if (e.target === e.currentTarget) this.closeSheet();
    });

    document.querySelectorAll('#eventCategory .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#eventCategory .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  },

  shiftMonth(delta) {
    let m = this.viewMonth + delta;
    let y = this.viewYear;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    this.viewYear = y;
    this.viewMonth = m;
    this.render();
  },

  eventsOn(date) {
    return this.events.filter(e => e.date === date);
  },

  tasksOn(date) {
    return Tasks.list.filter(t => t.due === date && !t.done);
  },

  /** 渲染月历 + 选中日面板 */
  render() {
    this.renderGrid();
    this.renderDayPanel();
  },

  renderGrid() {
    document.getElementById('calTitle').textContent = `${this.viewYear}年${this.viewMonth + 1}月`;
    const grid = document.getElementById('calGrid');
    const first = new Date(this.viewYear, this.viewMonth, 1);
    const startWeekday = first.getDay(); // 0=周日
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();
    const prevDays = new Date(this.viewYear, this.viewMonth, 0).getDate();
    const today = Util.todayStr();

    let html = '';
    // 上月补位
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = prevDays - i;
      const ds = Util.fmtDate(new Date(this.viewYear, this.viewMonth - 1, d));
      html += this.dayCellHtml(d, ds, true, today);
    }
    // 本月
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = Util.fmtDate(new Date(this.viewYear, this.viewMonth, d));
      html += this.dayCellHtml(d, ds, false, today);
    }
    // 下月补位(补满到 42 格,保证行高一致)
    let nextDay = 1;
    let cells = startWeekday + daysInMonth;
    while (cells % 7 !== 0) {
      const ds = Util.fmtDate(new Date(this.viewYear, this.viewMonth + 1, nextDay));
      html += this.dayCellHtml(nextDay, ds, true, today);
      nextDay++; cells++;
    }
    grid.innerHTML = html;

    // 绑定点击
    grid.querySelectorAll('.cal-day').forEach(el => {
      el.addEventListener('click', () => {
        this.selectedDate = el.dataset.date;
        this.renderGrid();
        this.renderDayPanel();
      });
    });
  },

  dayCellHtml(dayNum, dateStr, dim, today) {
    const evs = this.eventsOn(dateStr);
    const tasks = this.tasksOn(dateStr);
    // 去重分类圆点
    const catSet = new Set(evs.map(e => e.category));
    const dotHtml = [...catSet].map(c => `<span class="cal-dot ${this.catColor[c]}"></span>`).join('')
      + (tasks.length ? '<span class="cal-dot t-task"></span>' : '');
    const isToday = dateStr === today;
    const isSelected = dateStr === this.selectedDate;
    return `
      <div class="cal-day ${dim ? 'dim' : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}"
           data-date="${dateStr}">
        <span class="cal-day-num">${dayNum}</span>
        <span class="cal-dots">${dotHtml}</span>
      </div>`;
  },

  renderDayPanel() {
    const date = this.selectedDate || Util.todayStr();
    const d = Util.parseDate(date);
    const events = this.eventsOn(date).sort((a, b) => (a.start || '99') < (b.start || '99') ? -1 : 1);
    const tasks = this.tasksOn(date);

    const title = Util.todayStr() === date
      ? `今天 · ${d.getMonth() + 1}月${d.getDate()}日`
      : Util.weekName(d) + ` · ${d.getMonth() + 1}月${d.getDate()}日`;
    document.getElementById('dayPanelTitle').textContent = title;

    // 任务行
    const todoLine = document.getElementById('dayTodoLine');
    if (tasks.length) {
      todoLine.style.display = 'flex';
      todoLine.innerHTML = `📋 待办任务 ${tasks.length} 项:${tasks.slice(0, 3).map(t => ` <strong>${Util.escapeHtml(t.title)}</strong>`).join('、')}${tasks.length > 3 ? ' 等' : ''}`;
    } else {
      todoLine.style.display = 'none';
    }

    // 事件列表
    const list = document.getElementById('eventList');
    if (!events.length) {
      list.innerHTML = '';
      document.getElementById('eventEmpty').style.display = 'block';
    } else {
      document.getElementById('eventEmpty').style.display = 'none';
      list.innerHTML = events.map(e => this.eventHtml(e)).join('');
      list.querySelectorAll('.event-item .event-body').forEach(el => {
        el.addEventListener('click', () => this.openSheet(this.events.find(x => x.id === el.dataset.id)));
      });
      list.querySelectorAll('.event-del').forEach(el => {
        el.addEventListener('click', () => this.removeEvent(el.dataset.id));
      });
    }
  },

  eventHtml(e) {
    const time = e.start || e.end ? `${Util.timeText(e.start)} - ${Util.timeText(e.end)}` : '全天';
    return `
      <div class="event-item ${this.catColor[e.category] || 'c-work'}">
        <div class="event-time">${time}</div>
        <div class="event-body" data-id="${e.id}">
          <div class="event-title">${Util.escapeHtml(e.title)}</div>
          ${e.note ? `<div class="event-note">${Util.escapeHtml(e.note)}</div>` : ''}
          <span class="event-cat-tag" style="background:var(--primary-soft);color:var(--primary-2)">${this.catMap[e.category] || '📌'}</span>
        </div>
        <button class="event-del" data-id="${e.id}" title="删除">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>`;
  },

  openSheet(event = null) {
    this.editingId = event ? event.id : null;
    document.getElementById('eventSheetTitle').textContent = event ? '编辑日程' : '添加日程';
    document.getElementById('eventTitle').value = event ? event.title : '';
    document.getElementById('eventDate').value = event ? event.date : (this.selectedDate || Util.todayStr());
    document.getElementById('eventStart').value = event && event.start ? event.start : '';
    document.getElementById('eventEnd').value = event && event.end ? event.end : '';
    document.getElementById('eventNote').value = event && event.note ? event.note : '';
    const c = (event && event.category) || 'work';
    document.querySelectorAll('#eventCategory .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.c === c);
    });
    document.getElementById('eventDelete').style.display = event ? 'block' : 'none';
    document.getElementById('eventMask').style.display = 'flex';
    setTimeout(() => document.getElementById('eventTitle').focus(), 60);
  },

  closeSheet() {
    document.getElementById('eventMask').style.display = 'none';
    this.editingId = null;
  },

  saveFromSheet() {
    const title = document.getElementById('eventTitle').value.trim();
    if (!title) { Toast.show('请输入日程标题'); return; }
    const date = document.getElementById('eventDate').value;
    if (!date) { Toast.show('请选择日期'); return; }
    const start = document.getElementById('eventStart').value;
    const end = document.getElementById('eventEnd').value;
    if (start && end && start >= end) { Toast.show('结束时间需晚于开始时间'); return; }
    const note = document.getElementById('eventNote').value.trim();
    const category = document.querySelector('#eventCategory .seg-btn.active').dataset.c;

    if (this.editingId) {
      const e = this.events.find(x => x.id === this.editingId);
      if (e) Object.assign(e, { title, date, start, end, note, category });
    } else {
      this.events.push({ id: Util.uid(), title, date, start, end, note, category });
    }
    this.persist();
    this.closeSheet();
    // 若事件日期在当月外,跳到该月
    const d = Util.parseDate(date);
    if (d.getFullYear() !== this.viewYear || d.getMonth() !== this.viewMonth) {
      this.viewYear = d.getFullYear();
      this.viewMonth = d.getMonth();
    }
    this.selectedDate = date;
    this.render();
    Toast.show(isEdit ? '日程已更新' : '日程已添加');
  },

  removeEvent(id) {
    this.events = this.events.filter(x => x.id !== id);
    this.persist();
    this.render();
    Toast.show('日程已删除');
  },

  deleteEditing() {
    if (this.editingId) this.removeEvent(this.editingId);
    this.closeSheet();
  },

  persist() {
    Store.setEvents(this.events);
  },
};
