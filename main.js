const {
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  setIcon,
  TFile,
} = require("obsidian");

const VIEW_TYPE = "planning-board-notes-view";
const TASK_FOLDER = "Planning Board/Tasks";
const GROUP_FOLDER = "Planning Board/Groups";
const STATUSES = ["未着手", "進行中", "保留", "完了"];
const TYPES = ["やること", "決めること", "確認すること"];

function statusClass(status) {
  return {
    未着手: "pending",
    進行中: "doing",
    完了: "done",
    保留: "hold",
  }[status] || "pending";
}

function typeClass(type) {
  return {
    やること: "todo",
    決めること: "decision",
    確認すること: "check",
  }[type] || "todo";
}

function typeLabel(type) {
  return {
    やること: "やる",
    決めること: "決める",
    確認すること: "確認",
  }[type] || type || "やる";
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(safeValue(value));
}

function safeValue(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isBlankDue(value) {
  const due = safeValue(value).trim();
  return !due || due === "時期未定";
}

function dueTime(value) {
  if (isBlankDue(value)) return Number.POSITIVE_INFINITY;
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatDateJa(value) {
  if (!isIsoDate(value)) return value || "期限未定";
  const date = new Date(`${value}T00:00:00`);
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${weekdays[date.getDay()]}）`;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfWeek(value) {
  const date = new Date(`${value}T00:00:00`);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
}

function monthKeyFromTask(task) {
  return isIsoDate(task.due) ? task.due.slice(0, 7) : "";
}

function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function getFrontmatter(app, file) {
  return app.metadataCache.getFileCache(file)?.frontmatter || {};
}

class PlanningBoardNotesPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ collapsedGroups: {} }, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new PlanningBoardView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "Planning Board Notes", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-planning-board-notes",
      name: "Open Planning Board Notes",
      callback: () => this.activateView(),
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
          leaf.view?.render?.();
        });
      })
    );
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = leaves[0] || this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async setGroupCollapsed(key, collapsed) {
    this.settings.collapsedGroups[key] = collapsed === true;
    await this.saveData(this.settings);
  }
}

class PlanningBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.showArchivedGroups = false;
    this.activeTypes = new Set();
    this.activeStatuses = new Set();
    this.taskArchiveSelectionGroupKey = null;
    this.taskArchiveSelectionMode = null;
    this.selectedTaskArchiveKeys = new Set();
    this.currentView = "deadline";
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Planning Board";
  }

  getIcon() {
    return "layout-dashboard";
  }

  async onOpen() {
    this.containerEl.addClass("planning-board-notes-root");
    this.contentEl.addEventListener("click", (event) => this.handleClick(event));
    this.contentEl.addEventListener("change", (event) => this.handleChange(event));
    this.contentEl.addEventListener("keydown", (event) => this.handleKeydown(event));
    await this.render();
  }

  async render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("planning-board-notes");
    const { groups, tasks } = this.loadModels();
    const unfilteredGroups = this.visibleGroupModels(groups, tasks);
    const filteredGroups = unfilteredGroups
      .map((group) => ({ ...group, tasks: this.filterTasks(group.tasks) }))
      .filter((group) => group.tasks.length > 0);
    const unfilteredTasks = unfilteredGroups.flatMap((group) => group.tasks);
    const visibleTasks = filteredGroups.flatMap((group) => group.tasks);
    this.renderHeader(root, tasks, visibleTasks);
    this.renderTodayContext(root, unfilteredTasks);
    if (this.currentView === "month") {
      this.renderMonth(root, visibleTasks);
    } else if (this.currentView === "week") {
      this.renderWeek(root, visibleTasks);
    } else {
      this.renderDeadline(root, filteredGroups);
    }
  }

  loadModels() {
    const files = this.app.vault.getMarkdownFiles();
    const groupFiles = files.filter((file) => file.path.startsWith(`${GROUP_FOLDER}/`));
    const taskFiles = files.filter((file) => file.path.startsWith(`${TASK_FOLDER}/`));
    const groups = groupFiles.map((file) => {
      const fm = getFrontmatter(this.app, file);
      return {
        file,
        title: safeValue(fm.title || file.basename),
        period: safeValue(fm.period, "時期未定"),
        window: safeValue(fm.window, ""),
        note: safeValue(fm.note, ""),
        archived: fm.archived === true,
        order: Number(fm.order || 9999),
        memoLabel: safeValue(fm.memo_label, ""),
      };
    });
    const tasks = taskFiles.map((file) => {
      const fm = getFrontmatter(this.app, file);
      return {
        file,
        title: safeValue(fm.title || file.basename),
        group: safeValue(fm.group, "未分類"),
        type: safeValue(fm.type, "やること"),
        status: safeValue(fm.status, "未着手"),
        incompleteStatus: safeValue(fm.incompleteStatus, "未着手"),
        due: safeValue(fm.due, ""),
        text: safeValue(fm.summary || fm.text, ""),
        source: safeValue(fm.source, ""),
        archived: fm.archived === true,
        order: Number(fm.order || 9999),
        groupOrder: Number(fm.group_order || 9999),
      };
    });
    groups.sort((a, b) => a.order - b.order || dueTime(a.period) - dueTime(b.period));
    tasks.sort((a, b) => a.groupOrder - b.groupOrder || dueTime(a.due) - dueTime(b.due) || a.order - b.order);
    return { groups, tasks };
  }

  groupStateKey(group) {
    return `deadline-group::${group.period || "undated"}::${group.title}`;
  }

  groupArchiveKey(group) {
    return `archive-group::${group.period || "undated"}::${group.title}`;
  }

  taskKey(task) {
    return `${task.due || "undated"}::${task.title}`;
  }

  taskArchiveKey(group, task) {
    return `archive-task::${group.period || "undated"}::${group.title}::${this.taskKey(task)}`;
  }

  isGroupCollapsed(group) {
    return this.plugin.settings?.collapsedGroups?.[this.groupStateKey(group)] === true;
  }

  displayStatus(task) {
    if (task.status === "完了") return "完了";
    return task.status || "未着手";
  }

  isTaskComplete(task) {
    return this.displayStatus(task) === "完了";
  }

  isDueToday(task) {
    return task.due === todayIso();
  }

  isOverdue(task) {
    return isIsoDate(task.due) && task.due < todayIso() && !this.isTaskComplete(task);
  }

  filterTasks(tasks) {
    return tasks.filter((task) => {
      const typeMatch = this.activeTypes.size === 0 || this.activeTypes.has(task.type);
      const statusMatch = this.activeStatuses.size === 0 || this.activeStatuses.has(this.displayStatus(task));
      return typeMatch && statusMatch;
    });
  }

  taskWithGroup(group, task) {
    return {
      ...task,
      groupWindow: group.window,
      groupTitle: group.title,
      groupArchiveKey: this.groupArchiveKey(group),
      archiveKey: this.taskArchiveKey(group, task),
      groupArchived: group.archived === true,
    };
  }

  visibleGroupModels(groups, allTasks) {
    const byTitle = new Map(groups.map((group) => [group.title, { ...group, allTasks: [] }]));
    allTasks.forEach((task) => {
      if (!byTitle.has(task.group)) {
        byTitle.set(task.group, {
          title: task.group,
          period: "時期未定",
          window: "",
          note: "",
          archived: false,
          order: task.groupOrder,
          allTasks: [],
        });
      }
      byTitle.get(task.group).allTasks.push(task);
    });
    return [...byTitle.values()]
      .map((group) => {
        const allGroupTasks = group.allTasks.map((task) => this.taskWithGroup(group, task));
        const archivedTasks = allGroupTasks.filter((task) => task.archived);
        const activeTasks = allGroupTasks.filter((task) => !task.archived);
        const tasks = this.showArchivedGroups
          ? group.archived
            ? allGroupTasks
            : archivedTasks
          : group.archived
            ? []
            : activeTasks;
        return {
          ...group,
          tasks,
          archivedTaskCount: archivedTasks.length,
          totalTaskCount: allGroupTasks.length,
        };
      })
      .filter((group) => group.tasks.length > 0)
      .sort((a, b) => a.order - b.order || dueTime(a.period) - dueTime(b.period));
  }

  clearTaskArchiveSelection() {
    this.taskArchiveSelectionGroupKey = null;
    this.taskArchiveSelectionMode = null;
    this.selectedTaskArchiveKeys = new Set();
  }

  renderHeader(root, tasks, visibleTasks) {
    const header = root.createDiv({ cls: "planning-board-header" });
    const heading = header.createDiv({ cls: "planning-board-heading" });
    heading.createEl("h2", { text: "Planning Board" });
    const done = visibleTasks.filter((task) => this.isTaskComplete(task)).length;
    heading.createEl("p", {
      text: this.showArchivedGroups
        ? `アーカイブ ${visibleTasks.length}件を表示、完了 ${done}件`
        : `${visibleTasks.length}/${tasks.length}件を表示、表示中の完了 ${done}件`,
    });
    const views = root.createDiv({ cls: "action-view-tabs", attr: { role: "tablist", "aria-label": "表示切替" } });
    [
      ["deadline", "期限カード"],
      ["month", "月表示"],
      ["week", "週表示"],
    ].forEach(([view, label]) => {
      const active = this.currentView === view;
      const button = views.createEl("button", {
        cls: `action-view-button${active ? " is-active" : ""}`,
        text: label,
        attr: { type: "button", role: "tab", "aria-selected": String(active) },
      });
      button.addEventListener("click", () => {
        this.currentView = view;
        this.clearTaskArchiveSelection();
        this.render();
      });
    });
    const filters = root.createDiv({ cls: "action-type-filter-list" });
    TYPES.forEach((type) => this.filterButton(filters, typeLabel(type), this.activeTypes.has(type), "type", type));
    STATUSES.forEach((status) => this.filterButton(filters, status, this.activeStatuses.has(status), "status", status));
    const archive = filters.createEl("button", {
      cls: `action-type-filter action-archive-filter${this.showArchivedGroups ? " is-active" : ""}`,
      attr: { "aria-pressed": String(this.showArchivedGroups), "data-archive-filter": "true" },
    });
    const archiveIcon = archive.createSpan({ cls: "archive-filter-icon", attr: { "aria-hidden": "true" } });
    setIcon(archiveIcon, "archive");
    archive.createSpan({ text: this.showArchivedGroups ? "通常表示" : "アーカイブ" });
    archive.addEventListener("click", () => {
      this.clearTaskArchiveSelection();
      this.showArchivedGroups = !this.showArchivedGroups;
      this.render();
    });
  }

  renderTodayContext(root, tasks) {
    const today = todayIso();
    const todayTasks = tasks.filter((task) => task.due === today);
    const overdueTasks = tasks.filter((task) => this.isOverdue(task));
    const nextTask = tasks
      .filter((task) => isIsoDate(task.due) && task.due > today && !this.isTaskComplete(task))
      .sort((a, b) => a.due.localeCompare(b.due))[0];
    const context = root.createDiv({ cls: "today-context", attr: { "aria-live": "polite" } });
    context.innerHTML = `
      <div>
        <span class="today-context-label">本日</span>
        <strong>${formatDateJa(today)}</strong>
      </div>
      <div class="today-context-meta">
        <span>本日 ${todayTasks.length}件</span>
        <span>期限超過 ${overdueTasks.length}件</span>
        ${nextTask ? `<span>次: ${nextTask.due}</span>` : ""}
      </div>
    `;
  }

  filterButton(parent, label, active, kind, value) {
    const button = parent.createEl("button", {
      cls: `action-type-filter${active ? " is-active" : ""}`,
      text: label,
      attr: { "aria-pressed": String(active) },
    });
    button.addEventListener("click", () => {
      this.clearTaskArchiveSelection();
      const set = kind === "type" ? this.activeTypes : this.activeStatuses;
      if (set.has(value)) set.delete(value);
      else set.add(value);
      this.render();
    });
  }

  progressSummary(tasks, label) {
    const total = tasks.length;
    const complete = tasks.filter((task) => this.isTaskComplete(task)).length;
    const percent = total === 0 ? 0 : Math.round((complete / total) * 100);
    return `
      <div class="progress-summary" aria-label="${label}の進捗 ${complete}/${total}">
        <div class="progress-track" aria-hidden="true"><span style="width: ${percent}%"></span></div>
        <span class="progress-count">${complete}/${total}</span>
      </div>
    `;
  }

  groupArchiveButton(group) {
    const archiveKey = this.groupArchiveKey(group);
    const selecting = this.taskArchiveSelectionGroupKey === archiveKey;
    const hasArchivedTasks = group.archivedTaskCount > 0;
    const canSelectTasks = !group.archived && (!this.showArchivedGroups || hasArchivedTasks);
    return `
      <details class="group-archive-settings${group.archived || this.showArchivedGroups ? " is-archived" : ""}" data-group-archive-menu${selecting ? " open" : ""}>
        <summary aria-label="${group.title}のアーカイブ操作" title="アーカイブ">
          <svg class="archive-action-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="20" height="5" x="2" y="3" rx="1"></rect>
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path>
            <path d="M10 12h4"></path>
          </svg>
        </summary>
        <div class="group-archive-menu">
          <button type="button" data-group-archive-all>${group.archived ? "全体解除" : "全体"}</button>
          ${canSelectTasks ? `<button type="button" data-task-archive-start data-task-archive-mode="${this.showArchivedGroups ? "restore" : "archive"}">選択</button>` : ""}
        </div>
      </details>
    `;
  }

  archiveSelectionPanel(group) {
    const active = this.taskArchiveSelectionGroupKey === this.groupArchiveKey(group);
    if (!active) return "";
    const selectedCount = this.selectedTaskArchiveKeys.size;
    const isRestore = this.taskArchiveSelectionMode === "restore";
    return `
      <div class="archive-selection-panel" role="status">
        <span>${isRestore ? "戻す項目を選択" : "アーカイブする項目を選択"}</span>
        <strong>${selectedCount}件選択</strong>
        <button type="button" data-task-archive-commit ${selectedCount === 0 ? "disabled" : ""}>${isRestore ? "戻す" : "アーカイブ"}</button>
        <button type="button" data-task-archive-cancel>キャンセル</button>
      </div>
    `;
  }

  renderDeadline(root, groups) {
    const board = root.createDiv({ cls: "action-board-view action-deadline-view", attr: { id: "generic-board-view" } });
    board.innerHTML = groups.length
      ? groups.map((group) => this.groupHtml(group)).join("")
      : `<div class="action-empty-state">${this.showArchivedGroups ? "アーカイブ済みの項目はありません。" : "選択した種別のタスクはありません。"}</div>`;
    this.renderIcons(board);
  }

  renderMonth(root, tasks) {
    const board = root.createDiv({ cls: "action-board-view action-month-view", attr: { id: "generic-board-view" } });
    const datedTasks = tasks.filter((task) => isIsoDate(task.due));
    const monthKeys = [...new Set(datedTasks.map(monthKeyFromTask))].filter(Boolean).sort();
    board.innerHTML = monthKeys.length
      ? monthKeys.map((monthKey) => this.calendarMonthHtml(monthKey, datedTasks)).join("")
      : '<div class="action-empty-state">期限付きのタスクはありません。</div>';
  }

  scrollMonthToTask(filePath) {
    if (this.currentView !== "month") return;
    requestAnimationFrame(() => {
      const target = [...this.contentEl.querySelectorAll("[data-calendar-task]")].find((button) => button.dataset.calendarTask === filePath);
      target?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    });
  }

  calendarMonthHtml(monthKey, tasks) {
    const [year, month] = monthKey.split("-").map(Number);
    const dayCount = new Date(year, month, 0).getDate();
    const firstDay = new Date(year, month - 1, 1);
    const leadingBlanks = (firstDay.getDay() + 6) % 7;
    const monthTasks = tasks.filter((task) => monthKeyFromTask(task) === monthKey);
    const cells = [
      ...Array.from({ length: leadingBlanks }, () => '<article class="calendar-day is-empty" aria-hidden="true"></article>'),
      ...Array.from({ length: dayCount }, (_, index) => {
        const day = index + 1;
        const date = `${monthKey}-${String(day).padStart(2, "0")}`;
        const dayTasks = monthTasks.filter((task) => task.due === date);
        const isToday = date === todayIso();
        return `
          <article class="calendar-day${isToday ? " is-today" : ""}" aria-label="${formatDateJa(date)} ${dayTasks.length}件">
            <div class="calendar-day-head">
              <strong>${day}</strong>
              ${isToday ? '<span class="calendar-today-label">今日</span>' : ""}
            </div>
            <div class="calendar-day-items">
              ${dayTasks
                .map((task) => `<button class="calendar-task-pill action-type-${typeClass(task.type)}${this.isTaskComplete(task) ? " is-complete" : ""}" type="button" data-calendar-task="${task.file.path}" title="${task.title}">${task.title}</button>`)
                .join("")}
            </div>
          </article>
        `;
      }),
    ];
    return `
      <section class="calendar-panel">
        <div class="calendar-head">
          <div>
            <h3>${year}年${month}月</h3>
          </div>
          <div class="calendar-head-meta">
            <span>${monthTasks.length}件</span>
            ${this.progressSummary(monthTasks, `${year}年${month}月`)}
          </div>
        </div>
        <div class="calendar-weekdays" aria-hidden="true">
          ${["月", "火", "水", "木", "金", "土", "日"].map((day) => `<span>${day}</span>`).join("")}
        </div>
        <div class="calendar-grid">${cells.join("")}</div>
      </section>
    `;
  }

  renderWeek(root, tasks) {
    const board = root.createDiv({ cls: "action-board-view action-week-view", attr: { id: "generic-board-view" } });
    const datedTasks = tasks.filter((task) => isIsoDate(task.due));
    const undatedTasks = tasks.filter((task) => !isIsoDate(task.due));
    const weeks = new Map();
    datedTasks.forEach((task) => {
      const key = startOfWeek(task.due);
      if (!weeks.has(key)) weeks.set(key, []);
      weeks.get(key).push(task);
    });
    const lanes = [...weeks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([start, laneTasks]) => ({
        title: `${formatDateJa(start).replace(/（.）$/, "")}週`,
        note: `${start} - ${addDays(start, 6)}`,
        tasks: laneTasks.sort((a, b) => dueTime(a.due) - dueTime(b.due)),
      }));
    if (undatedTasks.length > 0) {
      lanes.push({ title: "時期未定", note: "期限なし", tasks: undatedTasks });
    }
    board.innerHTML = lanes.length
      ? lanes
        .map(
          (lane) => `
            <section class="week-lane">
              <div class="week-lane-head">
                <div>
                  <span class="mini-label">${lane.title}</span>
                  <strong>${lane.note}</strong>
                </div>
                <div class="week-lane-meta">
                  ${this.progressSummary(lane.tasks, lane.title)}
                </div>
              </div>
              <div class="week-lane-stack">
                ${lane.tasks.map((task) => this.taskCard(task)).join("")}
              </div>
            </section>
          `
        )
        .join("")
      : '<div class="action-empty-state">表示するタスクはありません。</div>';
  }

  renderIcons(root) {
    root.querySelectorAll("[data-collapse-icon]").forEach((icon) => {
      setIcon(icon, icon.dataset.collapseIcon);
    });
  }

  groupHtml(group) {
    const collapsed = this.isGroupCollapsed(group);
    const stateKey = this.groupStateKey(group);
    const archiveKey = this.groupArchiveKey(group);
    return `
      <section class="deadline-group${collapsed ? " is-collapsed" : ""}${group.archived ? " is-archived" : ""}" data-group-state-key="${stateKey}" data-group-archive-key="${archiveKey}">
        <div class="deadline-group-head">
          <div>
            <span class="mini-label">${group.window || group.period || "時期未定"}</span>
            <h3 title="${group.title}">${group.title}</h3>
          </div>
          <div class="deadline-head-meta">
            ${this.progressSummary(group.tasks, group.title)}
            ${this.groupArchiveButton(group)}
            <button class="group-collapse-toggle" type="button" data-group-collapse aria-expanded="${!collapsed}" aria-label="${group.title}のタスク一覧を${collapsed ? "表示" : "非表示"}">
              <span class="group-collapse-icon" data-collapse-icon="${collapsed ? "chevron-down" : "chevron-up"}" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <p>${group.note || ""} ${group.file ? `<button class="group-memo-button" type="button" data-group-file="${group.file.path}">${group.memoLabel || "メモ"}</button>` : ""}</p>
        ${this.archiveSelectionPanel(group)}
        <div class="deadline-task-grid" ${collapsed ? "hidden" : ""}>
          ${group.tasks.map((task) => this.taskCard(task)).join("")}
        </div>
      </section>
    `;
  }

  taskCard(task) {
    const complete = this.isTaskComplete(task);
    const currentStatus = this.displayStatus(task);
    const selectionActive = this.taskArchiveSelectionGroupKey === task.groupArchiveKey && this.taskArchiveSelectionMode;
    const selectedForArchive = this.selectedTaskArchiveKeys.has(task.archiveKey);
    const dueToday = this.isDueToday(task);
    const overdue = this.isOverdue(task);
    return `
      <article class="action-task-card${complete ? " is-complete" : ""}${dueToday ? " is-due-today" : ""}${overdue ? " is-overdue" : ""}${selectionActive ? " is-archive-selectable" : ""}${selectedForArchive ? " is-archive-selected" : ""}" data-task-file="${task.file.path}" data-task-key="${this.taskKey(task)}" data-task-archive-key="${task.archiveKey}" data-task-status="${task.status}" data-task-due="${task.due}"${selectionActive ? ` role="checkbox" tabindex="0" aria-checked="${selectedForArchive}"` : ""}>
        <div class="action-task-top">
          <span class="action-type-badge action-type-${typeClass(task.type)}">${typeLabel(task.type)}</span>
          ${task.due ? `<time datetime="${isIsoDate(task.due) ? task.due : ""}"${dueToday ? ' class="today-date"' : ""}>${dueToday ? "今日 " : ""}${task.due}</time>` : '<span class="action-floating-date">期限未定</span>'}
        </div>
        <label class="action-complete-control">
          <input type="checkbox" data-task-complete ${complete ? "checked" : ""} ${selectionActive ? "disabled" : ""} />
          <span aria-hidden="true"></span>
          <strong>${task.title}</strong>
        </label>
        <details class="task-detail-toggle" ${complete ? "" : "open"}>
          <summary>詳細</summary>
          <div class="task-detail-body">
            <p class="action-task-text">${task.text}</p>
            <div class="task-source-block">
              <span class="mini-label">元会話</span>
              <p>${task.source}</p>
            </div>
            <div class="task-support-actions">
              <button type="button" data-task-detail="${task.file.path}">詳細メモ</button>
              <button type="button" data-task-open="${task.file.path}">ノート</button>
            </div>
          </div>
        </details>
        <div class="action-task-foot">
          <span class="action-status action-status-${statusClass(currentStatus)}">${currentStatus}</span>
          <span>${task.groupWindow || ""}</span>
        </div>
      </article>
    `;
  }

  async handleChange(event) {
    const checkbox = event.target.closest?.("[data-task-complete]");
    if (!checkbox) return;
    const card = checkbox.closest("[data-task-file]");
    const file = this.app.vault.getAbstractFileByPath(card?.dataset.taskFile || "");
    if (!file) return;
    const status = checkbox.checked ? "完了" : "未着手";
    await this.updateFrontmatter(file, { status });
    this.render();
  }

  async handleClick(event) {
    const selectCard = event.target.closest?.("[data-task-archive-key]");
    if (selectCard && this.taskArchiveSelectionGroupKey && selectCard.closest("[data-group-archive-key]")?.dataset.groupArchiveKey === this.taskArchiveSelectionGroupKey && !event.target.closest("summary, button, input")) {
      this.toggleSelectedArchiveKey(selectCard.dataset.taskArchiveKey);
      this.render();
      return;
    }
    if (event.target.closest?.("[data-task-archive-cancel]")) {
      this.clearTaskArchiveSelection();
      this.render();
      return;
    }
    if (event.target.closest?.("[data-task-archive-commit]")) {
      await this.commitArchiveSelection();
      return;
    }
    const startButton = event.target.closest?.("[data-task-archive-start]");
    if (startButton) {
      const group = startButton.closest("[data-group-archive-key]");
      this.taskArchiveSelectionGroupKey = group?.dataset.groupArchiveKey || null;
      this.taskArchiveSelectionMode = startButton.dataset.taskArchiveMode;
      this.selectedTaskArchiveKeys = new Set();
      this.render();
      return;
    }
    const archiveAllButton = event.target.closest?.("[data-group-archive-all]");
    if (archiveAllButton) {
      const groupEl = archiveAllButton.closest("[data-group-archive-key]");
      const group = this.findVisibleGroupByArchiveKey(groupEl?.dataset.groupArchiveKey);
      if (!group?.file) return;
      await this.updateFrontmatter(group.file, { archived: !group.archived });
      this.clearTaskArchiveSelection();
      this.render();
      return;
    }
    const collapseButton = event.target.closest?.("[data-group-collapse]");
    if (collapseButton) {
      const group = collapseButton.closest("[data-group-state-key]");
      const collapsed = !group.classList.contains("is-collapsed");
      await this.plugin.setGroupCollapsed(group.dataset.groupStateKey, collapsed);
      this.render();
      return;
    }
    const taskDetail = event.target.closest?.("[data-task-detail]");
    if (taskDetail) {
      const file = this.app.vault.getAbstractFileByPath(taskDetail.dataset.taskDetail);
      if (file) new TaskDetailModal(this.app, file).open();
      return;
    }
    const calendarTask = event.target.closest?.("[data-calendar-task]");
    if (calendarTask) {
      const file = this.app.vault.getAbstractFileByPath(calendarTask.dataset.calendarTask);
      if (file) new TaskCardModal(this.app, this, file.path).open();
      return;
    }
    const taskOpen = event.target.closest?.("[data-task-open]");
    if (taskOpen) {
      const file = this.app.vault.getAbstractFileByPath(taskOpen.dataset.taskOpen);
      if (file) this.app.workspace.getLeaf("tab").openFile(file);
      return;
    }
    const groupMemo = event.target.closest?.("[data-group-file]");
    if (groupMemo) {
      const file = this.app.vault.getAbstractFileByPath(groupMemo.dataset.groupFile);
      if (file) new GroupMemoModal(this.app, file).open();
    }
  }

  handleKeydown(event) {
    if (![" ", "Enter"].includes(event.key) || !this.taskArchiveSelectionGroupKey) return;
    const card = event.target.closest?.("[data-task-archive-key]");
    if (!card) return;
    const group = card.closest("[data-group-archive-key]");
    if (group?.dataset.groupArchiveKey !== this.taskArchiveSelectionGroupKey) return;
    event.preventDefault();
    this.toggleSelectedArchiveKey(card.dataset.taskArchiveKey);
    this.render();
  }

  toggleSelectedArchiveKey(key) {
    if (this.selectedTaskArchiveKeys.has(key)) this.selectedTaskArchiveKeys.delete(key);
    else this.selectedTaskArchiveKeys.add(key);
  }

  findVisibleGroupByArchiveKey(key) {
    const { groups, tasks } = this.loadModels();
    return this.visibleGroupModels(groups, tasks).find((group) => this.groupArchiveKey(group) === key);
  }

  async commitArchiveSelection() {
    const archive = this.taskArchiveSelectionMode === "archive";
    const { groups, tasks } = this.loadModels();
    const visibleGroups = this.visibleGroupModels(groups, tasks);
    const selected = visibleGroups.flatMap((group) => group.tasks).filter((task) => this.selectedTaskArchiveKeys.has(task.archiveKey));
    for (const task of selected) {
      await this.updateFrontmatter(task.file, { archived: archive });
    }
    this.clearTaskArchiveSelection();
    this.render();
  }

  async updateFrontmatter(file, values) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.entries(values).forEach(([key, value]) => {
        frontmatter[key] = value;
      });
    });
  }
}

class TaskDetailModal extends Modal {
  constructor(app, file) {
    super(app);
    this.file = file;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pbn-modal", "pbn-task-detail-modal");
    const fm = getFrontmatter(this.app, this.file);
    contentEl.createEl("h2", { text: safeValue(fm.title || this.file.basename) });
    const meta = contentEl.createDiv({ cls: "pbn-modal-meta" });
    meta.createSpan({ text: safeValue(fm.group, "未分類") });
    meta.createSpan({ text: safeValue(fm.status, "未着手") });
    meta.createSpan({ text: safeValue(fm.due, "期限なし") });
    const content = stripFrontmatter(await this.app.vault.read(this.file));
    const renderTarget = contentEl.createDiv({ cls: "pbn-modal-body markdown-rendered" });
    await MarkdownRenderer.render(this.app, content || safeValue(fm.summary), renderTarget, this.file.path, this);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TaskCardModal extends Modal {
  constructor(app, view, filePath) {
    super(app);
    this.view = view;
    this.filePath = filePath;
    this.initialFilePath = filePath;
    this.statusOverrides = new Map();
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pbn-modal", "pbn-task-card-modal");
    contentEl.addEventListener("change", (event) => this.handleChange(event));
    contentEl.addEventListener("click", (event) => this.handleClick(event));
    this.renderContent();
  }

  findGroupAndTask() {
    const { groups, tasks } = this.view.loadModels();
    const tasksWithOverrides = tasks.map((task) => {
      const status = this.statusOverrides.get(task.file.path);
      return status ? { ...task, status } : task;
    });
    const visibleGroups = this.view
      .visibleGroupModels(groups, tasksWithOverrides)
      .map((group) => ({ ...group, tasks: this.view.filterTasks(group.tasks) }))
      .filter((group) => group.tasks.length > 0);
    for (const group of visibleGroups) {
      const task = group.tasks.find((item) => item.file.path === this.filePath);
      if (task) return { group, task };
    }
    const fallback = tasksWithOverrides.find((task) => task.file.path === this.filePath);
    return { group: null, task: fallback || null };
  }

  renderContent() {
    const { group, task } = this.findGroupAndTask();
    this.contentEl.empty();
    this.contentEl.addClass("pbn-modal", "pbn-task-card-modal");
    if (!task) {
      this.contentEl.createEl("h2", { text: "タスクが見つかりません" });
      return;
    }
    const relatedTasks = group?.tasks?.filter((item) => item.file.path !== task.file.path) || [];
    const head = this.contentEl.createDiv({ cls: "pbn-modal-category-head" });
    head.createSpan({ cls: "mini-label", text: group?.window || task.groupWindow || "時期未定" });
    head.createEl("h2", { text: group?.title || task.groupTitle || task.group || "未分類" });
    if (group?.note) head.createEl("p", { text: group.note });
    if (this.initialFilePath !== this.filePath) {
      head.createEl("button", {
        cls: "pbn-modal-origin-return",
        text: "最初のタスクに戻る",
        attr: { type: "button", "data-modal-task-switch": this.initialFilePath },
      });
    }
    const body = this.contentEl.createDiv({ cls: "pbn-modal-task-body" });
    const focus = body.createDiv({ cls: "pbn-modal-task-focus" });
    focus.innerHTML = this.view.taskCard(task);
    if (relatedTasks.length > 0) {
      const details = body.createEl("details", { cls: "pbn-modal-related-tasks" });
      details.createEl("summary", { text: "カテゴリの他タスクを見る" });
      const grid = details.createDiv({ cls: "deadline-task-grid" });
      grid.innerHTML = relatedTasks.map((item) => `
        <div class="pbn-modal-related-task">
          ${this.view.taskCard(item)}
          <button class="pbn-modal-task-switch" type="button" data-modal-task-switch="${escapeAttribute(item.file.path)}">このタスクを見る</button>
        </div>
      `).join("");
    }
  }

  async handleChange(event) {
    const checkbox = event.target.closest?.("[data-task-complete]");
    if (!checkbox) return;
    const card = checkbox.closest("[data-task-file]");
    const file = this.app.vault.getAbstractFileByPath(card?.dataset.taskFile || "");
    if (!file) return;
    const status = checkbox.checked ? "完了" : "未着手";
    this.statusOverrides.set(file.path, status);
    this.applyCardCompletion(card, checkbox.checked, status);
    await this.view.updateFrontmatter(file, { status });
    await this.view.render();
    this.applyCardCompletion(card, checkbox.checked, status);
  }

  applyCardCompletion(card, checked, status) {
    card.classList.toggle("is-complete", checked);
    card.classList.toggle("is-overdue", isIsoDate(card.dataset.taskDue) && card.dataset.taskDue < todayIso() && !checked);
    card.dataset.taskStatus = status;
    const checkbox = card.querySelector("[data-task-complete]");
    if (checkbox) checkbox.checked = checked;
    const details = card.querySelector(".task-detail-toggle");
    if (details) details.open = !checked;
    const badge = card.querySelector(".action-status");
    if (badge) {
      badge.className = `action-status action-status-${statusClass(status)}`;
      badge.textContent = status;
    }
  }

  handleClick(event) {
    const switchButton = event.target.closest?.("[data-modal-task-switch]");
    if (switchButton) {
      this.switchTask(switchButton.dataset.modalTaskSwitch);
      return;
    }
    const detail = event.target.closest?.("[data-task-detail]");
    if (detail) {
      const file = this.app.vault.getAbstractFileByPath(detail.dataset.taskDetail);
      if (file) new TaskDetailModal(this.app, file).open();
      return;
    }
    const open = event.target.closest?.("[data-task-open]");
    if (open) {
      const file = this.app.vault.getAbstractFileByPath(open.dataset.taskOpen);
      if (file) this.app.workspace.getLeaf("tab").openFile(file);
    }
  }

  async switchTask(filePath) {
    const file = this.app.vault.getAbstractFileByPath(filePath || "");
    if (!file) return;
    this.filePath = file.path;
    await this.view.render();
    this.renderContent();
    this.view.scrollMonthToTask(file.path);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GroupMemoModal extends Modal {
  constructor(app, file) {
    super(app);
    this.file = file;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pbn-modal");
    const fm = getFrontmatter(this.app, this.file);
    contentEl.createEl("h2", { text: safeValue(fm.title || this.file.basename) });
    const content = stripFrontmatter(await this.app.vault.read(this.file));
    const renderTarget = contentEl.createDiv({ cls: "pbn-modal-body markdown-rendered" });
    await MarkdownRenderer.render(this.app, content, renderTarget, this.file.path, this);
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = PlanningBoardNotesPlugin;
