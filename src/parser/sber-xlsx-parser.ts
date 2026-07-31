// src/parser/sber-xlsx-parser.ts

import { Transaction } from '../types';

/**
 * Парсер нового формата Сбера — табличная выгрузка с pipe-разделителями.
 * Содержит три ключевые секции:
 *  1) Таблица "Сделки" (колонки: Номер сделки, Дата заключения, Код инструмента, Операция, Количество, Цена, Объем сделки, Валюта)
 *  2) Таблица "Денежные операции" (колонки: Дата исполнения, Операция, Код инструмента, Сумма, Валюта, Списание с, Зачисление на, Содержание)
 *  3) Таблица "Заявки" (менее приоритетна — сделки дублируются в первой таблице)
 */
export class SberXlsxParser {
	/**
	 * Парсит текстовое содержимое XLSX-выгрузки Сбера (pipe-разделители)
	 * и возвращает массив Transaction[].
	 */
	public parse(content: string): Transaction[] {
		const trades = this.parseTradesSection(content);
		const moneyOps = this.parseMoneySection(content);
		return [...trades, ...moneyOps];
	}

	/**
	 * Ищет секцию со столбцами "Номер сделки", "Дата заключения", "Код финансового инструмента",
	 * "Операция", "Количество", "Цена", "Объем сделки".
	 */
	private parseTradesSection(content: string): Transaction[] {
		const transactions: Transaction[] = [];

		// Ищем заголовок таблицы сделок.
		const tradeHeaderRegex = /Номер\s+сделки.*?Дата\s+заключения.*?Код\s+финансового\s+инструмента.*?Операция.*?Количество.*?Цена.*?Объем\s+сделки.*?Валюта/is;
		const headerMatch = content.match(tradeHeaderRegex);

		if (!headerMatch || headerMatch.index === undefined) {
			return transactions;
		}

		// Берём текст после заголовка до следующей пустой строки или конца секции.
		const startIdx = headerMatch.index + headerMatch[0].length;
		const restContent = content.slice(startIdx);

		// Ищем строки вида "| 424W9UA | 151815932 | 2026-07-18 15:28:08 | SBER | Акция | Внебиржевой рынок | Покупка | 73 | 250.36 | 18276.28 | RUB |"
		const lines = restContent.split('\n');

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('|')) continue;
			// Пропускаем строки-разделители (только тире и плюсы).
			if (/^\|[\s\-+]*\|$/.test(trimmed)) continue;
			// Пропускаем строки-повторы заголовков.
			if (trimmed.includes('Номер договора') && trimmed.includes('Номер сделки')) continue;

