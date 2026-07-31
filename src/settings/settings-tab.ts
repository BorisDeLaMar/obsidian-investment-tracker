// src/settings/settings-tab.ts

import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { InvestmentTrackerPluginLike } from '../view/dashboard-view';
import { TBankApiError } from '../api/tbank-api';

/**
 * Комбинированный тип для плагина: реальный класс наследуется от Obsidian Plugin
 * (для доступа к app/saveData и т.д.) и одновременно реализует минимальный контракт
 * InvestmentTrackerPluginLike (settings/dataStore/moexApi/parserDispatcher/saveSettings),
 * который нужен именно этой вкладке настроек.
 */
type SettingsTabPlugin = Plugin & InvestmentTrackerPluginLike;

/**
 * Вкладка настроек плагина учёта инвестиций.
 * Позволяет задать токен T-Invest API, путь к папке отчётов и проверить
 * подключение к Т-Банку без выполнения полноценной синхронизации.
 */
export class InvestmentTrackerSettingsTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: SettingsTabPlugin) {
		super(app, plugin);
	}

	public display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Учёт инвестиций — настройки' });

		this.buildTBankTokenSetting(containerEl);
		this.buildReportFolderSetting(containerEl);
		this.buildSyncFromDateSetting(containerEl);
		this.buildTestConnectionSetting(containerEl);
		this.buildLastSyncInfo(containerEl);
	}

	/** Поле ввода токена T-Invest API, замаскированное как пароль. */
	private buildTBankTokenSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Токен T-Invest API')
			.setDesc(
				'Персональный токен доступа, выпускается в личном кабинете Т-Банк Инвестиций ' +
					'(Настройки -> Т-Инвестиции API). Хранится локально в data.json плагина.'
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text.inputEl.style.width = '100%';
				text
					.setPlaceholder('t.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
					.setValue(this.plugin.settings.tbankApiToken)
					.onChange(async (value) => {
						this.plugin.settings.tbankApiToken = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}

	/** Текстовое поле пути к папке, куда пользователь может складывать отчёты для импорта. */
	private buildReportFolderSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Папка отчётов')
			.setDesc(
				'Путь внутри хранилища Obsidian, куда можно складывать HTML/CSV-отчёты брокеров ' +
					'для ручного импорта (используется как значение по умолчанию в диалоге импорта).'
			)
			.addText((text) => {
				text.inputEl.style.width = '100%';
				text
					.setPlaceholder('Investments/Reports')
					.setValue(this.plugin.settings.reportFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.reportFolderPath = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}

	/** Дата, раньше которой не нужно запрашивать историю (например, дата открытия счёта). */
	private buildSyncFromDateSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Синхронизировать с даты')
			.setDesc(
				'Не запрашивать историю операций раньше этой даты (например, дата открытия счёта). ' +
					'Экономит запросы к T-Invest API и снижает риск ограничения по частоте запросов (429). ' +
					'Формат: ГГГГ-ММ-ДД.'
			)
			.addText((text) => {
				text
					.setPlaceholder('2026-02-01')
					.setValue(this.plugin.settings.syncFromDate)
					.onChange(async (value) => {
						this.plugin.settings.syncFromDate = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}

	/**
	 * Кнопка проверки подключения к T-Invest API.
	 * Использует уже существующий публичный метод ReportParserDispatcher.fetchTBankApi
	 * с узким диапазоном "последние сутки" — отдельного лёгкого ping-эндпоинта
	 * в T-Invest API для этой цели нет, поэтому проверка токена и есть полноценный,
	 * хоть и короткий, вызов GetBrokerReport (может занять до ~10-12 секунд из-за
	 * цикла опроса готовности отчёта внутри TBankApi).
	 */
	private buildTestConnectionSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Проверка подключения')
			.setDesc(
				'Проверяет, что токен корректен и есть доступ к счёту (без загрузки отчётов). ' +
					'Полноценная синхронизация данных выполняется отдельной кнопкой в дашборде.'
			)
			.addButton((button) => {
				const defaultLabel = 'Проверить подключение к Т-Банку';
				button.setButtonText(defaultLabel);

				button.onClick(async () => {
					const token = this.plugin.settings.tbankApiToken;

					if (!token || token.trim().length === 0) {
						new Notice('Сначала укажите токен T-Invest API выше.');
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Проверка подключения...');

					try {
						const { accountName } = await this.plugin.parserDispatcher.checkTBankConnection(token);
						new Notice(`Токен рабочий. Найден счёт: "${accountName}".`);
					} catch (error) {
						if (error instanceof TBankApiError) {
							new Notice(`Ошибка подключения к T-Invest API: ${error.message}`);
						} else {
							new Notice('Не удалось подключиться к T-Invest API. Подробности — в консоли разработчика.');
						}
						console.error('[InvestmentTrackerSettingsTab] Ошибка проверки подключения к T-Invest API.', error);
					} finally {
						button.setDisabled(false);
						button.setButtonText(defaultLabel);
					}
				});
			});
	}

	/** Информационная строка с датой последней успешной синхронизации. */
	private buildLastSyncInfo(containerEl: HTMLElement): void {
		const lastSync = this.plugin.settings.lastSyncDate;
		const displayValue = lastSync ? new Date(lastSync).toLocaleString('ru-RU') : 'ещё не выполнялась';

		const infoEl = containerEl.createDiv();
		infoEl.style.cssText = 'margin-top: 16px; font-size: 12px; color: var(--text-muted);';
		infoEl.setText(`Последняя синхронизация с Т-Банком: ${displayValue}.`);
	}
}