import {
  App, ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf
} from "obsidian";

const VIEW_TYPE = "study-dashboard-ebbinghaus";

interface StudyTopic {
  id: string;
  title: string;
  materials: string[];
  discipline?: string;
  category?: string;
  course?: string;
  teacher?: string;
  semester?: string;
  status?: "В процессе" | "Завершено" | "Отложено";
  notePath?: string;
  createdAt: string;
  completedRepeats: number;
  lastReviewedAt?: string;
  reviewHistory?: string[];
}

interface DashboardSettings {
  intervals: number[];
  showLaunchNotice: boolean;
  notesFolder: string;
}

interface PluginData {
  topics: StudyTopic[];
  settings: DashboardSettings;
}

const DEFAULT_SETTINGS: DashboardSettings = {
  intervals: [1, 3, 7, 14, 30, 60, 120],
  showLaunchNotice: true,
  notesFolder: "Учёба/Темы"
};

function dayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function addDays(base: Date, days: number): Date {
  const result = new Date(base);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(date);
}

export default class StudyDashboardPlugin extends Plugin {
  topics: StudyTopic[] = [];
  settings: DashboardSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadDataSafely();
    this.registerView(VIEW_TYPE, (leaf) => new StudyDashboardView(leaf, this));
    this.addRibbonIcon("graduation-cap", "Открыть учебный дашборд", () => this.activateView());
    this.addCommand({ id: "open-study-dashboard", name: "Open study dashboard", callback: () => this.activateView() });
    this.addCommand({ id: "open-study-dashboard-fullscreen", name: "Open study dashboard in main workspace", callback: () => this.activateView(true) });
    this.addCommand({ id: "add-study-topic", name: "Add study topic", callback: () => new AddTopicModal(this.app, this).open() });
    this.addSettingTab(new StudySettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.showLaunchNotice) this.showDueNotice();
    });
  }

  async loadDataSafely() {
    const saved = await this.loadData() as Partial<PluginData> | null;
    this.topics = saved?.topics ?? [];
    this.settings = { ...DEFAULT_SETTINGS, ...saved?.settings };
  }

  async persist() {
    await this.saveData({ topics: this.topics, settings: this.settings });
    this.refreshViews();
  }

  dueDate(topic: StudyTopic): Date | null {
    if (topic.status === "Завершено" || topic.status === "Отложено") return null;
    const interval = this.settings.intervals[topic.completedRepeats];
    if (interval === undefined) return null;
    return dayStart(addDays(new Date(topic.createdAt), interval));
  }

  scheduledRepetitions(topic: StudyTopic): Array<{ date: Date; step: number; completed: boolean }> {
    if (topic.status === "Завершено" || topic.status === "Отложено") return [];
    return this.settings.intervals.map((interval, index) => ({
      date: dayStart(addDays(new Date(topic.createdAt), interval)), step: index + 1, completed: index < topic.completedRepeats
    }));
  }

  dueTopics(): StudyTopic[] {
    const today = dayStart(new Date());
    return this.topics.filter((topic) => {
      const due = this.dueDate(topic);
      return due !== null && due <= today;
    });
  }

  async completeReviews(topicIds: string[]) {
    const now = new Date().toISOString();
    const reviewed = this.topics.filter((topic) => topicIds.includes(topic.id) && this.dueDate(topic));
    reviewed.forEach((topic) => {
      topic.completedRepeats += 1;
      topic.lastReviewedAt = now;
      topic.reviewHistory = [...(topic.reviewHistory ?? []), now];
    });
    await this.persist();
    if (reviewed.length) new Notice(`Отмечено повторений: ${reviewed.length}.`);
  }

  async completeReview(topicId: string) {
    await this.completeReviews([topicId]);
  }

  async createTopicNote(topic: StudyTopic): Promise<string> {
    const folder = this.settings.notesFolder.replace(/^\/+|\/+$/g, "") || "Учёба/Темы";
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const safeTitle = topic.title.replace(/[\\/:*?\"<>|]/g, "-").trim().slice(0, 120) || "Новая тема";
    let path = `${folder}/${safeTitle}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${safeTitle} ${suffix++}.md`;
    const tags = ["учёба", topic.discipline, topic.category].filter(Boolean).map((tag) => `  - ${String(tag).trim().replace(/\s+/g, "-")}`).join("\n");
    const materialList = topic.materials.length ? topic.materials.map((item) => `- ${item}`).join("\n") : "- Добавьте ссылку, конспект или файл";
    const content = `---\ntags:\n${tags}\ndiscipline: ${JSON.stringify(topic.discipline || "Не указана")}\ncourse: ${JSON.stringify(topic.course || "Не указан")}\nteacher: ${JSON.stringify(topic.teacher || "Не указан")}\nsemester: ${JSON.stringify(topic.semester || "Не указан")}\ncategory: ${JSON.stringify(topic.category || "Дополнительно")}\nstatus: ${JSON.stringify(topic.status || "В процессе")}\ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${topic.title}\n\n## Краткий конспект\n\n\n## Материалы\n${materialList}\n\n## Вопросы и непонятное\n- [ ] \n\n## Практика / задания\n- [ ] \n\n## Итоги повторения\n- \n`;
    await this.app.vault.create(path, content);
    return path;
  }

  async activateView(fullscreen = false) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = fullscreen ? workspace.getLeaf("tab") : workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    this.showDueNotice();
  }

  showDueNotice() {
    const count = this.dueTopics().length;
    if (count) new Notice(`К повторению: ${count} ${count === 1 ? "тема" : "темы"}. Откройте учебный дашборд.`);
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => (leaf.view as StudyDashboardView).render());
  }
}

