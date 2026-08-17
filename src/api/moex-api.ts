import { requestUrl } from 'obsidian';
import { InstrumentKind } from '../types';

export function detectInstrumentKind(ticker: string): InstrumentKind {
    const clean = ticker.replace(/@$/, '');
    if (clean.endsWith('@')) return 'FUND';
    if (/^SU\d+RMFS/i.test(clean)) return 'BOND';
    if (/^RU[0-9A-Z]{10}$/i.test(clean) && clean.length === 12) return 'BOND';
    if (clean.includes('обб')) return 'BOND';
    return 'STOCK';
}

export interface MoexPriceInfo {
    price: number;
    faceValue?: number;
    faceCurrency?: string;
    rubRate?: number;
    instrumentKind: InstrumentKind;
    shareName?: string;
    hasMarketPrice?: boolean; // явно указываем, есть ли рыночная цена
}

export class MoexApi {
    private static readonly BASE_URL = 'https://iss.moex.com/iss';

    // Кеш курсов валют: ключ – код валюты (USD, EUR, CNY), значение – { rate, timestamp }
    private currencyRateCache = new Map<string, { rate: number; timestamp: number }>();
    private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

    private isCacheValid(timestamp: number): boolean {
        return Date.now() - timestamp < MoexApi.CACHE_TTL_MS;
    }

    public async fetchCurrentPrices(tickers: string[]): Promise<Map<string, MoexPriceInfo>> {
        const result = new Map<string, MoexPriceInfo>();
        const safeTickers = tickers.map(t => t.trim().toUpperCase().replace(/@$/, '')).filter(t => t.length > 0);

        const stockTickers: string[] = [];
        const bondTickers: string[] = [];

        for (const ticker of safeTickers) {
            const kind = detectInstrumentKind(ticker);
            if (kind === 'FUND') continue;
            if (kind === 'BOND') bondTickers.push(ticker);
            else stockTickers.push(ticker);
        }

        if (stockTickers.length > 0) await this.fetchStockPrices(stockTickers, result);
        if (bondTickers.length > 0) await this.fetchBondPrices(bondTickers, result);

        // ---- FALLBACK: для облигаций, которые не нашлись, пробуем как акции ----
        const unresolvedBondTickers = bondTickers.filter(t => !result.has(t));
        if (unresolvedBondTickers.length > 0) {
            console.log(`[MoexApi] ${unresolvedBondTickers.length} облигаций не найдены, пробуем как акции:`, unresolvedBondTickers);
            await this.fetchStockPrices(unresolvedBondTickers, result);
        }

        return result;
    }

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

    private async fetchBondPrices(tickers: string[], result: Map<string, MoexPriceInfo>): Promise<void> {
        const remaining = new Set(tickers);

        for (const board of ['TQCB', 'TQOB']) {
            if (remaining.size === 0) break;

            const tickersParam = Array.from(remaining).join(',');
            const url = `${MoexApi.BASE_URL}/engines/stock/markets/bonds/boards/${board}/securities.json?securities=${encodeURIComponent(tickersParam)}&iss.meta=off`;

            try {
                const response = await requestUrl({ url, method: 'GET', throw: false });
                if (response.status < 200 || response.status >= 300) {
                    console.warn(`[MoexApi] MOEX ISS вернул статус ${response.status} для облигаций (борд ${board}).`);
                    continue;
                }
                const body = JSON.parse(response.text);
                const resolvedTickers = await this.extractPricesFromBondResponse(body, Array.from(remaining), result);
                for (const resolved of resolvedTickers) remaining.delete(resolved);
            } catch (error) {
                console.warn(`[MoexApi] Сетевая ошибка при запросе цен облигаций (борд ${board}).`, error);
            }
        }

        for (const ticker of remaining) {
            console.warn(`[MoexApi] Не удалось получить цену облигации "${ticker}" ни на TQCB, ни на TQOB.`);
        }
    }

