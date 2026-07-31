// src/api/moex-api.ts

import { requestUrl } from 'obsidian';
import { InstrumentKind } from '../types';

/**
 * Определяет тип инструмента по паттерну тикера/ISIN, полученному из брокерского отчёта.
 *  - Внутренние коды фондов брокера (Т-Банк BPIF) заканчиваются на "@" — например "TRUR@".
 *    MOEX ISS не знает такие коды в принципе, это внутренняя нотация конкретного брокера.
 *  - Гособлигации (ОФЗ) начинаются с "SU" и состоят из цифр и заканчиваются на "RMFS"-суффикс.
 *  - Корпоративные облигации в отчётах приходят как полный ISIN "RU000A..." (12 символов).
 *  - Всё остальное считается акцией (обычный короткий тикер вида "SBER", "SMLT" и т.п.).
 * Эвристика приблизительная — построена по фактически встретившимся тикерам в этом проекте,
 * не является официальным классификатором MOEX.
 */
export function detectInstrumentKind(ticker: string): InstrumentKind {
	if (ticker.endsWith('@')) {
		return 'FUND';
	}
	if (/^SU\d+RMFS\d$/i.test(ticker)) {
		return 'BOND';
	}
	if (/^RU[0-9A-Z]{10}$/i.test(ticker) && ticker.length === 12) {
		return 'BOND';
	}
	return 'STOCK';
}

export interface MoexPriceInfo {
	/** Для акций/фондов — цена за штуку в рублях. Для облигаций — цена в % от номинала. */
	price: number;
	/** Заполнено только для облигаций — номинал одной штуки в рублях. */
	faceValue?: number;
	/** Валюта номинала (например 'RUB', 'USD') — для квазивалютных облигаций. */
	faceCurrency?: string;
	instrumentKind: InstrumentKind;
}

/**
 * Клиент бесплатного публичного API Московской Биржи (MOEX ISS).
 *
 * Базовый адрес: https://iss.moex.com/iss
 * Используемый метод: engines/stock/markets/shares/securities.json — групповой
 * запрос по списку тикеров одним HTTP-вызовом (без авторизации, без лимитов
 * на количество тикеров в разумных пределах одного запроса).
 *
 * Запросы выполняются через Obsidian requestUrl, а не через fetch, так как
 * requestUrl выполняется в контексте Electron/Node и не подчиняется CORS-политике
 * браузера — обычный fetch из рендер-процесса Obsidian к iss.moex.com может быть
 * заблокирован политикой CORS ответа сервера.
 */
export class MoexApi {
	private static readonly BASE_URL = 'https://iss.moex.com/iss';

	/**
	 * Запрашивает текущие цены по списку тикеров. Акции и фонды идут через борд TQBR
	 * (markets/shares), облигации — отдельным запросом через борд облигаций
	 * (markets/bonds), откуda дополнительно берётся номинал (FACEVALUE), необходимый
	 * для перевода процентной цены облигации в рублёвую стоимость.
	 * Тикеры, определённые как FUND (внутренние коды брокера вида "TRUR@"), не запрашиваются
	 * у MOEX вообще — для них ожидается отдельный fallback через API брокера (T-Invest).
	 */
	public async fetchCurrentPrices(tickers: string[]): Promise<Map<string, MoexPriceInfo>> {
		const result = new Map<string, MoexPriceInfo>();

		const stockTickers: string[] = [];
		const bondTickers: string[] = [];

		for (const ticker of tickers) {
			const kind = detectInstrumentKind(ticker);
			if (kind === 'FUND') {
				// MOEX не знает внутренние коды фондов брокера — сознательно пропускаем,
				// цена для них будет получена (если возможно) через T-Invest API fallback.
				continue;
			}
			if (kind === 'BOND') {
				bondTickers.push(ticker);
			} else {
				stockTickers.push(ticker);
			}
		}

		if (stockTickers.length > 0) {
			await this.fetchStockPrices(stockTickers, result);
		}
		if (bondTickers.length > 0) {
			await this.fetchBondPrices(bondTickers, result);
		}

		return result;
	}

	/** Запрашивает цены акций через борд TQBR (существующая логика, адаптированная под MoexPriceInfo). */
	private async fetchStockPrices(tickers: string[], result: Map<string, MoexPriceInfo>): Promise<void> {
		const tickersParam = tickers.join(',');
		const url = `${MoexApi.BASE_URL}/engines/stock/markets/shares/boards/TQBR/securities.json?securities=${encodeURIComponent(tickersParam)}&iss.meta=off`;

		try {
			const response = await requestUrl({ url, method: 'GET', throw: false });
			if (response.status < 200 || response.status >= 300) {
				console.warn(`[MoexApi] MOEX ISS вернул статус ${response.status} для акций.`);
				return;
			}
			const body = JSON.parse(response.text);
			this.extractPricesFromShareResponse(body, tickers, result);
		} catch (error) {
			console.warn('[MoexApi] Сетевая ошибка при запросе цен акций.', error);
		}
	}