class StudyDashboardView extends ItemView {
  plugin: StudyDashboardPlugin;
  tab: "today" | "all" | "calendar" | "exam" | "progress" = "today";
  month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  examSelection = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: StudyDashboardPlugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Учебный дашборд"; }
  getIcon() { return "graduation-cap"; }
  async onOpen() { this.render(); }

  render() {
    const root = this.contentEl;
    root.empty(); root.addClass("study-dashboard");
    root.createEl("h1", { text: "Учебный дашборд" });
    root.createDiv({ cls: "subtitle", text: "Интервальное повторение по кривой Эббингауза" });
    const toolbar = root.createDiv({ cls: "study-toolbar" });
    toolbar.createEl("button", { text: "＋ Добавить тему", cls: "mod-cta" }).onclick = () => new AddTopicModal(this.app, this.plugin).open();
    toolbar.createEl("button", { text: "⛶ Во весь экран" }).onclick = () => this.plugin.activateView(true);
    toolbar.createEl("button", { text: "Обновить" }).onclick = () => this.render();
    const due = this.plugin.dueTopics();
    const active = this.plugin.topics.filter((item) => this.plugin.dueDate(item)).length;
    const thisWeek = this.plugin.topics.flatMap((topic) => topic.reviewHistory ?? []).filter((date) => new Date(date).getTime() >= Date.now() - 7 * 86400000).length;
    const stats = root.createDiv({ cls: "study-stats" });
    this.stat(stats, due.length, "нужно повторить");
    this.stat(stats, active, "активных тем");
    this.stat(stats, thisWeek, "повторений за 7 дней");
    const tabs = root.createDiv({ cls: "study-tabs" });
    ([ ["today", "Сегодня"], ["all", "Все темы"], ["calendar", "Календарь"], ["exam", "Экзамен"], ["progress", "Прогресс"] ] as const).forEach(([key, label]) => {
      const button = tabs.createEl("button", { text: label, cls: key === this.tab ? "is-active" : "" });
      button.onclick = () => { this.tab = key; this.render(); };
    });
    if (this.tab === "today") this.renderToday(root, due);
    if (this.tab === "all") this.renderAll(root);
    if (this.tab === "calendar") this.renderCalendar(root);
    if (this.tab === "exam") this.renderExam(root);
    if (this.tab === "progress") this.renderProgress(root);
  }

  stat(parent: HTMLElement, value: number, label: string) {
    const card = parent.createDiv({ cls: "study-stat" }); card.createEl("b", { text: String(value) }); card.createSpan({ text: label });
  }

