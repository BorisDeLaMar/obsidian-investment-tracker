// src/view/dashboard-view.ts

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { Transaction, Position, PortfolioSnapshot, PluginSettings } from '../types';
import { DataStore } from '../data/data-store';
import { PortfolioCalculator } from '../data/portfolio-calculator';
import { MoexApi } from '../api/moex-api';
import { ReportParserDispatcher } from '../parser';
import { CapitalChart } from './capital-chart';

import * as XLSX from 'xlsx';

/** Уникальный идентификатор вкладки дашборда, используется при регистрации View в main.ts. */
export const VIEW_TYPE_INVESTMENT_DASHBOARD = 'investment-dashboard-view';

/**
 * Минимальный структурный контракт, который должен предоставлять главный класс плагина
 * для работы дашборда. Объявлен локально (а не импортирован из main.ts), чтобы избежать
 * циклической зависимости main.ts <-> dashboard-view.ts — TypeScript сопоставит реальный
 * класс плагина по структуре полей/методов автоматически (structural typing).
 */
export interface InvestmentTrackerPluginLike {
	settings: PluginSettings;
	dataStore: DataStore;
	moexApi: MoexApi;
	parserDispatcher: ReportParserDispatcher;
	/** Персистентно сохраняет settings (обычно через this.saveData(this.settings) в main.ts). */
	saveSettings(): Promise<void>;
}

/** Форматирует число как рублёвую сумму с разделителями тысяч и 2 знаками после запятой. */
function formatMoney(value: number): string {
	return new Intl.NumberFormat('ru-RU', {
		style: 'currency',
		currency: 'RUB',
		maximumFractionDigits: 2,
		minimumFractionDigits: 2
	}).format(value);
}

/** Форматирует число как проценты с 2 знаками после запятой и явным знаком "+"/"-". */
function formatPercent(value: number): string {
	const sign = value > 0 ? '+' : '';
	return `${sign}${value.toFixed(2)}%`;
}

/** Форматирует количество бумаг без лишних дробных нулей. */
function formatAmount(value: number): string {
	return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 }).format(value);
}

/**
 * Кастомная вкладка (ItemView) дашборда учёта инвестиций.
 *
 * Отображает:
 *  - панель кнопок управления (синхронизация с T-Invest API, импорт HTML-отчёта Сбера);
 *  - три сводные карточки (стоимость портфеля, внесённые средства, прибыль);
 *  - линейный график капитала (CapitalChart / Chart.js);
 *  - таблицу текущих позиций по тикерам.
 */
export class InvestmentDashboardView extends ItemView {
	private readonly portfolioCalculator: PortfolioCalculator;

	private summaryCapitalValueEl: HTMLElement | null = null;
	private summaryInvestedValueEl: HTMLElement | null = null;
	private summaryProfitValueEl: HTMLElement | null = null;

	private chartContainerEl: HTMLElement | null = null;
	private capitalChart: CapitalChart | null = null;

	private positionsTableBodyEl: HTMLTableSectionElement | null = null;
	private statusEl: HTMLElement | null = null;

	private syncTBankButtonEl: HTMLButtonElement | null = null;

	/** Защита от повторного запуска долгих операций (синк/импорт) двойным кликом. */
	private isBusy = false;

	/**
	 * Минимальный отступ (в днях) от текущей даты, который нужно соблюдать при запросе
	 * GetBrokerReport — иначе сервер отклоняет период с ошибкой INVALID_ARGUMENT
	 * ("`from` is invalid"), даже если сам период короткий и не превышает лимит в 30 дней.
	 * Эмпирическое значение: буфер в 1 день оказался недостаточным на практике (запрос
	 * за "вчера" всё равно отклонялся), поэтому увеличено до 3 дней. Точный расчётный лаг
	 * API документально не подтверждён — при повторных ошибках "from is invalid" вблизи
	 * текущей даты стоит попробовать увеличить это значение ещё.
	 */
	private static readonly SETTLEMENT_LAG_DAYS = 3;

	/** Вычисляет верхнюю границу периода синхронизации: "сегодня минус SETTLEMENT_LAG_DAYS". */
	private computeSafeToDate(): Date {
		const now = new Date();
		const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		return new Date(startOfToday - InvestmentDashboardView.SETTLEMENT_LAG_DAYS * 24 * 60 * 60 * 1000);
	}