	/**
	 * Запрашивает цены и номиналы облигаций через борд облигаций MOEX ISS. Пробует TQCB
	 * (корпоративные облигации), затем TQOB (ОФЗ) для тех тикеров, что не нашлись в TQCB —
	 * так как заранее неизвестно, к какому именно борду относится конкретная облигация.
	 */
	private async fetchBondPrices(tickers: string[], result: Map<string, MoexPriceInfo>): Promise<void> {
		const remaining = new Set(tickers);

		for (const board of ['TQCB', 'TQOB']) {
			if (remaining.size === 0) {
				break;
			}

			const tickersParam = Array.from(remaining).join(',');
			const url = `${MoexApi.BASE_URL}/engines/stock/markets/bonds/boards/${board}/securities.json?securities=${encodeURIComponent(tickersParam)}&iss.meta=off`;

			try {
				const response = await requestUrl({ url, method: 'GET', throw: false });
				if (response.status < 200 || response.status >= 300) {
					console.warn(`[MoexApi] MOEX ISS вернул статус ${response.status} для облигаций (борд ${board}).`);
					continue;
				}
				const body = JSON.parse(response.text);
				const resolvedTickers = this.extractPricesFromBondResponse(body, Array.from(remaining), result);
				for (const resolvedTicker of resolvedTickers) {
					remaining.delete(resolvedTicker);
				}
			} catch (error) {
				console.warn(`[MoexApi] Сетевая ошибка при запросе цен облигаций (борд ${board}).`, error);
			}
		}

		for (const ticker of remaining) {
			console.warn(`[MoexApi] Не удалось получить цену облигации "${ticker}" ни на TQCB, ни на TQOB.`);
		}
	}

	private extractPricesFromShareResponse(
		body: unknown,
		requestedTickers: string[],
		result: Map<string, MoexPriceInfo>
	): void {
		const rows = this.extractSecuritiesMarketdataRows(body);

		for (const ticker of requestedTickers) {
			const row = rows.find((r) => r.SECID === ticker);
			if (!row) {
				console.warn(`[MoexApi] Тикер "${ticker}" не найден в ответе MOEX ISS (акции).`);
				continue;
			}

			const price = row.LAST ?? row.PREVPRICE;
			if (price == null) {
				console.warn(`[MoexApi] Не удалось получить ни LAST, ни PREVPRICE для тикера "${ticker}" из ответа MOEX ISS. Тикер пропущен в результирующем объекте цен.`);
				continue;
			}

			result.set(ticker, { price, instrumentKind: 'STOCK' });
		}
	}

	private extractPricesFromBondResponse(
		body: unknown,
		requestedTickers: string[],
		result: Map<string, MoexPriceInfo>
	): string[] {
		const marketdataRows = this.extractSecuritiesMarketdataRows(body);
		const securitiesRows = this.extractSecuritiesDescriptionRows(body);
		const resolved: string[] = [];

		for (const ticker of requestedTickers) {
			const marketRow = marketdataRows.find((r) => r.SECID === ticker);
			const descRow = securitiesRows.find((r) => r.SECID === ticker);

			const price = marketRow?.LAST ?? marketRow?.PREVPRICE;
			const faceValue = descRow?.FACEVALUE;
			const faceCurrency = descRow?.FACEUNIT; // Получаем валюту номинала

			if (price == null || faceValue == null) {
				continue;
			}

			// --- ДОБАВЛЯЕМ faceCurrency В result.set ---
			result.set(ticker, { 
				price, 
				faceValue, 
				faceCurrency: faceCurrency ?? undefined, // <--- ИСПРАВЛЕНИЕ: явно превращаем null в undefined
				instrumentKind: 'BOND' 
			});
			resolved.push(ticker);
		}

		return resolved;
	}

	/** Извлекает строки блока "marketdata" (LAST/PREVPRICE) из сырого JSON-ответа MOEX ISS. */
	private extractSecuritiesMarketdataRows(body: unknown): Array<{ SECID: string; LAST: number | null; PREVPRICE: number | null }> {
		if (typeof body !== 'object' || body === null || !('marketdata' in body)) {
			return [];
		}
		const marketdata = (body as { marketdata: { columns: string[]; data: unknown[][] } }).marketdata;
		if (!marketdata?.columns || !marketdata?.data) {
			return [];
		}

		const secIdIndex = marketdata.columns.indexOf('SECID');
		const lastIndex = marketdata.columns.indexOf('LAST');
		const prevPriceIndex = marketdata.columns.indexOf('PREVPRICE');

		return marketdata.data.map((row) => ({
			SECID: row[secIdIndex] as string,
			LAST: (row[lastIndex] as number | null) ?? null,
			PREVPRICE: (row[prevPriceIndex] as number | null) ?? null
		}));
	}

	private extractSecuritiesDescriptionRows(body: unknown): Array<{ SECID: string; FACEVALUE: number | null; FACEUNIT: string | null }> {
		if (typeof body !== 'object' || body === null || !('securities' in body)) {
			return [];
		}
		const securities = (body as { securities: { columns: string[]; data: unknown[][] } }).securities;
		if (!securities?.columns || !securities?.data) {
			return [];
		}

		const secIdIndex = securities.columns.indexOf('SECID');
		const faceValueIndex = securities.columns.indexOf('FACEVALUE');
		const faceUnitIndex = securities.columns.indexOf('FACEUNIT');

		// Если какая-то колонка не найдена — возвращаем пустой массив, чтобы не ломать логику
		if (secIdIndex === -1 || faceValueIndex === -1 || faceUnitIndex === -1) {
			return [];
		}

		return securities.data.map((row) => ({
			SECID: String(row[secIdIndex] ?? ''), // Приводим к строке
			FACEVALUE: typeof row[faceValueIndex] === 'number' ? row[faceValueIndex] : null,
			FACEUNIT: typeof row[faceUnitIndex] === 'string' ? row[faceUnitIndex] : null // Безопасное приведение
		}));
	}
}