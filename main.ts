// main.ts

import { Plugin, WorkspaceLeaf } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from 'src/types';
import { DataStore } from 'src/data/data-store';
import { MoexApi } from 'src/api/moex-api';
import { ReportParserDispatcher } from 'src/parser';
import {
	InvestmentDashboardView,
	VIEW_TYPE_INVESTMENT_DASHBOARD,
	InvestmentTrackerPluginLike
} from 'src/view/dashboard-view';
import { InvestmentTrackerSettingsTab } from 'src/settings/settings-tab';

/**
 * Главный класс плагина "Учёт инвестиций".
 * Связывает воедино хранилище данных (DataStore), клиент MOEX ISS (MoexApi),
 * диспетчер парсеров/API (ReportParserDispatcher), кастомную вкладку дашборда
 * (InvestmentDashboardView) и вкладку настроек (InvestmentTrackerSettingsTab).
 *
 * Явно реализует InvestmentTrackerPluginLike, чтобы TypeScript на этапе компиляции
 * проверял, что все поля/методы, ожидаемые дашбордом и вкладкой настроек,
 * действительно присутствуют в этом классе — без циклического импорта main.ts
 * из view/dashboard-view.ts (структурная типизация работает и без implements,
 * но явное указание защищает от случайного удаления нужного поля в будущем).
 */
export default class InvestmentTrackerPlugin extends Plugin implements InvestmentTrackerPluginLike {
	public settings!: PluginSettings;
	public dataStore!: DataStore;
	public moexApi!: MoexApi;
	public parserDispatcher!: ReportParserDispatcher;

	public async onload(): Promise<void> {
		await this.loadSettings();

		this.dataStore = new DataStore(this.app);
		this.moexApi = new MoexApi();
		this.parserDispatcher = new ReportParserDispatcher();

		this.registerView(
			VIEW_TYPE_INVESTMENT_DASHBOARD,
			(leaf: WorkspaceLeaf) => new InvestmentDashboardView(leaf, this)
		);

		this.addRibbonIcon('line-chart', 'Учёт инвестиций', () => {
			void this.activateDashboardView();
		});

		this.addCommand({
			id: 'open-investment-dashboard',
			name: 'Открыть дашборд учёта инвестиций',
			callback: () => {
				void this.activateDashboardView();
			}
		});

		this.addSettingTab(new InvestmentTrackerSettingsTab(this.app, this));

		console.log('[InvestmentTrackerPlugin] Плагин "Учёт инвестиций" загружен.');
	}

	public onunload(): void {
		// Закрывает все открытые вкладки дашборда. Obsidian вызовет onClose() у каждой
		// InvestmentDashboardView перед отсоединением листа, что корректно уничтожит
		// связанный экземпляр CapitalChart (см. onClose() в dashboard-view.ts).
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_INVESTMENT_DASHBOARD);
		console.log('[InvestmentTrackerPlugin] Плагин "Учёт инвестиций" выгружен.');
	}

	/**
	 * Открывает вкладку дашборда: если она уже открыта где-то в рабочей области,
	 * просто активирует её; иначе создаёт новый лист в правой панели.
	 */
	public async activateDashboardView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INVESTMENT_DASHBOARD);

		if (existingLeaves.length > 0) {
			this.app.workspace.revealLeaf(existingLeaves[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			console.error('[InvestmentTrackerPlugin] Не удалось получить лист рабочей области для дашборда.');
			return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_INVESTMENT_DASHBOARD,
			active: true
		});

		this.app.workspace.revealLeaf(leaf);
	}

	/** Загружает настройки из data.json плагина, дополняя их значениями по умолчанию. */
	private async loadSettings(): Promise<void> {
		const savedData = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(savedData ?? {}) };
	}

	/** Сохраняет текущие настройки в data.json плагина. */
	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}