  renderToday(parent: HTMLElement, topics: StudyTopic[]) {
    parent.createEl("h2", { text: "Очередь повторений" });
    if (!topics.length) { parent.createDiv({ cls: "study-empty", text: "На сегодня повторений нет. Отличная работа!" }); return; }
    topics.sort((a, b) => this.plugin.dueDate(a)!.getTime() - this.plugin.dueDate(b)!.getTime()).forEach((topic) => this.renderTopic(parent, topic, true));
  }

  renderAll(parent: HTMLElement) {
    parent.createEl("h2", { text: "Все изучаемые темы" });
    if (!this.plugin.topics.length) { parent.createDiv({ cls: "study-empty", text: "Добавьте первую тему, чтобы начать план повторений." }); return; }
    this.plugin.topics.forEach((topic) => this.renderTopic(parent, topic, false));
  }

  renderTopic(parent: HTMLElement, topic: StudyTopic, canReview: boolean) {
    const card = parent.createDiv({ cls: "study-card" });
    card.createEl("h3", { text: topic.title });
    if (topic.discipline || topic.category) card.createDiv({ cls: "subtitle", text: [topic.discipline, topic.category].filter(Boolean).join(" · ") });
    const due = this.plugin.dueDate(topic);
    card.createDiv({ cls: "date", text: due ? `Следующее повторение: ${formatDate(due)}` : "Цикл повторений завершён" });
    card.createDiv({ text: `Пройдено повторений: ${topic.completedRepeats} из ${this.plugin.settings.intervals.length}` });
    const statusSelect = card.createEl("select");
    (["В процессе", "Завершено", "Отложено"] as const).forEach((status) => statusSelect.createEl("option", { text: status, value: status }));
    statusSelect.value = topic.status ?? "В процессе";
    statusSelect.onchange = async () => { topic.status = statusSelect.value as StudyTopic["status"]; await this.plugin.persist(); };
    if (topic.materials.length) {
      const list = card.createEl("ul", { cls: "study-materials" });
      topic.materials.forEach((material) => {
        const item = list.createEl("li");
        const link = item.createEl("a", { text: material, href: material });
        link.onclick = (event) => {
          if (material.startsWith("[[") && material.endsWith("]]")) {
            event.preventDefault();
            void this.app.workspace.openLinkText(material.slice(2, -2), "", false);
          }
        };
      });
    }
    const actions = card.createDiv({ cls: "actions" });
    if (topic.notePath) actions.createEl("button", { text: "Открыть заметку" }).onclick = () => void this.app.workspace.openLinkText(topic.notePath!, "", false);
    if (canReview) actions.createEl("button", { text: "✓ Повторить", cls: "mod-cta" }).onclick = () => this.plugin.completeReview(topic.id);
    actions.createEl("button", { text: "Удалить" }).onclick = async () => {
      this.plugin.topics = this.plugin.topics.filter((item) => item.id !== topic.id);
      await this.plugin.persist(); new Notice("Тема удалена.");
    };
  }