    private extractPricesFromShareResponse(body: unknown, requestedTickers: string[], result: Map<string, MoexPriceInfo>): void {
        const rows = this.extractSecuritiesMarketdataRows(body);
        for (const ticker of requestedTickers) {
            const row = rows.find(r => r.SECID === ticker);
            if (!row) {
                console.warn(`[MoexApi] Тикер "${ticker}" не найден в ответе MOEX ISS (акции).`);
                continue;
            }
            const price = row.LAST ?? row.PREVPRICE;
            if (price == null) {
                console.warn(`[MoexApi] Не удалось получить ни LAST, ни PREVPRICE для тикера "${ticker}".`);
                continue;
            }
            // Явно устанавливаем hasMarketPrice: true для акций
            result.set(ticker, { price, instrumentKind: 'STOCK', hasMarketPrice: true });
        }
    }

    private async extractPricesFromBondResponse(
        body: unknown,
        requestedTickers: string[],
        result: Map<string, MoexPriceInfo>
    ): Promise<string[]> {
        const marketdataRows = this.extractSecuritiesMarketdataRows(body);
        const securitiesRows = this.extractSecuritiesDescriptionRows(body);
        const resolved: string[] = [];

        for (const ticker of requestedTickers) {
            const marketRow = marketdataRows.find(r => r.SECID === ticker);
            const descRow = securitiesRows.find(r => r.SECID === ticker);
            const shareName = descRow?.SECNAME ?? ticker;

            const price = marketRow?.LAST ?? marketRow?.PREVPRICE;
            const faceValue = descRow?.FACEVALUE;
            const faceCurrency = descRow?.FACEUNIT;

            if (price == null || faceValue == null) continue;

            let rubRate: number | undefined = undefined;
            let hasMarketPrice = false;

            const isRub = !faceCurrency || faceCurrency === 'RUB' || faceCurrency === 'SUR';
            if (isRub) {
                hasMarketPrice = true;
                rubRate = 1;
            } else {
                const rate = await this.getRubRate(faceCurrency);
                if (rate != null) {
                    rubRate = rate;
                    hasMarketPrice = true;
                } else {
                    // Если курс не получен, цена остаётся неизвестной
                    hasMarketPrice = false;
                }
            }

            result.set(ticker, {
                price,
                faceValue,
                faceCurrency: faceCurrency ?? undefined,
                rubRate,
                instrumentKind: 'BOND',
                shareName,
                hasMarketPrice
            });
            resolved.push(ticker);
        }

        return resolved;
    }

    private extractSecuritiesMarketdataRows(body: unknown): Array<{ SECID: string; LAST: number | null; PREVPRICE: number | null }> {
        if (typeof body !== 'object' || body === null || !('marketdata' in body)) return [];
        const marketdata = (body as { marketdata: { columns: string[]; data: unknown[][] } }).marketdata;
        if (!marketdata?.columns || !marketdata?.data) return [];

        const secIdIndex = marketdata.columns.indexOf('SECID');
        const lastIndex = marketdata.columns.indexOf('LAST');
        const prevPriceIndex = marketdata.columns.indexOf('PREVPRICE');

        return marketdata.data.map(row => ({
            SECID: row[secIdIndex] as string,
            LAST: (row[lastIndex] as number | null) ?? null,
            PREVPRICE: (row[prevPriceIndex] as number | null) ?? null
        }));
    }

    private extractSecuritiesDescriptionRows(body: unknown): Array<{ SECID: string; FACEVALUE: number | null; FACEUNIT: string | null; SECNAME: string | null }> {
        if (typeof body !== 'object' || body === null || !('securities' in body)) return [];
        const securities = (body as { securities: { columns: string[]; data: unknown[][] } }).securities;
        if (!securities?.columns || !securities?.data) return [];

        const secIdIndex = securities.columns.indexOf('SECID');
        const faceValueIndex = securities.columns.indexOf('FACEVALUE');
        const faceUnitIndex = securities.columns.indexOf('FACEUNIT');
        const secNameIndex = securities.columns.indexOf('SECNAME');

        if (secIdIndex === -1 || faceValueIndex === -1 || faceUnitIndex === -1 || secNameIndex === -1) return [];

        return securities.data.map(row => ({
            SECID: String(row[secIdIndex] ?? ''),
            FACEVALUE: typeof row[faceValueIndex] === 'number' ? row[faceValueIndex] : null,
            FACEUNIT: typeof row[faceUnitIndex] === 'string' ? row[faceUnitIndex] : null,
            SECNAME: typeof row[secNameIndex] === 'string' ? row[secNameIndex] : null
        }));
    }