	constructor(leaf: WorkspaceLeaf, private readonly plugin: InvestmentTrackerPluginLike) {
		super(leaf);
		this.portfolioCalculator = new PortfolioCalculator();
	}

	public getViewType(): string {
		return VIEW_TYPE_INVESTMENT_DASHBOARD;
	}

	public getDisplayText(): string {
		return 'Учёт инвестиций';
	}

	public getIcon(): string {
		return 'line-chart';
	}

	public async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('investment-dashboard-container');

		this.buildToolbar(this.contentEl);
		this.buildSummaryCards(this.contentEl);
		this.buildChartSection(this.contentEl);
		this.buildStatusLine(this.contentEl);
		this.buildPositionsTable(this.contentEl);

		await this.updateDashboard();
	}

	public async onClose(): Promise<void> {
		this.capitalChart?.destroy();
		this.capitalChart = null;
	}

	// ---------------------------------------------------------------------------
	// Построение статического DOM-каркаса
	// ---------------------------------------------------------------------------

	/** Панель кнопок: синхронизация с T-Invest API и импорт HTML-отчёта Сбера. */
	private buildToolbar(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: 'investment-dashboard-toolbar' });
		toolbar.style.display = 'flex';
		toolbar.style.gap = '8px';
		toolbar.style.marginBottom = '16px';
		toolbar.style.flexWrap = 'wrap';

		this.syncTBankButtonEl = toolbar.createEl('button', {
			text: 'Синхронизировать Т-Банк (API)',
			cls: 'mod-cta'
		});
		this.syncTBankButtonEl.addEventListener('click', () => {
			void this.handleSyncTBank();
		});

		const xlsxButton = toolbar.createEl('button', {
			text: 'Импортировать отчёт Сбера (XLSX)'
		});
		xlsxButton.addEventListener('click', () => {
			this.triggerSberXlsxFilePicker();
		});
	}

	/**
	 * Открывает диалог выбора XLSX-файла.
	 */
	private triggerSberXlsxFilePicker(): void {
		if (this.isBusy) {
			return;
		}

		const inputEl = document.createElement('input');
		inputEl.type = 'file';
		inputEl.accept = '.xlsx';
		inputEl.style.display = 'none';

		inputEl.addEventListener('change', () => {
			const file = inputEl.files?.[0];
			if (file) {
				void this.handleSberXlsxImport(file);
			}
			inputEl.remove();
		});

		document.body.appendChild(inputEl);
		inputEl.click();
	}

	/** Три сводные карточки: стоимость портфеля, внесённые средства, прибыль. */
	private buildSummaryCards(root: HTMLElement): void {
		const summaryContainer = root.createDiv({ cls: 'investment-dashboard-summary' });
		summaryContainer.style.display = 'grid';
		summaryContainer.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))';
		summaryContainer.style.gap = '12px';
		summaryContainer.style.marginBottom = '20px';

		const capitalCard = this.createSummaryCard(
			summaryContainer,
			'Текущая стоимость портфеля'
		);
		this.summaryCapitalValueEl = capitalCard;

		const investedCard = this.createSummaryCard(summaryContainer, 'Всего внесено средств');
		this.summaryInvestedValueEl = investedCard;

		const profitCard = this.createSummaryCard(summaryContainer, 'Общая прибыль');
		this.summaryProfitValueEl = profitCard;
	}

	/**
	 * Создаёт одну карточку с заголовком и возвращает ссылку на элемент значения
	 * (его содержимое обновляется отдельно в updateDashboard, чтобы не пересоздавать DOM).
	 */
	private createSummaryCard(container: HTMLElement, title: string): HTMLElement {
		const card = container.createDiv({ cls: 'investment-dashboard-card' });
		card.style.border = '1px solid var(--background-modifier-border)';
		card.style.borderRadius = '8px';
		card.style.padding = '14px 16px';
		card.style.backgroundColor = 'var(--background-secondary)';

		card.createDiv({
			text: title,
			cls: 'investment-dashboard-card-title'
		}).style.cssText = 'font-size: 12px; color: var(--text-muted); margin-bottom: 6px;';

		const valueEl = card.createDiv({
			text: '—',
			cls: 'investment-dashboard-card-value'
		});
		valueEl.style.cssText = 'font-size: 22px; font-weight: 600; color: var(--text-normal);';

		return valueEl;
	}

	/** Контейнер под линейный график капитала. */
	private buildChartSection(root: HTMLElement): void {
		const chartSection = root.createDiv({ cls: 'investment-dashboard-chart-section' });
		chartSection.style.marginBottom = '20px';

		chartSection.createEl('h3', { text: 'Динамика капитала' }).style.cssText =
			'margin: 0 0 8px 0; color: var(--text-normal);';

		this.chartContainerEl = chartSection.createDiv({ cls: 'investment-dashboard-chart-container' });
		this.chartContainerEl.style.height = '320px';
		this.chartContainerEl.style.width = '100%';
	}

	/** Однострочный статус последней операции (успех/ошибка синхронизации или импорта). */
	private buildStatusLine(root: HTMLElement): void {
		this.statusEl = root.createDiv({ cls: 'investment-dashboard-status' });
		this.statusEl.style.cssText =
			'font-size: 12px; color: var(--text-muted); margin-bottom: 12px; min-height: 16px;';
	}

	private buildPositionsTable(root: HTMLElement): void {
		const tableSection = root.createDiv({ cls: 'investment-dashboard-table-section' });

		tableSection.createEl('h3', { text: 'Текущие позиции' }).style.cssText =
			'margin: 0 0 8px 0; color: var(--text-normal);';

		// 1. Создаём обёртку для горизонтального скролла
		const scrollWrapper = tableSection.createDiv({ cls: 'investment-positions-wrapper' });
		scrollWrapper.style.cssText = 'overflow-x: auto; width: 100%;';

		// 2. Таблица создаётся уже внутри обёртки
		const table = scrollWrapper.createEl('table', { cls: 'investment-dashboard-positions-table' });
		table.style.width = '100%';
		table.style.borderCollapse = 'collapse';
		// Добавляем минимальную ширину, чтобы колонки не сжимались слишком сильно
		table.style.minWidth = '800px'; 

		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		const headers = [
			'Тикер',
			'Название',
			'Брокер',
			'Кол-во',
			'Средняя цена',
			'Текущая цена MOEX',
			'Стоимость',
			'Доля (%)',
			'Профит (%)'
		];
		for (const headerText of headers) {
			const th = headerRow.createEl('th', { text: headerText });
			th.style.cssText =
				'text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--background-modifier-border); color: var(--text-muted); font-weight: 500; font-size: 12px; white-space: nowrap;';
		}

		this.positionsTableBodyEl = table.createEl('tbody');
	}

	// ---------------------------------------------------------------------------
	// Обновление данных дашборда
	// ---------------------------------------------------------------------------

	public async updateDashboard(): Promise<void> {
		try {
			const transactions = await this.plugin.dataStore.getTransactions();

			if (transactions.length === 0) {
				this.setStatus('Нет сохранённых транзакций. Синхронизируйтесь с Т-Банком или импортируйте отчёт Сбера.');
				this.renderSummaryCards([], [], []);
				this.renderChart([], []);
				this.renderPositionsTable([]);
				return;
			}

			const uniqueTickers = Array.from(
				new Set(
					transactions
						.filter((t) => t.type === 'BUY' || t.type === 'SELL')
						.map((t) => t.ticker)
						.filter((ticker): ticker is string => !!ticker)
				)
			);

			const moexPrices = await this.plugin.moexApi.fetchCurrentPrices(uniqueTickers);

			const missingTickers = uniqueTickers.filter((ticker) => !moexPrices.has(ticker));
			if (missingTickers.length > 0 && this.plugin.settings.tbankApiToken) {
				const figiByTicker = new Map<string, string>();
				for (const t of transactions) {
					if (missingTickers.includes(t.ticker) && t.figi) {
						figiByTicker.set(t.ticker, t.figi);
					}
				}

				const figiList = Array.from(figiByTicker.values());
				if (figiList.length > 0) {
					const tbankPrices = await this.plugin.parserDispatcher.fetchTBankLastPrices(
						this.plugin.settings.tbankApiToken,
						figiList
					);

					for (const [ticker, figi] of figiByTicker.entries()) {
						const price = tbankPrices.get(figi);
						if (price != null) {
							moexPrices.set(ticker, { price, instrumentKind: 'FUND' });
						}
					}
				}
			}

			const positions = this.portfolioCalculator.calculateCurrentPositions(
				transactions,
				moexPrices
			);
			const timeline = this.portfolioCalculator.generateCapitalTimeline(transactions);

			this.renderSummaryCards(positions, timeline, transactions);
			this.renderChart(timeline, transactions);
			this.renderPositionsTable(positions);

			this.setStatus(`Данные обновлены: ${new Date().toLocaleString('ru-RU')}.`);
		} catch (error) {
			console.error('[InvestmentDashboardView] Ошибка при обновлении дашборда.', error);
			this.setStatus('Не удалось обновить дашборд. Подробности — в консоли разработчика.');
			new Notice('Учёт инвестиций: не удалось обновить дашборд. См. консоль (Ctrl+Shift+I).');
		}
	}

	// ---------------------------------------------------------------------------
	// Обработчики кнопок
	// ---------------------------------------------------------------------------

	/** Обработчик кнопки "Синхронизировать Т-Банк (API)". */
	private async handleSyncTBank(): Promise<void> {
		if (this.isBusy) {
			return;
		}

		const token = this.plugin.settings.tbankApiToken;
		if (!token || token.trim().length === 0) {
			new Notice('Укажите токен T-Invest API в настройках плагина перед синхронизацией.');
			return;
		}

		this.isBusy = true;
		this.setButtonsDisabled(true);
		this.setStatus('Синхронизация с T-Invest API...');

		try {
			// "to" ограничен концом вчерашнего дня (UTC), а не текущим моментом — GetBrokerReport
			// работает с расчётными (settled) данными и может отклонять диапазон, включающий
			// ещё не закрытый текущий торговый день (см. ошибку INVALID_ARGUMENT на поле `from`).
			const toDate = this.computeSafeToDate().toISOString();

			const fromDate =
				this.plugin.settings.lastSyncDate && this.plugin.settings.lastSyncDate.length > 0
					? this.plugin.settings.lastSyncDate
					: this.resolveInitialSyncFromDate();

			console.log(`[InvestmentDashboardView] Синхронизация: from="${fromDate}", to="${toDate}" (now="${new Date().toISOString()}").`);

			if (new Date(fromDate).getTime() >= new Date(toDate).getTime()) {
				new Notice('Синхронизация не требуется: с последнего обновления ещё не прошло достаточно времени.');
				this.setStatus('Нечего синхронизировать — данные уже актуальны на доступную дату.');
				return;
			}

			const transactions = await this.plugin.parserDispatcher.fetchTBankApi(token, fromDate, toDate);

			await this.plugin.dataStore.saveTransactions(transactions);

			this.plugin.settings.lastSyncDate = toDate;
			await this.plugin.saveSettings();

			new Notice(`Синхронизация с Т-Банком завершена: получено ${transactions.length} операций.`);
			await this.updateDashboard();
		} catch (error) {
			console.error('[InvestmentDashboardView] Ошибка синхронизации с T-Invest API.', error);
			this.setStatus('Ошибка синхронизации с Т-Банком. Подробности — в консоли разработчика.');
			new Notice('Не удалось синхронизироваться с T-Invest API. См. консоль (Ctrl+Shift+I).');
		} finally {
			this.isBusy = false;
			this.setButtonsDisabled(false);
		}
	}

	/**
	 * Определяет нижнюю границу для первой синхронизации: явно заданную пользователем
	 * дату открытия счёта (syncFromDate), а если она не задана — консервативный дефолт
	 * "3 года назад". Указание реальной даты открытия счёта резко снижает число чанков
	 * и, соответственно, число запросов к T-Invest API (что напрямую влияет на риск 429).
	 */
	private resolveInitialSyncFromDate(): string {
		const configured = this.plugin.settings.syncFromDate;
		if (configured && configured.trim().length > 0) {
			const parsed = new Date(configured);
			if (!Number.isNaN(parsed.getTime())) {
				return parsed.toISOString();
			}
			console.warn(
				`[InvestmentDashboardView] Некорректный формат "Синхронизировать с даты": "${configured}". Используется дефолт (3 года назад).`
			);
		}
		return new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
	}

	/**
	 * Парсит бинарный XLSX-файл отчёта Сбера.
	 * Извлекает сделки из листа "Сделки" и денежные операции из листа "Движение ДС".
	 */
	private parseSberXlsx(buffer: ArrayBuffer): Transaction[] {
		const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
		const transactions: Transaction[] = [];

		// ------------------------------------------------------------
		// 1. Парсинг листа "Сделки"
		// ------------------------------------------------------------
		const tradesSheet = workbook.Sheets['Сделки'];
		if (tradesSheet) {
			// Используем raw: false, чтобы все значения приводились к строкам
			const rows = XLSX.utils.sheet_to_json<Record<string, any>>(tradesSheet, { defval: '', raw: false });
			for (const row of rows) {
				const dateStr = String(row['Дата заключения'] || '').trim();
				const ticker = String(row['Код финансового инструмента'] || '').trim();
				const operation = String(row['Операция'] || '').trim();
				const quantity = parseFloat(String(row['Количество'] || '0'));
				const price = parseFloat(String(row['Цена'] || '0'));
				const volume = parseFloat(String(row['Объем сделки'] || '0'));
				const currency = String(row['Валюта'] || 'RUB').trim();

				if (!dateStr || !ticker || isNaN(quantity) || isNaN(price) || quantity === 0 || price === 0) {
					continue;
				}

				let type: 'BUY' | 'SELL' | null = null;
				const opLower = operation.toLowerCase();
				if (opLower.includes('покупка')) type = 'BUY';
				else if (opLower.includes('продажа')) type = 'SELL';
				if (!type) continue;

				const isoDate = this.normalizeSberDate(dateStr);
				if (!isoDate) continue;

				const tradeId = String(row['Номер сделки'] || '').trim() || `${isoDate}-${ticker}-${quantity}`;
				transactions.push({
					id: `sber-xlsx-trade-${tradeId}`,
					date: isoDate,
					broker: 'sber',
					ticker: ticker.toUpperCase(),
					shareName: ticker.toUpperCase(),
					type,
					amount: Math.abs(quantity),
					price: Math.abs(price),
					totalSum: Math.abs(volume) || Math.abs(quantity * price),
					currency: currency.toUpperCase()
				});
			}
		}

		// ------------------------------------------------------------
		// 2. Парсинг листа "Движение ДС"
		// ------------------------------------------------------------
		const cashSheet = workbook.Sheets['Движение ДС'];
		if (cashSheet) {
			const rows = XLSX.utils.sheet_to_json<Record<string, any>>(cashSheet, { defval: '', raw: false });
			for (const row of rows) {
				const dateStr = String(row['Дата исполнения поручения'] || '').trim();
				const operationText = String(row['Операция'] || '').trim();
				const ticker = String(row['Код финансового инструмента'] || 'RUB').trim();
				const sum = parseFloat(String(row['Сумма'] || '0'));
				const currency = String(row['Валюта операции'] || 'RUB').trim();
				const description = String(row['Содержание операции'] || '').trim();

				if (!dateStr || isNaN(sum) || sum === 0) continue;

				let type: 'CASH_IN' | 'CASH_OUT' | 'FEE' | null = null;
				const opLower = operationText.toLowerCase();

				if (opLower.includes('пополнение')) {
					type = 'CASH_IN';
				} else if (opLower.includes('вывод') || opLower.includes('списание')) {
					if (description.toLowerCase().includes('комиссия') || opLower.includes('комиссия')) {
						type = 'FEE';
					} else {
						type = 'CASH_OUT';
					}
				} else if (opLower.includes('комиссия')) {
					type = 'FEE';
				} else {
					continue;
				}

				const isoDate = this.normalizeSberDate(dateStr);
				if (!isoDate) continue;

				transactions.push({
					id: `sber-xlsx-cash-${isoDate}-${type}-${sum}`,
					date: isoDate,
					broker: 'sber',
					ticker: ticker.toUpperCase(),
					shareName: ticker === 'RUB' ? 'RUB' : ticker.toUpperCase(),
					type,
					amount: 1,
					price: Math.abs(sum),
					totalSum: Math.abs(sum),
					currency: currency.toUpperCase()
				});
			}
		}

		transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
		return transactions;
	}

	/**
	 * Приводит дату из XLSX-отчёта Сбера к ISO-формату YYYY-MM-DD.
	 * Поддерживает форматы:
	 *   - "2026-07-18 15:28:08" -> "2026-07-18"
	 *   - "2026-07-18" -> "2026-07-18"
	 *   - "18.07.2026" -> "2026-07-18"
	 */
	private normalizeSberDate(dateStr: string): string {
		const trimmed = dateStr.trim();
		if (!trimmed) return '';

		// ISO: YYYY-MM-DD (опционально с временем)
		const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (isoMatch) {
			return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
		}

		// Русский: DD.MM.YYYY
		const ruMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
		if (ruMatch) {
			return `${ruMatch[3]}-${ruMatch[2]}-${ruMatch[1]}`;
		}

		return trimmed.slice(0, 10);
	}

	private async handleSberXlsxImport(file: File): Promise<void> {
		this.isBusy = true;
		this.setButtonsDisabled(true);
		this.setStatus(`Импорт XLSX-файла "${file.name}"...`);

		try {
			const arrayBuffer = await this.readFileAsArrayBuffer(file);
			const transactions = this.parseSberXlsx(arrayBuffer);

			if (transactions.length === 0) {
				new Notice('XLSX-отчёт обработан, но операций не найдено.');
				this.setStatus(`Файл "${file.name}" обработан: операций не найдено.`);
				return;
			}

			await this.plugin.dataStore.saveTransactions(transactions);

			new Notice(`Импорт XLSX-отчёта Сбера завершён: обработано ${transactions.length} операций.`);
			await this.updateDashboard();
		} catch (error) {
			console.error('[InvestmentDashboardView] Ошибка импорта XLSX-отчёта Сбера.', error);
			this.setStatus('Ошибка импорта XLSX-отчёта. Подробности — в консоли разработчика.');
			new Notice('Не удалось импортировать XLSX-отчёт Сбера. См. консоль (Ctrl+Shift+I).');
		} finally {
			this.isBusy = false;
			this.setButtonsDisabled(false);
		}
	}

	private readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (reader.result instanceof ArrayBuffer) {
					resolve(reader.result);
				} else {
					reject(new Error('Не удалось прочитать файл как ArrayBuffer.'));
				}
			};
			reader.onerror = () => reject(reader.error ?? new Error('Ошибка чтения файла.'));
			reader.readAsArrayBuffer(file);
		});
	}

	// ---------------------------------------------------------------------------
	// Рендеринг динамических данных
	// ---------------------------------------------------------------------------


		private renderSummaryCards(positions: Position[], timeline: PortfolioSnapshot[], transactions: Transaction[]): void {
		const assetsMarketValue = positions.reduce((sum, p) => sum + p.currentTotal, 0);
		const lastSnapshot = timeline.length > 0 ? timeline[timeline.length - 1] : null;
		const cashBalance = lastSnapshot?.cashBalance ?? 0;
		const totalInvested = this.portfolioCalculator.calculateTotalInvested(transactions);

		const totalCapital = assetsMarketValue + cashBalance;
		const profitAbsolute = totalCapital - totalInvested;
		const profitPercent = totalInvested > 0 ? (profitAbsolute / totalInvested) * 100 : 0;

		// Обновляем основные значения.
		if (this.summaryCapitalValueEl) {
			this.summaryCapitalValueEl.empty();
			this.summaryCapitalValueEl.createSpan({ text: formatMoney(totalCapital) });
			this.renderBrokerDropdown(
				this.summaryCapitalValueEl,
				transactions,
				positions,
				'currentValue'
			);
		}

		if (this.summaryInvestedValueEl) {
			this.summaryInvestedValueEl.empty();
			this.summaryInvestedValueEl.createSpan({ text: formatMoney(totalInvested) });
			this.renderBrokerDropdown(
				this.summaryInvestedValueEl,
				transactions,
				positions,
				'totalInvested'
			);
		}

		if (this.summaryProfitValueEl) {
			this.summaryProfitValueEl.empty();
			const span = this.summaryProfitValueEl.createSpan({ text: `${formatMoney(profitAbsolute)} (${formatPercent(profitPercent)})` });
			span.style.color = profitAbsolute >= 0 ? 'var(--text-success, #4caf50)' : 'var(--text-error, #e53935)';
			this.renderBrokerDropdown(
				this.summaryProfitValueEl,
				transactions,
				positions,
				'profit'
			);
		}
	}

	/**
	 * Добавляет стрелочку-дропдаун с раскладкой по брокерам к элементу карточки.
	 */
	private renderBrokerDropdown(
		parentEl: HTMLElement,
		transactions: Transaction[],
		positions: Position[],
		metric: 'currentValue' | 'totalInvested' | 'profit'
	): void {
		const summaries = this.portfolioCalculator.calculateBrokerSummaries(transactions, positions);

		if (summaries.length <= 1) {
			return;
		}

		const toggleEl = parentEl.createSpan({ text: ' ▾', cls: 'investment-broker-toggle' });
		toggleEl.style.cssText = 'cursor: pointer; font-size: 14px; color: var(--text-muted); margin-left: 6px;';

		const dropdownEl = parentEl.createDiv({ cls: 'investment-broker-dropdown' });
		dropdownEl.style.cssText =
			'display: none; margin-top: 8px; padding: 8px; background: var(--background-primary); ' +
			'border: 1px solid var(--background-modifier-border); border-radius: 6px; font-size: 13px;';

		for (const s of summaries) {
			const brokerLabel = s.broker === 'tbank' ? 'Т-Банк' : 'Сбер';
			let value: number;
			let suffix = '';
			if (metric === 'currentValue') {
				value = s.currentValue;
			} else if (metric === 'totalInvested') {
				value = s.totalInvested;
			} else {
				value = s.profit;
				suffix = ` (${formatPercent(s.profitPercent)})`;
			}

			const line = dropdownEl.createDiv();
			line.style.cssText =
				'display: flex; justify-content: space-between; padding: 2px 0; ' +
				`border-left: 3px solid ${s.broker === 'tbank' ? '#F9A825' : '#43A047'}; padding-left: 8px;`;
			line.createSpan({ text: brokerLabel }).style.cssText = 'color: var(--text-muted);';
			const valEl = line.createSpan({ text: formatMoney(value) + suffix });
			if (metric === 'profit') {
				valEl.style.color = value >= 0 ? 'var(--text-success, #4caf50)' : 'var(--text-error, #e53935)';
			}
		}

		toggleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			dropdownEl.style.display = dropdownEl.style.display === 'none' ? 'block' : 'none';
			toggleEl.setText(dropdownEl.style.display === 'none' ? ' ▾' : ' ▴');
		});
	}

	private renderChart(timeline: PortfolioSnapshot[], transactions: Transaction[]): void {
		if (!this.chartContainerEl) { return; }
		this.capitalChart?.destroy();
		
		// Генерируем таймлайны по каждому брокеру
		const brokerTimelines = this.portfolioCalculator.generateBrokerTimelines(transactions);
		
		this.capitalChart = new CapitalChart(this.chartContainerEl, timeline, brokerTimelines);
		this.capitalChart.render();
	}

	private renderPositionsTable(positions: Position[]): void {
		if (!this.positionsTableBodyEl) {
			return;
		}

		this.positionsTableBodyEl.empty();

		if (positions.length === 0) {
			const emptyRow = this.positionsTableBodyEl.createEl('tr');
			const emptyCell = emptyRow.createEl('td', { text: 'Открытых позиций нет.' });
			emptyCell.colSpan = 9;
			emptyCell.style.cssText = 'padding: 12px 10px; color: var(--text-muted); text-align: center;';
			return;
		}

		// Сортировка: сначала все позиции одного брокера, затем другого,
		// внутри группы — по убыванию стоимости.
		const sorted = [...positions].sort((a, b) => {
			const aBroker = a.brokerBreakdown[0]?.broker ?? 'tbank';
			const bBroker = b.brokerBreakdown[0]?.broker ?? 'tbank';
			if (aBroker !== bBroker) {
				return aBroker === 'tbank' ? -1 : 1;
			}
			return b.currentTotal - a.currentTotal;
		});

		// Цвета для строк.
		const TBANK_COLOR = 'rgba(253, 216, 53, 0.14)';   // насыщенный тинькофф-жёлтый
		const SBER_COLOR = 'rgba(102, 187, 106, 0.14)';    // зелёный Сбера

		for (const position of sorted) {
			const hasMultiple = position.brokerBreakdown.length > 1;

			// Основная строка.
			const row = this.positionsTableBodyEl.createEl('tr');
			row.style.cursor = hasMultiple ? 'pointer' : 'default';

			// Цвет строки только если позиция в одном брокере.
			if (!hasMultiple) {
				const broker = position.brokerBreakdown[0]?.broker;
				row.style.backgroundColor = broker === 'tbank' ? TBANK_COLOR : SBER_COLOR;
			}

			const brokerText = hasMultiple
				? '▸ Оба'
				: (position.brokerBreakdown[0]?.broker === 'tbank' ? 'Т-Банк' : 'Сбер');

			this.createTableCell(row, position.ticker, true);
			this.createTableCell(row, position.shareName);
			this.createTableCell(row, brokerText);
			this.createTableCell(row, formatAmount(position.amount));
			this.createTableCell(row, formatMoney(position.averagePrice));
			this.createTableCell(row, formatMoney(position.currentPrice));
			this.createTableCell(row, formatMoney(position.currentTotal));
			this.createTableCell(row, `${position.shareInPortfolio.toFixed(2)}%`);

			const profitCell = this.createTableCell(row, formatPercent(position.profitPercent));
			profitCell.style.color =
				position.profitPercent >= 0 ? 'var(--text-success, #4caf50)' : 'var(--text-error, #e53935)';

			// Раскрывающиеся подстроки для позиций в обоих брокерах.
			if (hasMultiple) {
				const expandRow = this.positionsTableBodyEl.createEl('tr');
				expandRow.style.display = 'none';
				const expandCell = expandRow.createEl('td');
				expandCell.colSpan = 9;
				expandCell.style.cssText = 'padding: 0 10px 8px 24px;';

				for (const bp of position.brokerBreakdown) {
					const subLine = expandCell.createDiv();
					subLine.style.cssText =
						'display: flex; gap: 16px; padding: 4px 0; font-size: 12px; ' +
						`border-left: 3px solid ${bp.broker === 'tbank' ? '#fdd835' : '#66bb6a'}; padding-left: 8px; ` +
						'margin-bottom: 2px;';
					subLine.createSpan({ text: bp.broker === 'tbank' ? 'Т-Банк' : 'Сбер' })
						.style.cssText = 'font-weight: 600; min-width: 60px;';
					subLine.createSpan({ text: `${formatAmount(bp.amount)} шт` });
					subLine.createSpan({ text: `по ${formatMoney(bp.averagePrice)}` });
					subLine.createSpan({ text: `= ${formatMoney(bp.currentValue)}` });
				}

				row.addEventListener('click', () => {
					const isHidden = expandRow.style.display === 'none';
					expandRow.style.display = isHidden ? 'table-row' : 'none';
					const firstCell = row.querySelector('td');
					if (firstCell) {
						firstCell.textContent = isHidden
							? firstCell.textContent?.replace('▸', '▾') ?? ''
							: firstCell.textContent?.replace('▾', '▸') ?? '';
					}
				});

				// Меняем "▸ Оба" во второй колонке таблицы.
				// Проще: добавим текст в ячейку брокера.
				// Уже сделано выше: brokerText = '▸ Оба'.
			}
		}
	}

	/** Создаёт одну ячейку таблицы с базовыми стилями. */
	private createTableCell(row: HTMLTableRowElement, text: string, emphasized = false): HTMLElement {
		const cell = row.createEl('td', { text });
		cell.style.cssText = `padding: 6px 10px; border-bottom: 1px solid var(--background-modifier-border); color: var(--text-normal); ${
			emphasized ? 'font-weight: 600;' : ''
		}`;
		return cell;
	}

	/** Обновляет строку статуса под панелью кнопок. */
	private setStatus(text: string): void {
		if (this.statusEl) {
			this.statusEl.setText(text);
		}
	}

	/** Блокирует/разблокирует обе кнопки на время долгих операций (синк/импорт). */
	private setButtonsDisabled(disabled: boolean): void {
		if (this.syncTBankButtonEl) {
			this.syncTBankButtonEl.disabled = disabled;
		}
	}
}