  renderCalendar(parent: HTMLElement) {
    const controls = parent.createDiv({ cls: "study-toolbar" });
    controls.createEl("button", { text: "←" }).onclick = () => { this.month.setMonth(this.month.getMonth() - 1); this.render(); };
    controls.createEl("strong", { text: new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(this.month) });
    controls.createEl("button", { text: "→" }).onclick = () => { this.month.setMonth(this.month.getMonth() + 1); this.render(); };
    const calendar = parent.createDiv({ cls: "study-calendar" });
    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].forEach((name) => calendar.createDiv({ cls: "calendar-weekday", text: name }));
    const firstDay = new Date(this.month.getFullYear(), this.month.getMonth(), 1);
    const offset = (firstDay.getDay() + 6) % 7;
    const start = addDays(firstDay, -offset);
    const today = dateKey(new Date());
    const reminders = new Map<string, Array<{ topic: StudyTopic; step: number; completed: boolean }>>();
    this.plugin.topics.forEach((topic) => this.plugin.scheduledRepetitions(topic).forEach((repeat) => {
      const key = dateKey(repeat.date);
      reminders.set(key, [...(reminders.get(key) ?? []), { topic, step: repeat.step, completed: repeat.completed }]);
    }));
    for (let i = 0; i < 42; i++) {
      const date = addDays(start, i); const cell = calendar.createDiv({ cls: "calendar-day" });
      if (date.getMonth() !== this.month.getMonth()) cell.addClass("is-other-month");
      if (dateKey(date) === today) cell.addClass("is-today");
      cell.createDiv({ cls: "calendar-day-number", text: String(date.getDate()) });
      (reminders.get(dateKey(date)) ?? []).forEach((reminderData) => {
        const reminder = cell.createDiv({ cls: `calendar-reminder${reminderData.completed ? " is-completed" : ""}`, text: `${reminderData.topic.title} · #${reminderData.step}` });
        reminder.onclick = () => { this.tab = "all"; this.render(); };
      });
    }
  }

  renderExam(parent: HTMLElement) {
    parent.createEl("h2", { text: "Режим экзамена" });
    parent.createDiv({ cls: "subtitle", text: "Выберите темы, которые хотите повторить в этой сессии. Просроченные отмечены первыми." });
    const candidates = [...this.plugin.topics].filter((topic) => topic.status !== "Завершено" && topic.status !== "Отложено").sort((a, b) => Number(Boolean(this.plugin.dueDate(b))) - Number(Boolean(this.plugin.dueDate(a))));
    if (!candidates.length) { parent.createDiv({ cls: "study-empty", text: "Нет активных тем для подготовки." }); return; }
    const bar = parent.createDiv({ cls: "study-toolbar" });
    bar.createEl("button", { text: "Выбрать просроченные" }).onclick = () => { this.plugin.dueTopics().forEach((topic) => this.examSelection.add(topic.id)); this.render(); };
    bar.createEl("button", { text: "Повторить выбранные", cls: "mod-cta" }).onclick = async () => { await this.plugin.completeReviews([...this.examSelection]); this.examSelection.clear(); };
    candidates.forEach((topic) => {
      const card = parent.createDiv({ cls: "study-card" });
      const check = card.createEl("input", { type: "checkbox" }); check.checked = this.examSelection.has(topic.id);
      check.onchange = () => { if (check.checked) this.examSelection.add(topic.id); else this.examSelection.delete(topic.id); };
      card.createEl("strong", { text: ` ${topic.title}` });
      card.createDiv({ cls: "date", text: this.plugin.dueDate(topic) ? `К повторению: ${formatDate(this.plugin.dueDate(topic)!)}` : "Цикл завершён" });
      if (topic.discipline) card.createDiv({ cls: "subtitle", text: topic.discipline });
    });
  }

  renderProgress(parent: HTMLElement) {
    parent.createEl("h2", { text: "Прогресс и статистика" });
    const groups = new Map<string, StudyTopic[]>();
    this.plugin.topics.forEach((topic) => { const key = topic.discipline || "Без дисциплины"; groups.set(key, [...(groups.get(key) ?? []), topic]); });
    if (!groups.size) { parent.createDiv({ cls: "study-empty", text: "Статистика появится после добавления тем." }); return; }
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([discipline, topics]) => {
      const completed = topics.reduce((total, topic) => total + topic.completedRepeats, 0);
      const possible = topics.length * this.plugin.settings.intervals.length;
      const doneTopics = topics.filter((topic) => topic.status === "Завершено" || topic.completedRepeats >= this.plugin.settings.intervals.length).length;
      const card = parent.createDiv({ cls: "study-card" });
      card.createEl("h3", { text: discipline });
      card.createDiv({ text: `Прогресс повторений: ${possible ? Math.round(completed / possible * 100) : 0}% (${completed}/${possible})` });
      card.createDiv({ text: `Тем: ${topics.length}; завершено: ${doneTopics}; к повторению сегодня: ${topics.filter((topic) => this.plugin.dueTopics().includes(topic)).length}` });
    });
  }
}