    public async getRubRate(currency: string): Promise<number | null> {
        const normalized = currency.toUpperCase();
        const pairMap: Record<string, string> = {
            'USD': 'USDRUB_TOM',
            'EUR': 'EURRUB_TOM',
            'CNY': 'CNYRUB_TOM',
            'SUR': 'RUB'
        };
        const pair = pairMap[normalized];
        if (!pair) return null;
        if (pair === 'RUB') return 1;

        // Проверяем кеш
        const cached = this.currencyRateCache.get(normalized);
        if (cached && this.isCacheValid(cached.timestamp)) {
            return cached.rate;
        }

        const rate = await this.getCbrRate(normalized);
        if (rate != null) {
            this.currencyRateCache.set(normalized, { rate, timestamp: Date.now() });
        }
        return rate;
    }

    private async getCbrRate(currency: string): Promise<number | null> {
        try {
            const formatDate = (date: Date): string => {
                const d = date.getDate().toString().padStart(2, '0');
                const m = (date.getMonth() + 1).toString().padStart(2, '0');
                const y = date.getFullYear();
                return `${d}.${m}.${y}`;
            };

            const datesToTry = [
                new Date(),
                new Date(Date.now() - 24 * 60 * 60 * 1000)
            ];

            const currencyIdMap: Record<string, string> = {
                'USD': 'R01235',
                'CNY': 'R01375',
                'EUR': 'R01239'
            };
            const id = currencyIdMap[currency];
            if (!id) {
                console.warn(`[MOEX] ЦБ РФ: неизвестная валюта ${currency}`);
                return null;
            }

            for (const date of datesToTry) {
                const dateStr = formatDate(date);
                const url = `https://www.cbr.ru/scripts/XML_daily.asp?date_req=${dateStr}`;

                const response = await requestUrl({ url, method: 'GET', throw: false });
                if (response.status !== 200) {
                    console.warn(`[MOEX] ЦБ РФ вернул статус ${response.status} для даты ${dateStr}`);
                    continue;
                }

                const xml = response.text;
                const valuteRegex = new RegExp(`<Valute ID="${id}">([\\s\\S]*?)<\\/Valute>`);
                const match = xml.match(valuteRegex);
                if (!match) {
                    console.log(`[MOEX] ЦБ РФ: валюта ${currency} не найдена за ${dateStr}`);
                    continue;
                }

                const valuteBlock = match[1];
                const valueMatch = valuteBlock.match(/<Value>([^<]+)<\/Value>/);
                if (!valueMatch) {
                    console.log(`[MOEX] ЦБ РФ: не найден тег <Value> для ${currency} за ${dateStr}`);
                    continue;
                }

                const valueStr = valueMatch[1].replace(',', '.');
                const rate = parseFloat(valueStr);
                if (isNaN(rate)) {
                    console.log(`[MOEX] ЦБ РФ: не удалось распарсить число из "${valueStr}"`);
                    continue;
                }

                console.log(`[MOEX] Курс ${currency} от ЦБ РФ (дата ${dateStr}): ${rate}`);
                return rate;
            }

            console.warn(`[MOEX] ЦБ РФ не вернул курс для ${currency} ни за сегодня, ни за вчера.`);
            return null;
        } catch (err) {
            console.warn(`[MOEX] Ошибка при запросе ЦБ РФ:`, err);
            return null;
        }
    }
}