			const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);

			// Ожидаемая структура: [договор, номер_сделки, дата, тикер, тип_инструмента, рынок, операция, количество, цена, объем, валюта]
			if (cells.length < 10) continue;

			const tradeNumber = cells[1] ?? '';
			const dateStr = cells[2] ?? '';
			const ticker = cells[3] ?? '';
			// cells[4] = тип инструмента (Акция/Облигация)
			// cells[5] = тип рынка
			const operation = (cells[6] ?? '').toLowerCase();
			const quantityStr = cells[7] ?? '';
			const priceStr = cells[8] ?? '';
			const volumeStr = cells[9] ?? '';
			const currency = cells[10] ?? 'RUB';

			// Пропускаем, если нет даты или тикера.
			if (!dateStr || !ticker) continue;

			let type: 'BUY' | 'SELL' | null = null;
			if (operation.includes('покупка')) type = 'BUY';
			else if (operation.includes('продажа')) type = 'SELL';
			if (!type) continue;

			const amount = Math.abs(this.parseNumber(quantityStr));
			const price = Math.abs(this.parseNumber(priceStr));
			const totalSum = Math.abs(this.parseNumber(volumeStr)) || amount * price;

			const isoDate = this.parseSberDate(dateStr);

			transactions.push({
				id: `sber-xlsx-trade-${tradeNumber || `${isoDate}-${ticker}-${amount}`}`,
				date: isoDate,
				broker: 'sber',
				ticker: ticker.toUpperCase(),
				shareName: ticker.toUpperCase(),
				type,
				amount,
				price,
				totalSum,
				currency: currency.toUpperCase(),
                tradeId: tradeNumber || undefined, // добавляем
			});
		}

		return transactions;
	}

	/**
	 * Ищет секцию денежных операций: "Дата исполнения поручения", "Операция",
	 * "Код финансового инструмента", "Сумма", "Валюта операции", "Содержание операции".
	 */
	private parseMoneySection(content: string): Transaction[] {
		const transactions: Transaction[] = [];

		// Ищем заголовок таблицы денежных операций.
		const moneyHeaderRegex = /Дата\s+исполнения\s+поручения.*?Операция\s*\s+.*?Сумма.*?Валюта\s+операции.*?Содержание\s+операции/is;
		const headerMatch = content.match(moneyHeaderRegex);

		if (!headerMatch || headerMatch.index === undefined) {
			return transactions;
		}

		const startIdx = headerMatch.index + headerMatch[0].length;
		const restContent = content.slice(startIdx);
		const lines = restContent.split('\n');

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('|')) continue;
			if (/^\|[\s\-+]*\|$/.test(trimmed)) continue;
			if (trimmed.includes('Дата подачи') && trimmed.includes('Дата исполнения')) continue;
			if (trimmed.includes('Номер договора списания')) continue;

			const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);

			// Ожидаемая структура: [договор, дата_подачи, дата_исполнения, операция, тикер?, сумма, валюта, списание_с, зачисление_на, содержание, статус]
			if (cells.length < 6) continue;

			const dateStr = cells[2] ?? cells[1] ?? ''; // дата исполнения
			const operationText = (cells[3] ?? '').toLowerCase();
			const tickerOrEmpty = cells[4] ?? '';
			const sumStr = cells[5] ?? '';
			const currency = cells[6] ?? 'RUB';
			const description = cells[9] ?? cells[8] ?? '';

			if (!dateStr) continue;

			let type: 'CASH_IN' | 'CASH_OUT' | 'FEE' | null = null;

			if (operationText.includes('пополнение')) {
				type = 'CASH_IN';
			} else if (operationText.includes('вывод') || operationText.includes('списание')) {
				// Комиссия vs вывод: если есть тикер и описание "Списание комиссии" — это FEE.
				if (description.toLowerCase().includes('комисси') || operationText.includes('комисси')) {
					type = 'FEE';
				} else {
					type = 'CASH_OUT';
				}
			} else if (operationText.includes('комисси')) {
				type = 'FEE';
			} else {
				continue;
			}

			const totalSum = Math.abs(this.parseNumber(sumStr));
			if (totalSum === 0) continue;

			const ticker = tickerOrEmpty && tickerOrEmpty !== 'RUB' ? tickerOrEmpty.toUpperCase() : 'RUB';
			const isoDate = this.parseSberDate(dateStr);

			transactions.push({
				id: `sber-xlsx-money-${isoDate}-${type}-${totalSum}`,
				date: isoDate,
				broker: 'sber',
				ticker,
				shareName: ticker === 'RUB' ? 'RUB' : ticker,
				type,
				amount: 1,
				price: totalSum,
				totalSum,
				currency: currency.toUpperCase()
			});
		}

		return transactions;
	}

	/** Парсит дату Сбера: "2026-07-18 15:28:08" → "2026-07-18" */
	private parseSberDate(dateStr: string): string {
		const trimmed = dateStr.trim();
		// YYYY-MM-DD HH:MM:SS
		const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (match) {
			return `${match[1]}-${match[2]}-${match[3]}`;
		}
		// DD.MM.YYYY
		const ruMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
		if (ruMatch) {
			return `${ruMatch[3]}-${ruMatch[2]}-${ruMatch[1]}`;
		}
		return trimmed.slice(0, 10);
	}

	/** Парсит число: убирает пробелы, обрабатывает запятую и точку. */
	private parseNumber(val: string): number {
		const cleaned = val.replace(/\s/g, '').replace(',', '.');
		const parsed = Number.parseFloat(cleaned);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
}