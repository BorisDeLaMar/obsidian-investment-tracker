// src/parser/sber-html-parser.ts

import { Transaction } from '../types';

/**
 * Приводит число в "русском" текстовом формате к JS-числу.
 * Обрабатывает:
 *  - обычные пробелы и неразрывные пробелы (\u00A0) как разделители тысяч;
 *  - запятую как десятичный разделитель (на случай CSV/Excel-подобных значений);
 *  - лишние пробелы по краям и скрытые непечатаемые символы.
 *
 * Примеры:
 *  "150 000,50" -> 150000.5
 *  "18 276.28"  -> 18276.28
 *  "-18 276.28" -> -18276.28
 *  ""           -> 0
 */
export function parseRussianNumber(val: string | null | undefined): number {
	if (!val) {
		return 0;
	}

	const cleaned = val
		.replace(/\u00A0/g, ' ') // неразрывный пробел -> обычный
		.replace(/[^\d,.\-+]/g, '')
		.trim();

	if (cleaned.length === 0) {
		return 0;
	}

	// Если есть и запятая, и точка — запятая считается разделителем тысяч, точка десятичным.
	// Если есть только запятая — она десятичный разделитель (русский формат).
	let normalized: string;
	if (cleaned.includes(',') && cleaned.includes('.')) {
		normalized = cleaned.replace(/,/g, '');
	} else {
		normalized = cleaned.replace(',', '.');
	}

	const parsed = Number.parseFloat(normalized);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Приводит дату из отчёта Сбера (формат "ДД.ММ.ГГГГ", опционально с временем через пробел)
 * к ISO-формату "YYYY-MM-DD".
 *
 * Примеры:
 *  "18.07.2026"          -> "2026-07-18"
 *  "18.07.2026 15:28:08" -> "2026-07-18"
 *  ""                    -> "" (пустая строка возвращается как есть, чтобы вызывающий код
 *                                мог явно решить, пропускать ли такую строку)
 */
export function parseRussianDate(val: string | null | undefined): string {
	if (!val) {
		return '';
	}

	const trimmed = val.trim();
	if (trimmed.length === 0) {
		return '';
	}

	// Берём только дату, если после неё через пробел идёт время.
	const datePart = trimmed.split(/\s+/)[0];

	const match = datePart.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
	if (!match) {
		return '';
	}

	const [, day, month, year] = match;
	const paddedDay = day.padStart(2, '0');
	const paddedMonth = month.padStart(2, '0');

	return `${year}-${paddedMonth}-${paddedDay}`;
}

/**
 * Очищает текст ячейки таблицы: убирает переносы строк, множественные пробелы,
 * неразрывные пробелы и сноски вида "[¹](#link1)", которые Сбер добавляет к заголовкам колонок.
 */
export function cleanCellText(val: string | null | undefined): string {
	if (!val) {
		return '';
	}

	return val
		.replace(/\[.*?\]\(.*?\)/g, '') // markdown-сноски вида [¹](#link1)
		.replace(/\u00A0/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Парсер HTML-отчётов "СберИнвестиции".
 * Разбирает сырую строку HTML через DOMParser и извлекает транзакции
 * из таблиц "Сделки купли/продажи ценных бумаг" и "Движение денежных средств за период",
 * приводя их к единому интерфейсу Transaction (broker: 'sber').
 */
export class SberHtmlParser {
	private readonly domParser: DOMParser;

	constructor() {
		this.domParser = new DOMParser();
	}

	public parse(htmlContent: string): Transaction[] {
		const doc = this.domParser.parseFromString(htmlContent, 'text/html');

		const trades = this.parseTrades(doc);
		const cashFlows = this.parseCashFlows(doc);
		const dividends = this.parseDividends(doc);
		const openingBalance = this.extractOpeningBalance(doc);

		const result: Transaction[] = [...trades, ...cashFlows, ...dividends];

		// Если есть входящий остаток и есть хотя бы одна сделка — привязываем дату
		// CASH_IN к дате самой ранней сделки, чтобы операция корректно встала в таймлайн.
		if (openingBalance) {
			if (result.length > 0) {
				const earliest = result.reduce((a, b) =>
					new Date(a.date).getTime() < new Date(b.date).getTime() ? a : b
				);
				openingBalance.date = earliest.date;
			} else {
				openingBalance.date = new Date().toISOString();
			}
			result.push(openingBalance);
		}

		return result;
	}

	/**
	 * Извлекает сделки купли/продажи ценных бумаг из таблицы
	 * "Сделки купли/продажи ценных бумаг" -> Transaction[] с type 'BUY' | 'SELL'.
	 * TODO: реализовать в следующем шаге.
	 */
	/**
	 * Извлекает сделки купли/продажи ценных бумаг из таблицы
	 * "Сделки купли/продажи ценных бумаг" -> Transaction[] с type 'BUY' | 'SELL'.
	 *
	 * Отчёт Сбера конвертирует HTML в таблицу с "шумом":
	 *  - заголовок строки повторяется несколько раз (артефакт вёрстки отчёта);
	 *  - есть строка-индекс вида "1 | 2 | 3 | ... | 16";
	 *  - есть строка-разделитель площадки вида "Площадка: Внебиржевой рынок"
	 *    (во всех ячейках одинаковый текст);
	 *  - есть итоговая строка "Итого, RUB".
	 * Все эти строки распознаются и пропускаются, обрабатываются только
	 * реальные строки сделок.
	 */
	private parseTrades(doc: Document): Transaction[] {
		interface ColumnMap {
			date?: number;
			time?: number;
			name?: number;
			ticker?: number;
			currency?: number;
			type?: number;
			amount?: number;
			price?: number;
			sum?: number;
			tradeNumber?: number;
		}

		/** Строит карту "смысл колонки -> индекс ячейки" по тексту заголовка. */
		const buildColumnMap = (headerCells: string[]): ColumnMap => {
			const map: ColumnMap = {};

			headerCells.forEach((text, idx) => {
				if (map.date === undefined && text.includes('Дата заключения')) {
					map.date = idx;
				} else if (map.time === undefined && text.includes('Время заключения')) {
					map.time = idx;
				} else if (map.name === undefined && text.includes('Наименование ЦБ')) {
					map.name = idx;
				} else if (map.ticker === undefined && text.includes('Код ЦБ')) {
					map.ticker = idx;
				} else if (map.currency === undefined && text === 'Валюта') {
					map.currency = idx;
				} else if (map.type === undefined && text === 'Вид') {
					map.type = idx;
				} else if (map.amount === undefined && text.includes('Количество')) {
					map.amount = idx;
				} else if (map.price === undefined && text.includes('Цена')) {
					map.price = idx;
				} else if (
					map.sum === undefined &&
					text.includes('Сумма') &&
					!text.includes('Комис')
				) {
					map.sum = idx;
				} else if (map.tradeNumber === undefined && text.includes('Номер сделки')) {
					map.tradeNumber = idx;
				}
			});

			return map;
		};

		/** Строка-заголовок: содержит одновременно "Дата заключения" и "Код ЦБ". */
		const isHeaderRow = (cells: string[]): boolean => {
			const joined = cells.join(' | ');
			return joined.includes('Дата заключения') && joined.includes('Код ЦБ');
		};

		/** Строка-индекс вида "1 | 2 | 3 | ...": все непустые ячейки — просто числа. */
		const isIndexRow = (cells: string[]): boolean => {
			const nonEmpty = cells.filter((c) => c.length > 0);
			if (nonEmpty.length === 0) {
				return false;
			}
			return nonEmpty.every((c) => /^\d+$/.test(c));
		};

		/**
		 * Строка-разделитель площадки ("Площадка: ...") или итоговая строка ("Итого...").
		 * Дополнительная эвристика: если все непустые ячейки строки одинаковы —
		 * это точно служебная строка, а не реальная сделка.
		 */
		const isSeparatorOrTotalRow = (cells: string[]): boolean => {
			const first = cells[0] ?? '';
			if (first.startsWith('Площадка:') || first.startsWith('Итого')) {
				return true;
			}
			const nonEmpty = cells.filter((c) => c.length > 0);
			if (nonEmpty.length > 1 && nonEmpty.every((c) => c === nonEmpty[0])) {
				return true;
			}
			return false;
		};

		const transactions: Transaction[] = [];
		const tables = Array.from(doc.querySelectorAll('table'));

		for (const table of tables) {
			let columnMap: ColumnMap | null = null;
			let tableMatchedTrades = false;

			const rows = Array.from(table.querySelectorAll('tr'));

			for (const row of rows) {
				const cells = Array.from(row.querySelectorAll('td, th')).map((cell) =>
					cleanCellText(cell.textContent)
				);

				if (cells.length === 0) {
					continue;
				}

				if (isHeaderRow(cells)) {
					// Эта таблица — таблица сделок; фиксируем карту колонок и помечаем таблицу.
					tableMatchedTrades = true;
					columnMap = buildColumnMap(cells);
					continue;
				}

				if (!tableMatchedTrades) {
					// Заголовок сделок в этой таблице ещё не встретился — это не та таблица
					// (например, "Оценка активов" или "Портфель Ценных Бумаг"), пропускаем строку.
					continue;
				}

				if (isIndexRow(cells) || isSeparatorOrTotalRow(cells)) {
					continue;
				}

				if (!columnMap || columnMap.date === undefined || columnMap.type === undefined) {
					console.warn(
						'[SberHtmlParser] Строка сделки встретилась раньше, чем распознан заголовок таблицы, пропущена.',
						cells
					);
					continue;
				}

				const rawDate = cells[columnMap.date] ?? '';
				const isoDate = parseRussianDate(rawDate);
				if (!isoDate) {
					// Не похоже на строку с реальной датой сделки — пропускаем без падения.
					continue;
				}

				const typeText = (columnMap.type !== undefined ? cells[columnMap.type] : '').toLowerCase();
				let type: 'BUY' | 'SELL' | null = null;
				if (typeText.includes('покупка') || typeText.includes('купить')) {
					type = 'BUY';
				} else if (typeText.includes('продажа') || typeText.includes('продать')) {
					type = 'SELL';
				}

				if (!type) {
					console.warn(
						`[SberHtmlParser] Не удалось определить тип сделки по значению "${typeText}", строка пропущена.`,
						cells
					);
					continue;
				}

				const ticker =
					columnMap.ticker !== undefined ? cells[columnMap.ticker]?.trim() ?? '' : '';
				if (!ticker) {
					console.warn('[SberHtmlParser] Строка сделки без тикера, пропущена.', cells);
					continue;
				}

				const shareName =
					(columnMap.name !== undefined ? cells[columnMap.name] : '') || ticker;

				const amount = Math.abs(
					parseRussianNumber(columnMap.amount !== undefined ? cells[columnMap.amount] : '0')
				);
				const price = Math.abs(
					parseRussianNumber(columnMap.price !== undefined ? cells[columnMap.price] : '0')
				);
				const totalSum = Math.abs(
					parseRussianNumber(columnMap.sum !== undefined ? cells[columnMap.sum] : '0')
				) || amount * price;

				const currency =
					(columnMap.currency !== undefined ? cells[columnMap.currency] : '') || 'RUB';

				const rawTime = columnMap.time !== undefined ? cells[columnMap.time] : '';
				const timeSuffix = rawTime.replace(/[^\d]/g, '');

				const tradeNumber =
					columnMap.tradeNumber !== undefined ? cells[columnMap.tradeNumber]?.trim() : '';

				const id = tradeNumber
					? `sber-trade-${isoDate}-${ticker}-${tradeNumber}`
					: `sber-trade-${isoDate}-${ticker}-${timeSuffix}`;

				transactions.push({
					id,
					date: isoDate,
					broker: 'sber',
					ticker,
					shareName,
					type,
					amount,
					price,
					totalSum,
					currency,
					tradeId: tradeNumber || undefined, // добавляем
				});
			}
		}

		return transactions;
	}

	/**
	 * Извлекает движения денежных средств (пополнения, выводы, комиссии и т.п.)
	 * из таблицы "Движение денежных средств за период" -> Transaction[].
	 * TODO: реализовать в следующем шаге.
	 */
	/**
	 * Извлекает движения денежных средств (пополнения, выводы, комиссии и т.п.)
	 * из таблицы "Движение денежных средств за период" -> Transaction[].
	 *
	 * Важно: строки вида "Сделка от ДД.ММ.ГГГГ" — это расчёт по сделке (списание/зачисление
	 * под уже исполненную сделку), а не самостоятельная денежная операция. Такие строки
	 * не матчатся ни под одно ключевое слово (Зачисление/Пополнение/Ввод/Вывод/Списание/
	 * Перевод на карту/Комиссия/Плата за) и намеренно пропускаются, чтобы не задублировать
	 * данные, которые уже извлекаются методом parseTrades.
	 */
	private parseCashFlows(doc: Document): Transaction[] {
		interface ColumnMap {
			date?: number;
			description?: number;
			currency?: number;
			cashIn?: number;
			cashOut?: number;
		}

		/** Строит карту "смысл колонки -> индекс ячейки" по тексту заголовка. */
		const buildColumnMap = (headerCells: string[]): ColumnMap => {
			const map: ColumnMap = {};

			headerCells.forEach((text, idx) => {
				if (map.date === undefined && text === 'Дата') {
					map.date = idx;
				} else if (map.description === undefined && text.includes('Описание операции')) {
					map.description = idx;
				} else if (map.currency === undefined && text === 'Валюта') {
					map.currency = idx;
				} else if (map.cashIn === undefined && text.includes('Сумма зачисления')) {
					map.cashIn = idx;
				} else if (map.cashOut === undefined && text.includes('Сумма списания')) {
					map.cashOut = idx;
				}
			});

			return map;
		};

		/** Строка-заголовок: содержит одновременно "Описание операции" и одну из сумм. */
		const isHeaderRow = (cells: string[]): boolean => {
			const joined = cells.join(' | ');
			return (
				joined.includes('Описание операции') &&
				(joined.includes('Сумма зачисления') || joined.includes('Сумма списания'))
			);
		};

		/** Строка-индекс вида "1 | 2 | 3 | ...": все непустые ячейки — просто числа. */
		const isIndexRow = (cells: string[]): boolean => {
			const nonEmpty = cells.filter((c) => c.length > 0);
			if (nonEmpty.length === 0) {
				return false;
			}
			return nonEmpty.every((c) => /^\d+$/.test(c));
		};

		/** Итоговая строка вида "Итого, RUB" — во всех непустых ячейках одинаковый текст. */
		const isTotalRow = (cells: string[]): boolean => {
			const first = cells[0] ?? '';
			if (first.startsWith('Итого')) {
				return true;
			}
			const nonEmpty = cells.filter((c) => c.length > 0);
			if (nonEmpty.length > 1 && nonEmpty.every((c) => c === nonEmpty[0])) {
				return true;
			}
			return false;
		};

		/** Определяет тип денежной операции по тексту описания. Возвращает null, если не распознано. */
		const resolveCashFlowType = (description: string): 'CASH_IN' | 'CASH_OUT' | 'FEE' | null => {
			const normalized = description.toLowerCase();

			if (
				normalized.includes('зачисление') ||
				normalized.includes('пополнение') ||
				normalized.includes('ввод')
			) {
				return 'CASH_IN';
			}
			if (
				normalized.includes('вывод') ||
				normalized.includes('списание') ||
				normalized.includes('перевод на карту')
			) {
				return 'CASH_OUT';
			}
			if (normalized.includes('комиссия') || normalized.includes('плата за')) {
				return 'FEE';
			}
			return null;
		};

		const transactions: Transaction[] = [];
		const tables = Array.from(doc.querySelectorAll('table'));

		for (const table of tables) {
			let columnMap: ColumnMap | null = null;
			let tableMatchedCashFlows = false;

			const rows = Array.from(table.querySelectorAll('tr'));

			for (const row of rows) {
				const cells = Array.from(row.querySelectorAll('td, th')).map((cell) =>
					cleanCellText(cell.textContent)
				);

				if (cells.length === 0) {
					continue;
				}

				if (isHeaderRow(cells)) {
					// Эта таблица — таблица движения денежных средств; фиксируем карту колонок.
					tableMatchedCashFlows = true;
					columnMap = buildColumnMap(cells);
					continue;
				}

				if (!tableMatchedCashFlows) {
					// Заголовок движения денег в этой таблице ещё не встретился — не та таблица.
					continue;
				}

				if (isIndexRow(cells) || isTotalRow(cells)) {
					continue;
				}

				if (!columnMap || columnMap.date === undefined || columnMap.description === undefined) {
					console.warn(
						'[SberHtmlParser] Строка движения денег встретилась раньше, чем распознан заголовок таблицы, пропущена.',
						cells
					);
					continue;
				}

				const rawDate = cells[columnMap.date] ?? '';
				const isoDate = parseRussianDate(rawDate);
				if (!isoDate) {
					// Не похоже на строку с реальной датой операции — пропускаем без падения.
					continue;
				}

				const description = cells[columnMap.description] ?? '';
				const type = resolveCashFlowType(description);

				if (!type) {
					// Например, "Сделка от ДД.ММ.ГГГГ" — это расчёт по сделке, уже учтённый
					// в parseTrades, а не самостоятельная денежная операция. Пропускаем без шума
					// для типичного случая и с предупреждением для остальных нераспознанных текстов.
					if (!description.toLowerCase().startsWith('сделка от')) {
						console.warn(
							`[SberHtmlParser] Не удалось определить тип денежной операции по описанию "${description}", строка пропущена.`,
							cells
						);
					}
					continue;
				}

				const cashInAmount = Math.abs(
					parseRussianNumber(columnMap.cashIn !== undefined ? cells[columnMap.cashIn] : '0')
				);
				const cashOutAmount = Math.abs(
					parseRussianNumber(columnMap.cashOut !== undefined ? cells[columnMap.cashOut] : '0')
				);

				// Сумма операции — тот из столбцов (зачисление/списание), который ненулевой
				// и соответствует направлению операции. Если оба нулевые — строка бессмысленна, пропускаем.
				const totalSum = type === 'CASH_IN' ? cashInAmount || cashOutAmount : cashOutAmount || cashInAmount;

				if (totalSum === 0) {
					console.warn(
						'[SberHtmlParser] Денежная операция с нулевой суммой, строка пропущена.',
						cells
					);
					continue;
				}

				const currency = (columnMap.currency !== undefined ? cells[columnMap.currency] : '') || 'RUB';

				transactions.push({
					id: `sber-cash-${isoDate}-${type}-${totalSum}`,
					date: isoDate,
					broker: 'sber',
					ticker: 'RUB',
					shareName: 'RUB',
					type,
					amount: 1,
					price: totalSum,
					totalSum,
					currency
				});
			}
		}

		return transactions;
	}

	/**
	 * Извлекает выплаты по ценным бумагам (дивиденды, купоны), если они
	 * присутствуют в отчёте отдельной секцией или помечены в описании операции.
	 * TODO: реализовать в следующем шаге.
	 */
	/**
	 * Извлекает выплаты по ценным бумагам (дивиденды, купоны, а также связанный с ними
	 * удержанный налог) из таблицы с заголовком, содержащим "Выплаты по ценным бумагам",
	 * "Распределение доходов", "Дивиденд" или "Купон" -> Transaction[].
	 *
	 * Если ни одна таблица на странице не содержит такого заголовка (например, за отчётный
	 * период выплат не было — как в примере 424W9UA_21072026.html), метод возвращает [],
	 * так как пополнения/выводы/комиссии уже извлечены в parseCashFlows, а сделки — в parseTrades.
	 *
	 * Отдельно обрабатывается случай, когда строка удержания налога идёт как отдельная запись
	 * без собственного тикера (типичная вёрстка брокерских отчётов): в этом случае тикер и
	 * наименование бумаги наследуются от последней распознанной выплаты (дивиденда/купона).
	 */
	private parseDividends(doc: Document): Transaction[] {
		interface ColumnMap {
			date?: number;
			name?: number;
			ticker?: number;
			isin?: number;
			description?: number;
			amount?: number;
			sum?: number;
			tax?: number;
			currency?: number;
		}

		/** Строит карту "смысл колонки -> индекс ячейки" по тексту заголовка. */
		const buildColumnMap = (headerCells: string[]): ColumnMap => {
			const map: ColumnMap = {};

			headerCells.forEach((text, idx) => {
				if (map.date === undefined && (text.includes('Дата выплаты') || text === 'Дата')) {
					map.date = idx;
				} else if (map.name === undefined && text.includes('Наименование')) {
					map.name = idx;
				} else if (map.ticker === undefined && text.includes('Код ЦБ')) {
					map.ticker = idx;
				} else if (map.isin === undefined && text.includes('ISIN')) {
					map.isin = idx;
				} else if (
					map.description === undefined &&
					(text.includes('Тип выплаты') || text.includes('Вид операции') || text.includes('Описание'))
				) {
					map.description = idx;
				} else if (map.amount === undefined && text.includes('Количество')) {
					map.amount = idx;
				} else if (
					map.sum === undefined &&
					(text.includes('Сумма выплаты') || (text.includes('Сумма') && !text.includes('налог') && !text.includes('Налог')))
				) {
					map.sum = idx;
				} else if (
					map.tax === undefined &&
					(text.includes('Сумма налога') || text.includes('Удержанный налог') || text.includes('НДФЛ'))
				) {
					map.tax = idx;
				} else if (map.currency === undefined && text === 'Валюта') {
					map.currency = idx;
				}
			});

			return map;
		};

		/** Строка-заголовок таблицы выплат: должна упоминать один из ключевых маркеров. */
		const isHeaderRow = (cells: string[]): boolean => {
			const joined = cells.join(' | ');
			const hasSectionMarker =
				joined.includes('Выплаты по ценным бумагам') ||
				joined.includes('Распределение доходов') ||
				joined.includes('Дивиденд') ||
				joined.includes('Купон');
			const looksLikeTableHeader =
				joined.includes('Сумма') || joined.includes('Дата') || joined.includes('Тип выплаты');
			return hasSectionMarker && looksLikeTableHeader;
		};

		/** Строка-индекс вида "1 | 2 | 3 | ...": все непустые ячейки — просто числа. */
		const isIndexRow = (cells: string[]): boolean => {
			const nonEmpty = cells.filter((c) => c.length > 0);
			if (nonEmpty.length === 0) {
				return false;
			}
			return nonEmpty.every((c) => /^\d+$/.test(c));
		};

		/** Строка-разделитель площадки или итоговая строка. */
		const isSeparatorOrTotalRow = (cells: string[]): boolean => {
			const first = cells[0] ?? '';
			if (first.startsWith('Площадка:') || first.startsWith('Итого')) {
				return true;
			}
			const nonEmpty = cells.filter((c) => c.length > 0);
			if (nonEmpty.length > 1 && nonEmpty.every((c) => c === nonEmpty[0])) {
				return true;
			}
			return false;
		};

		/** Определяет тип выплаты по тексту описания. Возвращает null, если не распознано. */
		const resolvePaymentType = (description: string): 'DIV' | 'COUPON' | 'TAX' | null => {
			const normalized = description.toLowerCase();

			if (normalized.includes('дивиденд') || normalized.includes('выплата дохода по акциям')) {
				return 'DIV';
			}
			if (normalized.includes('купон') || normalized.includes('погашение купона')) {
				return 'COUPON';
			}
			if (normalized.includes('налог') || normalized.includes('ндфл')) {
				return 'TAX';
			}
			return null;
		};

		const transactions: Transaction[] = [];
		const tables = Array.from(doc.querySelectorAll('table'));

		for (const table of tables) {
			let columnMap: ColumnMap | null = null;
			let tableMatchedDividends = false;

			// Наследование тикера/названия для строк удержания налога без собственного тикера.
			let lastTicker = '';
			let lastShareName = '';

			const rows = Array.from(table.querySelectorAll('tr'));

			for (const row of rows) {
				const cells = Array.from(row.querySelectorAll('td, th')).map((cell) =>
					cleanCellText(cell.textContent)
				);

				if (cells.length === 0) {
					continue;
				}

				if (isHeaderRow(cells)) {
					tableMatchedDividends = true;
					columnMap = buildColumnMap(cells);
					continue;
				}

				if (!tableMatchedDividends) {
					// Заголовок таблицы выплат в этой таблице ещё не встретился — не та таблица.
					continue;
				}

				if (isIndexRow(cells) || isSeparatorOrTotalRow(cells)) {
					continue;
				}

				if (!columnMap) {
					console.warn(
						'[SberHtmlParser] Строка выплаты встретилась раньше, чем распознан заголовок таблицы, пропущена.',
						cells
					);
					continue;
				}

				const rawDate = columnMap.date !== undefined ? cells[columnMap.date] ?? '' : '';
				const isoDate = parseRussianDate(rawDate);
				if (!isoDate) {
					// Строка без распознаваемой даты выплаты — пропускаем без падения.
					continue;
				}

				const descriptionSource =
					columnMap.description !== undefined ? cells[columnMap.description] : cells.join(' ');
				const type = resolvePaymentType(descriptionSource ?? '');

				if (!type) {
					console.warn(
						`[SberHtmlParser] Не удалось определить тип выплаты по описанию "${descriptionSource}", строка пропущена.`,
						cells
					);
					continue;
				}

				let ticker = columnMap.ticker !== undefined ? cells[columnMap.ticker]?.trim() ?? '' : '';
				let shareName = columnMap.name !== undefined ? cells[columnMap.name]?.trim() ?? '' : '';

				if (!ticker && columnMap.isin !== undefined) {
					// Тикера может не быть, но есть ISIN — используем его как идентификатор актива.
					ticker = cells[columnMap.isin]?.trim() ?? '';
				}

				if (!ticker && type === 'TAX') {
					// Типичный случай: строка удержания налога идёт отдельной записью без своего
					// тикера — наследуем его от последней распознанной выплаты (дивиденда/купона).
					ticker = lastTicker;
					shareName = shareName || lastShareName;
				}

				if (!ticker) {
					console.warn('[SberHtmlParser] Строка выплаты без тикера/ISIN, пропущена.', cells);
					continue;
				}

				if (!shareName) {
					shareName = ticker;
				}

				if (type === 'DIV' || type === 'COUPON') {
					lastTicker = ticker;
					lastShareName = shareName;
				}

				const amount = Math.abs(
					parseRussianNumber(columnMap.amount !== undefined ? cells[columnMap.amount] : '0')
				);

				const totalSum =
					type === 'TAX'
						? Math.abs(parseRussianNumber(columnMap.tax !== undefined ? cells[columnMap.tax] : cells[columnMap.sum ?? -1] ?? '0'))
						: Math.abs(parseRussianNumber(columnMap.sum !== undefined ? cells[columnMap.sum] : '0'));

				if (totalSum === 0) {
					console.warn('[SberHtmlParser] Выплата с нулевой суммой, строка пропущена.', cells);
					continue;
				}

				const price = amount > 0 ? totalSum / amount : 0;
				const currency = (columnMap.currency !== undefined ? cells[columnMap.currency] : '') || 'RUB';

				transactions.push({
					id: `sber-div-${isoDate}-${ticker}-${type}-${totalSum}`,
					date: isoDate,
					broker: 'sber',
					ticker,
					shareName,
					type,
					amount,
					price,
					totalSum,
					currency
				});
			}
		}

		return transactions;
	}

		/**
	 * Извлекает входящий остаток из сводной таблицы движения денежных средств
	 * и создаёт синтетическую транзакцию CASH_IN. Если остаток не найден или
	 * равен нулю — возвращает null.
	 */
	private extractOpeningBalance(doc: Document): Transaction | null {
		// Ищем текст "Входящий остаток" в любой таблице на странице.
		const tables = Array.from(doc.querySelectorAll('table'));
		for (const table of tables) {
			const rows = Array.from(table.querySelectorAll('tr'));
			for (const row of rows) {
				const cells = Array.from(row.querySelectorAll('td, th')).map((cell) =>
					cleanCellText(cell.textContent)
				);
				if (cells.length === 0) {
					continue;
				}
				const firstCell = cells[0] ?? '';
				if (!firstCell.toLowerCase().includes('входящий остаток')) {
					continue;
				}
				// Формат: "Входящий остаток | 18 420.89 | RUB"
				const sumStr = cells[1] ?? '0';
				const sum = parseRussianNumber(sumStr);
				if (sum <= 0) {
					return null;
				}
				const currency = (cells[2] ?? 'RUB').trim() || 'RUB';
				// Дата начала периода извлекается из первой сделки (parseTrades уже
				// отработал раньше в parse() — но здесь мы внутри parseCashFlows,
				// дату берём из первой ячейки заголовка, если есть, иначе 01.01.2000).
				// Проще: используем первую найденную дату сделки из отчёта или дефолт.
				// Так как дата начала периода не хранится в самой таблице движения,
				// берём её из document.title или из секции "Оценка активов".
				// Fallback: пустая дата, DataStore сам разберётся с сортировкой.
				return {
					id: `sber-opening-balance-${currency}-${sum}`,
					date: '', // будет заполнено при мерже с другими транзакциями
					broker: 'sber',
					ticker: 'RUB',
					shareName: 'Входящий остаток',
					type: 'CASH_IN',
					amount: 1,
					price: sum,
					totalSum: sum,
					currency
				};
			}
		}
		return null;
	}
}
