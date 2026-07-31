// src/parser/index.ts

import { Transaction } from '../types';
import { SberHtmlParser } from './sber-html-parser';
import { SberXlsxParser } from './sber-xlsx-parser';
import { TBankApi, TBankApiError } from '../api/tbank-api';

export class ReportParserDispatcher {
    private readonly sberHtmlParser: SberHtmlParser;
    private readonly tbankApi: TBankApi;
    private readonly sberXlsxParser: SberXlsxParser;

    constructor(
        sberHtmlParser?: SberHtmlParser,
        tbankApi?: TBankApi,
        sberXlsxParser?: SberXlsxParser
    ) {
        this.sberHtmlParser = sberHtmlParser ?? new SberHtmlParser();
        this.tbankApi = tbankApi ?? new TBankApi();
        this.sberXlsxParser = sberXlsxParser ?? new SberXlsxParser();
    }

	/**
	 * Парсит новый формат отчёта Сбера (табличная выгрузка XLSX).
	 */
	public parseSberXlsx(content: string): Transaction[] {
		if (!content || content.trim().length === 0) {
			return [];
		}
		try {
			return this.sberXlsxParser.parse(content);
		} catch (error) {
			console.error('[ReportParserDispatcher] Ошибка при парсинге XLSX-отчёта Сбера.', error);
			return [];
		}
	}

	public parseSberHtml(htmlContent: string): Transaction[] {
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

	/**
	 * Лёгкая проверка токена T-Invest API без запроса отчётов (см. TBankApi.checkConnection).
	 */
	public async checkTBankConnection(token: string): Promise<{ accountId: string; accountName: string }> {
		return this.tbankApi.checkConnection(token);
	}

	public async fetchTBankLastPrices(token: string, figiList: string[]): Promise<Map<string, number>> {
		return this.tbankApi.fetchLastPricesByFigi(token, figiList);
	}
}