class AddTopicModal extends Modal {
  plugin: StudyDashboardPlugin;
  title = "";
  materials = "";
  discipline = "";
  category = "Вуз";
  course = "";
  teacher = "";
  semester = "";
  constructor(app: App, plugin: StudyDashboardPlugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Новая изученная тема" });
    new Setting(this.contentEl).setName("Тема").setDesc("Например: «HTTP-кеширование»").addText((text) => text.setPlaceholder("Название темы").onChange((value) => this.title = value));
    new Setting(this.contentEl).setName("Дисциплина").setDesc("Будет добавлена как тег и поле заметки.").addText((text) => text.setPlaceholder("Например: Программирование").onChange((value) => this.discipline = value));
    new Setting(this.contentEl).setName("Курс").setDesc("Например: «Алгоритмы и структуры данных». ").addText((text) => text.setPlaceholder("Название курса").onChange((value) => this.course = value));
    new Setting(this.contentEl).setName("Преподаватель").addText((text) => text.setPlaceholder("Имя преподавателя").onChange((value) => this.teacher = value));
    new Setting(this.contentEl).setName("Семестр").addText((text) => text.setPlaceholder("Например: 2 курс · весна 2026").onChange((value) => this.semester = value));
    new Setting(this.contentEl).setName("Тип обучения").setDesc("Помогает отделить университетские задания от личных целей.").addDropdown((dropdown) => dropdown.addOption("Вуз", "Задание из вуза").addOption("Дополнительно", "Дополнительное изучение").addOption("Идея", "Идея / исследование").setValue(this.category).onChange((value) => this.category = value));
    new Setting(this.contentEl).setName("Материалы").setDesc("По одному пути к заметке или ссылке в строке.").addTextArea((text) => { text.setPlaceholder("[[Заметка]]\nhttps://example.com"); text.inputEl.rows = 7; text.onChange((value) => this.materials = value); });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Добавить и запланировать").setCta().onClick(async () => {
      const title = this.title.trim();
      if (!title) { new Notice("Введите название темы."); return; }
      const topic: StudyTopic = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, discipline: this.discipline.trim(), course: this.course.trim(), teacher: this.teacher.trim(), semester: this.semester.trim(), category: this.category, status: "В процессе", materials: this.materials.split("\n").map((value) => value.trim()).filter(Boolean), createdAt: new Date().toISOString(), completedRepeats: 0, reviewHistory: [] };
      try { topic.notePath = await this.plugin.createTopicNote(topic); } catch (error) { console.error(error); new Notice("Тема добавлена, но создать заметку не удалось."); }
      this.plugin.topics.unshift(topic);
      await this.plugin.persist(); this.close(); new Notice(`Тема «${title}» добавлена. Первое повторение — завтра.`);
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class StudySettingsTab extends PluginSettingTab {
  plugin: StudyDashboardPlugin;
  constructor(app: App, plugin: StudyDashboardPlugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Study Dashboard — Ebbinghaus" });
    new Setting(containerEl).setName("Интервалы повторений (дни)").setDesc("Укажите дни через запятую. Изменения действуют на все темы.").addText((text) => text.setValue(this.plugin.settings.intervals.join(", ")).onChange(async (value) => {
      const intervals = value.split(",").map((part) => Number(part.trim())).filter((item) => Number.isFinite(item) && item > 0);
      if (intervals.length) { this.plugin.settings.intervals = intervals; await this.plugin.persist(); }
    }));
    new Setting(containerEl).setName("Уведомление при запуске").setDesc("Показывать число тем, которые нужно повторить.").addToggle((toggle) => toggle.setValue(this.plugin.settings.showLaunchNotice).onChange(async (value) => { this.plugin.settings.showLaunchNotice = value; await this.plugin.persist(); }));
    new Setting(containerEl).setName("Папка для заметок").setDesc("Относительный путь внутри vault. Заметка создаётся при добавлении новой темы.").addText((text) => text.setValue(this.plugin.settings.notesFolder).onChange(async (value) => { this.plugin.settings.notesFolder = value.trim() || DEFAULT_SETTINGS.notesFolder; await this.plugin.persist(); }));
  }
}
