// src/parser/index.ts

import { Transaction } from '../types';
import { SberHtmlParser } from './sber-html-parser';
import { SberXlsxParser } from './sber-xlsx-parser';
import { TBankXlsxParser } from './tbank-xlsx-parser'; // <--- Добавили
import { TBankApi, TBankApiError } from '../api/tbank-api';

export class ReportParserDispatcher {
    private readonly sberHtmlParser: SberHtmlParser;
    private readonly sberXlsxParser: SberXlsxParser;
    private readonly tbankXlsxParser: TBankXlsxParser; // <--- Добавили
    private readonly tbankApi: TBankApi;

    constructor(
        sberHtmlParser?: SberHtmlParser,
        sberXlsxParser?: SberXlsxParser,
        tbankXlsxParser?: TBankXlsxParser, // <--- Добавили
        tbankApi?: TBankApi
    ) {
        this.sberHtmlParser = sberHtmlParser ?? new SberHtmlParser();
        this.sberXlsxParser = sberXlsxParser ?? new SberXlsxParser();
        this.tbankXlsxParser = tbankXlsxParser ?? new TBankXlsxParser(); // <--- Инициализация
        this.tbankApi = tbankApi ?? new TBankApi();
    }

    public parseSberHtml(htmlContent: string): Transaction[] {
        // ... существующий код
        if (!htmlContent || htmlContent.trim().length === 0) {
            console.warn('[ReportParserDispatcher] Получен пустой HTML-контент отчёта Сбера, парсинг пропущен.');
            return [];
        }
        try {
            return this.sberHtmlParser.parse(htmlContent);
        } catch (error) {
            console.error('[ReportParserDispatcher] Ошибка при парсинге HTML-отчёта Сбера.', error);
            return [];
        }
    }

    public async resolveTBankIsin(token: string, ticker: string): Promise<string | null> {
        if (!token || !ticker) return null;
        return this.tbankApi.resolveIsinByTicker(token, ticker);
    }

    public async fetchTBankLastPrices(token: string, identifiers: string[]): Promise<Map<string, number>> {
        return this.tbankApi.fetchLastPrices(token, identifiers);
    }

	// Метод для парсинга Сбера XLSX (новый)
	public parseSberXlsx(buffer: ArrayBuffer): Transaction[] {
		if (!buffer || buffer.byteLength === 0) {
			return [];
		}
		try {
			return this.sberXlsxParser.parse(buffer);
		} catch (error) {
			console.error('[ReportParserDispatcher] Ошибка при парсинге XLSX-отчёта Сбера.', error);
			return [];
		}
	}

    // <--- НОВЫЙ МЕТОД
    public parseTBankXlsx(buffer: ArrayBuffer): Transaction[] {
        if (!buffer || buffer.byteLength === 0) {
            return [];
        }
        try {
            return this.tbankXlsxParser.parse(buffer);
        } catch (error) {
            console.error('[ReportParserDispatcher] Ошибка при парсинге XLSX-отчёта Т-Банка.', error);
            return [];
        }
    }

    public async fetchTBankApi(
        token: string,
        fromDate: string,
        toDate: string
    ): Promise<Transaction[]> {
        try {
            return await this.tbankApi.fetchBrokerReport(token, fromDate, toDate);
        } catch (error) {
            if (error instanceof TBankApiError) {
                console.error(`[ReportParserDispatcher] Ошибка T-Invest API: ${error.message}`, error.cause);
            } else {
                console.error('[ReportParserDispatcher] Непредвиденная ошибка при обращении к T-Invest API.', error);
            }
            throw error;
        }
    }

    public async checkTBankConnection(token: string): Promise<{ accountId: string; accountName: string }> {
        return this.tbankApi.checkConnection(token);
    }

	/**
	 * Получает FIGI через T-Invest API по тикеру (или ISIN).
	 */
	public async resolveTBankFigi(token: string, ticker: string): Promise<string | null> {
		if (!token || !ticker) return null;
		return this.tbankApi.resolveFigiByTicker(token, ticker);
	}
}