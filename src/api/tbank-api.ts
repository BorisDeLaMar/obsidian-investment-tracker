// src/api/tbank-api.ts

import { requestUrl } from 'obsidian';
import { Transaction, TransactionType } from '../types';

/**
 * Ошибка взаимодействия с T-Invest API.
 */
export class TBankApiError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'TBankApiError';
    }
}

/**
 * Представление MoneyValue из контракта T-Invest API v2
 */
interface MoneyValue {
    currency: string;
    units: string;
    nano: number;
}

// ---------------------------------------------------------------------------
// Контракты UsersService.GetAccounts
// ---------------------------------------------------------------------------

interface AccountInfo {
    id: string;
    type?: string;
    name?: string;
    status?: string;
}

interface GetAccountsResponseBody {
    accounts?: AccountInfo[];
}

function isAccountsResponse(body: unknown): body is GetAccountsResponseBody {
    return (
        typeof body === 'object' &&
        body !== null &&
        'accounts' in body &&
        Array.isArray((body as GetAccountsResponseBody).accounts)
    );
}

// ---------------------------------------------------------------------------
// Контракты OperationsService.GetBrokerReport (сделки)
// ---------------------------------------------------------------------------

interface GenerateBrokerReportRequestBody {
    generateBrokerReportRequest: {
        accountId: string;
        from: string; // RFC3339
        to: string; // RFC3339
    };
}

interface GetBrokerReportRequestBody {
    getBrokerReportRequest: {
        taskId: string;
        page: number;
    };
}

interface GenerateBrokerReportResponseBody {
    generateBrokerReportResponse: {
        taskId: string;
    };
}

/** Одна строка отчёта о сделках */
interface BrokerReportRow {
    tradeId?: string;
    orderId?: string;
    figi?: string;
    ticker?: string;
    name?: string;
    direction?: string; // "Покупка" | "Продажа"
    quantity?: string;
    price?: MoneyValue;
    orderAmount?: MoneyValue;
    totalOrderAmount?: MoneyValue;
    aciValue?: MoneyValue;
    brokerCommission?: MoneyValue;
    exchangeCommission?: MoneyValue;
    exchangeClearingCommission?: MoneyValue;
    tradeDatetime?: string;
}

interface GetBrokerReportResponseBody {
    getBrokerReportResponse: {
        brokerReport: BrokerReportRow[];
        itemsCount?: number;
        pagesCount?: number;
        page?: number;
    };
}

type BrokerReportResponseBody =
    | GenerateBrokerReportResponseBody
    | GetBrokerReportResponseBody
    | Record<string, unknown>;

function isGenerateResponse(
    body: BrokerReportResponseBody
): body is GenerateBrokerReportResponseBody {
    return (
        typeof body === 'object' &&
        body !== null &&
        'generateBrokerReportResponse' in body &&
        typeof (body as GenerateBrokerReportResponseBody).generateBrokerReportResponse?.taskId ===
            'string'
    );
}

function isReadyResponse(body: BrokerReportResponseBody): body is GetBrokerReportResponseBody {
    return (
        typeof body === 'object' &&
        body !== null &&
        'getBrokerReportResponse' in body &&
        Array.isArray((body as GetBrokerReportResponseBody).getBrokerReportResponse?.brokerReport)
    );
}

// ---------------------------------------------------------------------------
// Контракты OperationsService.GetOperations (деньги, дивиденды, купоны, налоги, комиссии)
// ---------------------------------------------------------------------------

type OperationState =
    | 'OPERATION_STATE_UNSPECIFIED'
    | 'OPERATION_STATE_EXECUTED'
    | 'OPERATION_STATE_CANCELED'
    | 'OPERATION_STATE_PROGRESS';

interface GetOperationsRequestBody {
    accountId: string;
    from: string; // RFC3339
    to: string; // RFC3339
    state?: OperationState;
    figi?: string;
}

interface OperationRow {
    id?: string;
    parentOperationId?: string;
    currency?: string;
    payment?: MoneyValue;
    price?: MoneyValue;
    state?: OperationState;
    quantity?: string;
    quantityRest?: string;
    figi?: string;
    instrumentUid?: string;
    instrumentType?: string;
    date?: string;
    type?: string;
    operationType?: string;
}

interface GetOperationsResponseBody {
    operations?: OperationRow[];
}

function isOperationsResponse(body: unknown): body is GetOperationsResponseBody {
    return (
        typeof body === 'object' &&
        body !== null &&
        'operations' in body &&
        Array.isArray((body as GetOperationsResponseBody).operations)
    );
}

// ---------------------------------------------------------------------------
// Контракты InstrumentsService.GetInstrumentBy (резолвинг FIGI -> тикер/название)
// ---------------------------------------------------------------------------

type InstrumentIdType =
    | 'INSTRUMENT_ID_UNSPECIFIED'
    | 'INSTRUMENT_ID_TYPE_FIGI'
    | 'INSTRUMENT_ID_TYPE_TICKER'
    | 'INSTRUMENT_ID_TYPE_UID'
    | 'INSTRUMENT_ID_TYPE_ISIN';

interface InstrumentRequestBody {
    idType: InstrumentIdType;
    classCode?: string;
    id: string;
}

interface InstrumentShort {
    figi?: string;
    ticker?: string;
    classCode?: string;
    isin?: string;
    name?: string;
    uid?: string;
}

interface GetInstrumentByResponseBody {
    instrument?: InstrumentShort;
}

function isInstrumentResponse(body: unknown): body is GetInstrumentByResponseBody {
    return (
        typeof body === 'object' &&
        body !== null &&
        'instrument' in body &&
        typeof (body as GetInstrumentByResponseBody).instrument === 'object'
    );
}

interface ResolvedInstrument {
    ticker: string;
    shareName: string;
}

// ---------------------------------------------------------------------------
// Таблицы соответствия operationType -> TransactionType
// ---------------------------------------------------------------------------

const TRADE_OPERATION_TYPES = new Set<string>([
    'OPERATION_TYPE_BUY',
    'OPERATION_TYPE_BUY_CARD',
    'OPERATION_TYPE_BUY_MARGIN',
    'OPERATION_TYPE_SELL',
    'OPERATION_TYPE_SELL_CARD',
    'OPERATION_TYPE_SELL_MARGIN',
    'OPERATION_TYPE_DELIVERY_BUY',
]);

const CASH_IN_OPERATION_TYPES = new Set<string>([
    'OPERATION_TYPE_INPUT',
    'OPERATION_TYPE_INPUT_SWIFT',
    'OPERATION_TYPE_INPUT_ACQUIRING',
    'OPERATION_TYPE_INPUT_CASH',
    'OPERATION_TYPE_INPUT_CARD',
    'OPERATION_TYPE_INPUT_OTHER',
    // если API использует числовые коды, но обычно строки
]);

const CASH_OUT_OPERATION_TYPES = new Set<string>([
    'OPERATION_TYPE_OUTPUT',
    'OPERATION_TYPE_OUTPUT_SWIFT',
    'OPERATION_TYPE_OUTPUT_ACQUIRING',
]);

const DIVIDEND_OPERATION_TYPES = new Set<string>([
    'OPERATION_TYPE_DIVIDEND',
    'OPERATION_TYPE_DIV_EXT',
    'OPERATION_TYPE_DIVIDEND_TRANSFER',
]);

const COUPON_OPERATION_TYPES = new Set<string>(['OPERATION_TYPE_COUPON']);

const TAX_OPERATION_TYPES = new Set<string>([
    'OPERATION_TYPE_TAX',
    'OPERATION_TYPE_DIVIDEND_TAX',
    'OPERATION_TYPE_BOND_TAX',
    'OPERATION_TYPE_BENEFIT_TAX',
    'OPERATION_TYPE_TAX_CORRECTION',
    'OPERATION_TYPE_TAX_PROGRESSIVE',
    'OPERATION_TYPE_BOND_TAX_PROGRESSIVE',
    'OPERATION_TYPE_DIVIDEND_TAX_PROGRESSIVE',
    'OPERATION_TYPE_BENEFIT_TAX_PROGRESSIVE',
    'OPERATION_TYPE_TAX_CORRECTION_PROGRESSIVE',
    'OPERATION_TYPE_TAX_CORRECTION_COUPON',
]);

const FEE_OPERATION_TYPES = new Set<string>([
    'OPERATION_TYPE_BROKER_FEE',
    'OPERATION_TYPE_SERVICE_FEE',
    'OPERATION_TYPE_MARGIN_FEE',
    'OPERATION_TYPE_SUCCESS_FEE',
    'OPERATION_TYPE_TRACK_MFEE',
    'OPERATION_TYPE_TRACK_PFEE',
    'OPERATION_TYPE_CASH_FEE',
    'OPERATION_TYPE_OUT_FEE',
    'OPERATION_TYPE_OUT_STAMP_DUTY',
    'OPERATION_TYPE_ADVICE_FEE',
    'OPERATION_TYPE_OVER_COM',
]);

function guessTypeFromText(text: string | undefined): TransactionType | 'TRADE' | null {
    if (!text) return null;
    const normalized = text.toLowerCase();

    // Сделки
    if (normalized.includes('покупка') || normalized.includes('продажа')) return 'TRADE';

    // Пополнения (CASH_IN)
    if (normalized.includes('пополнение') || normalized.includes('ввод денежных') ||
        normalized.includes('зачисление') || normalized.includes('ввод') ||
        normalized.includes('input') || normalized.includes('deposit') ||
        normalized.includes('зачислено') || normalized.includes('поступление') ||
        normalized.includes('внесение') || normalized.includes('пополнить') ||
        normalized.includes('внесено')) {
        return 'CASH_IN';
    }

    // Выводы (CASH_OUT)
    if (normalized.includes('вывод') || normalized.includes('списание') ||
        normalized.includes('withdrawal') || normalized.includes('output')) {
        return 'CASH_OUT';
    }

    // Дивиденды, купоны, налоги, комиссии
    if (normalized.includes('дивиденд')) return 'DIV';
    if (normalized.includes('купон')) return 'COUPON';
    if (normalized.includes('налог')) return 'TAX';
    if (normalized.includes('комис') || normalized.includes('плата') || normalized.includes('сбор')) return 'FEE';

    return null;
}

function resolveNonTradeType(op: OperationRow): TransactionType | 'TRADE' | null {
    const typeText = op.type || '';
    const operationType = op.operationType || '';
    const paymentValue = moneyValueToNumber(op.payment);
    const quantity = parseFloat(op.quantity || '0');
    const priceValue = moneyValueToNumber(op.price);

    // 1. Если есть текстовые маркеры сделки
    if (typeText.includes('Покупка') || typeText.includes('Продажа') ||
        typeText.includes('DFP/RFP') || typeText.includes('DFP') || typeText.includes('RFP') ||
        typeText.includes('NET/RVP') || typeText.includes('NET/RFP') || typeText.includes('NET/DFP') ||
        typeText.includes('Поставка') || typeText.includes('Получение') ||
        typeText.includes('Сделка')) {
        if (paymentValue > 0.001) return 'SELL';
        if (paymentValue < -0.001) return 'BUY';
        // Если payment = 0, но есть количество и цена – пробуем по количеству
        if (quantity > 0 && priceValue > 0) {
            // Не можем определить направление, но оставляем как TRADE (потом пропустим)
            return 'TRADE';
        }
        return null;
    }

    // 2. Если operationType указывает на сделку
    if (TRADE_OPERATION_TYPES.has(operationType)) {
        if (paymentValue > 0.001) return 'SELL';
        if (paymentValue < -0.001) return 'BUY';
        return null;
    }

    // 3. Остальные типы
    if (CASH_IN_OPERATION_TYPES.has(operationType)) return 'CASH_IN';
    if (CASH_OUT_OPERATION_TYPES.has(operationType)) return 'CASH_OUT';
    if (DIVIDEND_OPERATION_TYPES.has(operationType)) return 'DIV';
    if (COUPON_OPERATION_TYPES.has(operationType)) return 'COUPON';
    if (TAX_OPERATION_TYPES.has(operationType)) return 'TAX';
    if (FEE_OPERATION_TYPES.has(operationType)) return 'FEE';

    // 4. Fallback
    const fallback = guessTypeFromText(op.type);
    if (fallback === 'TRADE') {
        if (paymentValue > 0.001) return 'SELL';
        if (paymentValue < -0.001) return 'BUY';
        return null;
    }
    return fallback;
}

function moneyValueToNumber(value: MoneyValue | undefined): number {
    if (!value) return 0;
    const units = Number.parseInt(value.units, 10) || 0;
    const nanoFraction = (value.nano || 0) / 1_000_000_000;
    return units + nanoFraction;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapTradeDirectionToTransactionType(direction: string | undefined): 'BUY' | 'SELL' | null {
    if (!direction) return null;
    const normalized = direction.trim().toLowerCase();
    if (normalized.includes('покупка')) return 'BUY';
    if (normalized.includes('продажа')) return 'SELL';
    return null;
}

function normalizeCurrency(currency: string | undefined): string | undefined {
    return currency ? currency.toUpperCase() : undefined;
}

function isRateLimitStatus(status: number): boolean {
    return status === 429;
}

// ---------------------------------------------------------------------------
// Основной класс
// ---------------------------------------------------------------------------

export class TBankApi {
    private static readonly BASE_URL = 'https://invest-public-api.tinkoff.ru/rest';

    private static readonly GET_ACCOUNTS_METHOD_PATH =
        '/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts';

    private static readonly BROKER_REPORT_METHOD_PATH =
        '/tinkoff.public.invest.api.contract.v1.OperationsService/GetBrokerReport';

    private static readonly OPERATIONS_METHOD_PATH =
        '/tinkoff.public.invest.api.contract.v1.OperationsService/GetOperations';

    private static readonly GET_INSTRUMENT_BY_METHOD_PATH =
        '/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy';

    private static readonly GET_LAST_PRICES_METHOD_PATH =
        '/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices';

    private static readonly POLL_INTERVAL_MS = 2500;
    private static readonly MAX_POLL_ATTEMPTS = 5;

    private figiCache: Map<string, string> = new Map();

    private static readonly MAX_REPORT_PERIOD_DAYS = 30;
    private static readonly MIN_REQUEST_INTERVAL_MS = 4000;
    private static readonly MAX_RATE_LIMIT_RETRIES = 5;
    private static readonly RATE_LIMIT_BASE_DELAY_MS = 5000;

    private readonly instrumentCache: Map<string, ResolvedInstrument> = new Map();
    private accountIdCache: string | null = null;
    private lastResolvedAccountName: string | null = null;

    private requestQueueTail: Promise<void> = Promise.resolve();

    // ---- Публичные методы ----

    public async fetchBrokerReport(
        token: string,
        fromDate: string,
        toDate: string
    ): Promise<Transaction[]> {
        if (!token || token.trim().length === 0) {
            throw new TBankApiError('Токен T-Invest API не задан.');
        }

        const fromMs = new Date(fromDate).getTime();
        const toMs = new Date(toDate).getTime();
        if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
            throw new TBankApiError(`Некорректный формат дат: from="${fromDate}", to="${toDate}".`);
        }

        if (fromMs >= toMs) {
            console.log('[TBankApi] Период синхронизации пуст, пропущено.');
            return [];
        }

        const accountId = await this.resolveAccountId(token);
        console.debug(`[TBankApi] Используется accountId: "${accountId}"`);

        let trades: Transaction[] = [];
        let nonTradeOperations: Transaction[] = [];

        try {
            trades = await this.fetchTrades(token, accountId, fromDate, toDate);
        } catch (error) {
            console.warn('[TBankApi] Ошибка получения сделок, пропускаем:', error);
        }

        try {
            nonTradeOperations = await this.fetchNonTradeOperations(token, accountId, fromDate, toDate);
        } catch (error) {
            console.warn('[TBankApi] Ошибка получения операций, пропускаем:', error);
        }

        console.log(`[TBankApi] fetchBrokerReport: получено ${trades.length} сделок и ${nonTradeOperations.length} операций`);

        // Фильтруем nonTradeOperations: исключаем все BUY (они уже есть в trades)
        const filteredNonTrade = nonTradeOperations.filter(tx => tx.type !== 'BUY');

        const allTx = [...trades, ...filteredNonTrade];
        const merged = this.mergeTransactions(allTx, []);

        console.log(`[TBankApi] fetchBrokerReport возвращает ${merged.length} транзакций после фильтрации и дедупликации`);

        return merged;
    }

    // src/api/tbank-api.ts

    public async resolveIsinByTicker(token: string, ticker: string): Promise<string | null> {
        const clean = ticker.replace(/@$/, '').trim();
        if (!clean) return null;

        // Если это уже ISIN (12 символов, буквы/цифры) – возвращаем как есть
        if (/^[A-Z0-9]{12}$/.test(clean)) {
            return clean;
        }

        // Пробуем резолвить через InstrumentsService
        const classCodes = ['SPBRU', 'TQBR', 'TQCB', 'TQOB'];
        for (const classCode of classCodes) {
            try {
                const resp = await this.callMethod<{ instrument?: { isin?: string } }>(
                    token,
                    TBankApi.GET_INSTRUMENT_BY_METHOD_PATH,
                    {
                        getInstrumentByRequest: {
                            idType: 'INSTRUMENT_ID_TYPE_TICKER',
                            id: clean,
                            classCode,
                        }
                    }
                );
                if (resp.instrument?.isin) {
                    console.log(`[TBankApi] Резолвинг ISIN для ${clean} (classCode=${classCode}) -> ${resp.instrument.isin}`);
                    return resp.instrument.isin;
                }
            } catch { /* continue */ }
        }

        // Если не нашли – пробуем через UID или FIGI (редко, но бывает)
        try {
            const resp = await this.callMethod<{ instrument?: { isin?: string } }>(
                token,
                TBankApi.GET_INSTRUMENT_BY_METHOD_PATH,
                {
                    getInstrumentByRequest: {
                        idType: 'INSTRUMENT_ID_TYPE_UID',
                        id: clean,
                    }
                }
            );
            if (resp.instrument?.isin) return resp.instrument.isin;
        } catch { /* ignore */ }

        console.warn(`[TBankApi] Не удалось найти ISIN для "${clean}"`);
        return null;
    }

    public async fetchLastPrices(
        token: string,
        identifiers: string[]
    ): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        if (identifiers.length === 0) return result;

        // Преобразуем каждый идентификатор в ISIN
        const isinMap = new Map<string, string>(); // исходный -> ISIN
        for (const id of identifiers) {
            let isin = id;
            // Если это не ISIN – пробуем резолвить
            if (!/^[A-Z0-9]{12}$/.test(id)) {
                const resolved = await this.resolveIsinByTicker(token, id);
                if (resolved) isin = resolved;
                else continue;
            }
            isinMap.set(id, isin);
        }

        if (isinMap.size === 0) return result;

        const isinList = Array.from(isinMap.values());
        try {
            const responseBody = await this.callMethod<{ lastPrices?: Array<{ figi?: string; price?: MoneyValue }> }>(
                token,
                TBankApi.GET_LAST_PRICES_METHOD_PATH,
                {
                    getLastPricesRequest: {
                        instrumentId: isinList,
                        instrumentIdType: 'INSTRUMENT_ID_TYPE_ISIN'
                    }
                }
            );

            for (const item of responseBody.lastPrices ?? []) {
                if (item.figi && item.price) { // здесь figi будет ISIN (API возвращает его как figi)
                    const price = moneyValueToNumber(item.price);
                    for (const [orig, isin] of isinMap) {
                        if (isin === item.figi) {
                            result.set(orig, price);
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('[TBankApi] Ошибка при запросе цен через GetLastPrices (ISIN).', error);
        }

        return result;
    }

    public async checkConnection(token: string): Promise<{ accountId: string; accountName: string }> {
        if (!token || token.trim().length === 0) {
            throw new TBankApiError(
                'Токен T-Invest API не задан. Укажите его в настройках плагина.'
            );
        }

        const accountId = await this.resolveAccountId(token);
        return { accountId, accountName: this.lastResolvedAccountName ?? accountId };
    }

    public async resolveFigiByTicker(token: string, ticker: string): Promise<string | null> {
        const clean = ticker.replace(/@$/, '').trim();
        if (!clean) return null;

        if (this.figiCache.has(clean)) {
            return this.figiCache.get(clean)!;
        }

        if (/^BBG[A-Z0-9]{9}$/.test(clean)) {
            this.figiCache.set(clean, clean);
            return clean;
        }

        if (/^[A-Z0-9]{12}$/.test(clean)) {
            try {
                const requestBody: InstrumentRequestBody = {
                    idType: 'INSTRUMENT_ID_TYPE_ISIN',
                    id: clean,
                };
                const responseBody = await this.callMethod<unknown>(
                    token,
                    TBankApi.GET_INSTRUMENT_BY_METHOD_PATH,
                    requestBody
                );
                if (isInstrumentResponse(responseBody) && responseBody.instrument) {
                    const figi = responseBody.instrument.figi ?? null;
                    if (figi) {
                        this.figiCache.set(clean, figi);
                        console.log(`[TBankApi] Резолвинг FIGI для ISIN ${clean} -> ${figi} (кеширован)`);
                    }
                    return figi;
                }
            } catch (e) { /* ignore */ }
            return null;
        }

        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
            try {
                const requestBody: InstrumentRequestBody = {
                    idType: 'INSTRUMENT_ID_TYPE_UID',
                    id: clean,
                };
                const responseBody = await this.callMethod<unknown>(
                    token,
                    TBankApi.GET_INSTRUMENT_BY_METHOD_PATH,
                    requestBody
                );
                if (isInstrumentResponse(responseBody) && responseBody.instrument) {
                    const figi = responseBody.instrument.figi ?? null;
                    if (figi) {
                        this.figiCache.set(clean, figi);
                        console.log(`[TBankApi] Резолвинг FIGI для UID ${clean} -> ${figi} (кеширован)`);
                    }
                    return figi;
                }
            } catch (e) { /* ignore */ }
            return null;
        }

        const classCodes = ['SPBRU', 'TQBR', 'TQCB', 'TQOB'];
        for (const classCode of classCodes) {
            try {
                const requestBody: InstrumentRequestBody = {
                    idType: 'INSTRUMENT_ID_TYPE_TICKER',
                    id: clean,
                    classCode,
                };
                const responseBody = await this.callMethod<unknown>(
                    token,
                    TBankApi.GET_INSTRUMENT_BY_METHOD_PATH,
                    requestBody
                );
                if (isInstrumentResponse(responseBody) && responseBody.instrument) {
                    const figi = responseBody.instrument.figi;
                    if (figi) {
                        console.log(`[TBankApi] Резолвинг FIGI для ${clean} (classCode=${classCode}) -> ${figi}`);
                        this.figiCache.set(clean, figi);
                        return figi;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        console.warn(`[TBankApi] Не удалось найти FIGI для "${clean}" ни с одним class_code.`);
        return null;
    }

    // ---- Внутренние методы ----

    private async resolveAccountId(token: string): Promise<string> {
        if (this.accountIdCache) {
            return this.accountIdCache;
        }

        const responseBody = await this.callMethod<unknown>(
            token,
            TBankApi.GET_ACCOUNTS_METHOD_PATH,
            {}
        );

        if (!isAccountsResponse(responseBody)) {
            throw new TBankApiError(
                'T-Invest API вернул неожиданный формат ответа на запрос UsersService.GetAccounts. ' +
                'Проверьте права токена (нужен доступ к информации о счетах).'
            );
        }

        const accounts = responseBody.accounts ?? [];

        if (accounts.length === 0) {
            throw new TBankApiError(
                'У этого токена T-Invest API нет ни одного доступного счёта. ' +
                'Проверьте права токена в личном кабинете Т-Банк Инвестиций.'
            );
        }

        const openAccount = accounts.find((acc) => acc.status === 'ACCOUNT_STATUS_OPEN') ?? accounts[0];

        if (accounts.length > 1) {
            console.warn(
                `[TBankApi] У токена найдено ${accounts.length} счетов. Для синхронизации выбран ` +
                `счёт "${openAccount.name ?? openAccount.id}" (id: ${openAccount.id}). ` +
                'Остальные счета (например, ИИС) не синхронизируются в текущей версии плагина.'
            );
        }

        this.accountIdCache = openAccount.id;
        this.lastResolvedAccountName = openAccount.name ?? openAccount.id;

        return this.accountIdCache;
    }

    private isNoDataForPeriodError(error: unknown): boolean {
        if (!(error instanceof TBankApiError)) {
            return false;
        }
        return (
            error.message.includes('No data for the specified period') ||
            error.message.includes('"description":"30238"')
        );
    }

    private splitDateRangeIntoChunks(
        fromDate: string,
        toDate: string,
        maxDays: number
    ): Array<{ from: string; to: string }> {
        const chunks: Array<{ from: string; to: string }> = [];

        const start = new Date(fromDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(toDate);
        end.setUTCHours(0, 0, 0, 0);

        let chunkStart = start.getTime();
        const endMs = end.getTime();
        const maxChunkMs = maxDays * 24 * 60 * 60 * 1000;

        while (chunkStart < endMs) {
            const chunkEnd = Math.min(chunkStart + maxChunkMs, endMs);

            const fromStr = new Date(chunkStart).toISOString().replace(/\.\d+Z$/, 'Z');

            const toDateObj = new Date(chunkEnd);
            toDateObj.setUTCHours(23, 59, 59, 0);
            const toStr = toDateObj.toISOString().replace(/\.\d+Z$/, 'Z');

            if (new Date(fromStr).getTime() < new Date(toStr).getTime()) {
                chunks.push({ from: fromStr, to: toStr });
            }

            if (chunkEnd >= endMs) break;
            chunkStart = chunkEnd + 1;
        }

        return chunks;
    }

    // ---- Сделки (GetBrokerReport) ----

    private async fetchTrades(
        token: string,
        accountId: string,
        fromDate: string,
        toDate: string
    ): Promise<Transaction[]> {
        const periodChunks = this.splitDateRangeIntoChunks(fromDate, toDate, TBankApi.MAX_REPORT_PERIOD_DAYS);

        if (periodChunks.length > 1) {
            console.log(
                `[TBankApi] Запрошенный период (${fromDate} - ${toDate}) превышает ${TBankApi.MAX_REPORT_PERIOD_DAYS} дней ` +
                `и будет разбит на ${periodChunks.length} последовательных запросов к GetBrokerReport.`
            );
        }

        const allTransactions: Transaction[] = [];

        if (periodChunks.length === 0) {
            console.log('[TBankApi] Нет допустимых чанков, синхронизация пропущена.');
            return [];
        }

        for (const chunk of periodChunks) {
            try {
                console.log(`[TBankApi] Обрабатывается чанк: ${chunk.from} - ${chunk.to}`);
                const generationResult = await this.requestReportGeneration(token, accountId, chunk.from, chunk.to);

                let firstPage: GetBrokerReportResponseBody['getBrokerReportResponse'];
                let taskId: string | null = null;
                if ('taskId' in generationResult) {
                    taskId = generationResult.taskId;
                    firstPage = await this.pollReportUntilReady(token, taskId);
                } else {
                    firstPage = generationResult.readyReport;
                }

                let rows: BrokerReportRow[];
                if (taskId) {
                    rows = await this.fetchRemainingPages(token, taskId, firstPage);
                } else {
                    rows = [...(firstPage.brokerReport ?? [])];
                }

                allTransactions.push(...this.mapTradeRowsToTransactions(rows));
            } catch (error) {
                if (this.isNoDataForPeriodError(error)) {
                    console.log(`[TBankApi] Нет данных за период ${chunk.from} - ${chunk.to} (пропущено).`);
                    continue;
                }
                console.error(`[TBankApi] Ошибка при обработке чанка ${chunk.from} - ${chunk.to}:`, error);
                continue;
            }
        }

        return allTransactions;
    }

    private async requestReportGeneration(
        token: string,
        accountId: string,
        fromDate: string,
        toDate: string
    ): Promise<{ taskId: string } | { readyReport: GetBrokerReportResponseBody['getBrokerReportResponse'] }> {
        const requestBody: GenerateBrokerReportRequestBody = {
            generateBrokerReportRequest: {
                accountId,
                from: fromDate,
                to: toDate,
            },
        };

        const responseBody = await this.callMethod<BrokerReportResponseBody>(
            token,
            TBankApi.BROKER_REPORT_METHOD_PATH,
            requestBody
        );

        if (isReadyResponse(responseBody)) {
            return { readyReport: responseBody.getBrokerReportResponse };
        }

        if (isGenerateResponse(responseBody)) {
            return { taskId: responseBody.generateBrokerReportResponse.taskId };
        }

        console.error(
            '[TBankApi][DEBUG] Нераспознанный ответ на GenerateBrokerReportRequest:',
            JSON.stringify(responseBody, null, 2)
        );
        throw new TBankApiError(
            'T-Invest API вернул неожиданный формат ответа на запрос генерации отчёта. ' +
            'Проверьте права токена (нужен доступ к отчётам).'
        );
    }

    private async pollReportUntilReady(
        token: string,
        taskId: string
    ): Promise<GetBrokerReportResponseBody['getBrokerReportResponse']> {
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= TBankApi.MAX_POLL_ATTEMPTS; attempt++) {
            try {
                const requestBody: GetBrokerReportRequestBody = {
                    getBrokerReportRequest: {
                        taskId,
                        page: 0,
                    },
                };

                const responseBody = await this.callMethod<BrokerReportResponseBody>(
                    token,
                    TBankApi.BROKER_REPORT_METHOD_PATH,
                    requestBody
                );

                if (isReadyResponse(responseBody)) {
                    return responseBody.getBrokerReportResponse;
                }

                if (attempt < TBankApi.MAX_POLL_ATTEMPTS) {
                    await sleep(TBankApi.POLL_INTERVAL_MS);
                }
            } catch (error) {
                lastError = error;
                if (attempt < TBankApi.MAX_POLL_ATTEMPTS) {
                    await sleep(TBankApi.POLL_INTERVAL_MS);
                }
            }
        }

        throw new TBankApiError(
            `Отчёт по сделкам не был готов за ${TBankApi.MAX_POLL_ATTEMPTS} попыток опроса ` +
            `(интервал ${TBankApi.POLL_INTERVAL_MS} мс между попытками). ` +
            'Попробуйте повторить синхронизацию позже.',
            lastError
        );
    }

    private async fetchRemainingPages(
        token: string,
        taskId: string,
        firstPage: GetBrokerReportResponseBody['getBrokerReportResponse']
    ): Promise<BrokerReportRow[]> {
        const rows: BrokerReportRow[] = [...(firstPage.brokerReport ?? [])];
        const pagesCount = firstPage.pagesCount ?? 1;

        if (pagesCount <= 1) {
            return rows;
        }

        for (let page = 1; page < pagesCount; page++) {
            const requestBody: GetBrokerReportRequestBody = {
                getBrokerReportRequest: {
                    taskId,
                    page,
                },
            };

            try {
                const responseBody = await this.callMethod<BrokerReportResponseBody>(
                    token,
                    TBankApi.BROKER_REPORT_METHOD_PATH,
                    requestBody
                );

                if (isReadyResponse(responseBody)) {
                    rows.push(...(responseBody.getBrokerReportResponse.brokerReport ?? []));
                } else {
                    console.warn(
                        `[TBankApi] Страница ${page} отчёта по сделкам вернулась в неожиданном формате, пропущена.`
                    );
                }
            } catch (error) {
                console.warn(`[TBankApi] Не удалось загрузить страницу ${page} отчёта по сделкам.`, error);
            }
        }

        return rows;
    }

    private mapTradeRowsToTransactions(rows: BrokerReportRow[]): Transaction[] {
        const transactions: Transaction[] = [];

        for (const row of rows) {
            const type = mapTradeDirectionToTransactionType(row.direction);
            if (!type) {
                console.warn(
                    `[TBankApi] Не удалось определить направление сделки по значению "${row.direction}", строка пропущена.`,
                    row
                );
                continue;
            }

            const ticker = (row.ticker ?? row.figi)?.trim();
            if (!ticker) {
                console.warn('[TBankApi] Строка отчёта по сделкам без тикера/FIGI, пропущена.', row);
                continue;
            }

            if (!row.tradeDatetime) {
                console.warn('[TBankApi] Строка отчёта по сделкам без даты, пропущена.', row);
                continue;
            }

            const amount = Math.abs(Number.parseFloat(row.quantity ?? '0')) || 0;
            const price = Math.abs(moneyValueToNumber(row.price));
            const totalSum =
                Math.abs(moneyValueToNumber(row.totalOrderAmount)) ||
                Math.abs(moneyValueToNumber(row.orderAmount)) ||
                amount * price;

            const currency =
                normalizeCurrency(row.totalOrderAmount?.currency) ??
                normalizeCurrency(row.orderAmount?.currency) ??
                normalizeCurrency(row.price?.currency);

            if (row.price?.currency === '%') {
                console.warn(
                    `[TBankApi] Сделка по "${row.name ?? ticker}" — цена указана в процентах от номинала (облигация). ` +
                    'Поле price в Transaction содержит это процентное значение, а не рублёвую цену за единицу.'
                );
            }

            const dateObj = new Date(row.tradeDatetime);
            const date = dateObj.toISOString().slice(0, 10);
            const time = dateObj.toISOString().slice(11, 19);

            transactions.push({
                id: row.tradeId ?? `tbank-trade-${row.tradeDatetime}-${ticker}-${amount}-${price}`,
                date,
                time,
                broker: 'tbank',
                ticker,
                shareName: row.name ?? ticker,
                type,
                amount,
                price,
                totalSum,
                currency,
                figi: row.figi,
                tradeId: row.tradeId,
            });
        }

        return transactions;
    }

    // ---- Операции (GetOperations) ----

    private async fetchNonTradeOperations(
        token: string,
        accountId: string,
        fromDate: string,
        toDate: string
    ): Promise<Transaction[]> {
        const periodChunks = this.splitDateRangeIntoChunks(fromDate, toDate, TBankApi.MAX_REPORT_PERIOD_DAYS);
        const allTransactions: Transaction[] = [];

        for (const chunk of periodChunks) {
            try {
                const requestBody: GetOperationsRequestBody = {
                    accountId,
                    from: chunk.from,
                    to: chunk.to,
                    state: 'OPERATION_STATE_EXECUTED',
                };
                const responseBody = await this.callMethod<unknown>(token, TBankApi.OPERATIONS_METHOD_PATH, requestBody);

                if (!isOperationsResponse(responseBody)) {
                    throw new TBankApiError(
                        'T-Invest API вернул неожиданный формат ответа на запрос GetOperations.'
                    );
                }

                const operations = responseBody.operations ?? [];
                console.log(`[TBankApi] Получено ${operations.length} операций из GetOperations за чанк ${chunk.from} - ${chunk.to}`);

                for (const op of operations) {
                    // Детальное логирование каждой операции
                    console.log('[TBankApi] Операция:', JSON.stringify({
                        id: op.id,
                        date: op.date,
                        type: op.type,
                        operationType: op.operationType,
                        payment: op.payment,
                        price: op.price,
                        quantity: op.quantity,
                        figi: op.figi,
                        instrumentUid: op.instrumentUid,
                    }, null, 2));

                    const resolvedType = resolveNonTradeType(op);
                    if (!resolvedType) {
                        console.warn('[TBankApi] Не удалось определить тип операции, пропускаем. operationType=', op.operationType, 'type=', op.type, 'payment=', op.payment);
                        continue;
                    }
                    if (!resolvedType) {
                        console.warn('[TBankApi] Не удалось определить тип операции, пропускаем:', op);
                        continue;
                    }

                    // Если это сделка – пропускаем, чтобы не дублировать с GetBrokerReport
                    if (resolvedType === 'TRADE') {
                        continue;
                    }

                    // ---- BUY/SELL из операций ----
                    if (resolvedType === 'BUY' || resolvedType === 'SELL') {
                        const totalSum = Math.abs(moneyValueToNumber(op.payment));
                        const price = Math.abs(moneyValueToNumber(op.price)) || totalSum;
                        let amount = Math.abs(Number.parseFloat(op.quantity ?? '0'));
                        if (amount === 0) {
                            console.warn(`[TBankApi] Для операции ${resolvedType} quantity = 0, устанавливаем amount = 1.`, op);
                            amount = 1;
                        }

                        const instrumentId = op.figi || op.instrumentUid || '';
                        let ticker = 'RUB';
                        let shareName = 'RUB';
                        let figi = op.figi || '';

                        if (instrumentId) {
                            const resolved = await this.resolveInstrument(token, instrumentId);
                            if (resolved) {
                                ticker = resolved.ticker;
                                shareName = resolved.shareName;
                            } else {
                                ticker = instrumentId;
                                shareName = instrumentId;
                            }
                        }

                        console.log(`[TBankApi] Создана транзакция ${resolvedType}: ${ticker}, сумма=${totalSum}, количество=${amount}`);

                        allTransactions.push({
                            id: op.id ?? `tbank-op-${op.date}-${resolvedType}-${totalSum}`,
                            date: op.date ? new Date(op.date).toISOString() : new Date().toISOString(),
                            broker: 'tbank',
                            ticker,
                            shareName,
                            type: resolvedType,
                            amount,
                            price: price || totalSum,
                            totalSum,
                            currency: op.payment?.currency || 'RUB',
                            figi: figi || undefined,
                        });
                        continue;
                    }

                    // ---- Остальные операции ----
                    if (!op.date) {
                        console.warn('[TBankApi] Операция без даты, пропущена.', op);
                        continue;
                    }

                    const totalSum = Math.abs(moneyValueToNumber(op.payment));
                    const price = Math.abs(moneyValueToNumber(op.price));
                    const amount = Math.abs(Number.parseFloat(op.quantity ?? '0')) || 0;
                    const currency = op.currency ?? op.payment?.currency;

                    const instrumentId = op.figi || op.instrumentUid || '';
                    let ticker = 'RUB';
                    let shareName = 'RUB';
                    let figi = op.figi || '';

                    if (instrumentId) {
                        const resolved = await this.resolveInstrument(token, instrumentId);
                        if (resolved) {
                            ticker = resolved.ticker;
                            shareName = resolved.shareName;
                        } else {
                            ticker = instrumentId;
                            shareName = instrumentId;
                        }
                    }

                    allTransactions.push({
                        id: op.id ?? `tbank-op-${op.date}-${resolvedType}-${totalSum}`,
                        date: new Date(op.date).toISOString(),
                        broker: 'tbank',
                        ticker,
                        shareName,
                        type: resolvedType,
                        amount,
                        price,
                        totalSum,
                        currency,
                        figi: figi || undefined,
                    });
                }
            } catch (error) {
                if (this.isNoDataForPeriodError(error)) {
                    console.log(`[TBankApi] Нет данных по операциям за ${chunk.from} - ${chunk.to}`);
                    continue;
                }
                console.error(`[TBankApi] Ошибка получения операций за чанк ${chunk.from} - ${chunk.to}:`, error);
                continue;
            }
        }

        return allTransactions;
    }

    private async resolveInstrument(
        token: string,
        figiOrUid: string
    ): Promise<ResolvedInstrument | null> {
        const cached = this.instrumentCache.get(figiOrUid);
        if (cached) {
            return cached;
        }

        try {
            const idType: InstrumentIdType = this.looksLikeUuid(figiOrUid)
                ? 'INSTRUMENT_ID_TYPE_UID'
                : 'INSTRUMENT_ID_TYPE_FIGI';

            const requestBody: InstrumentRequestBody = {
                idType,
                id: figiOrUid,
            };

            const responseBody = await this.callMethod<unknown>(
                token,
                TBankApi.GET_INSTRUMENT_BY_METHOD_PATH,
                requestBody
            );

            if (!isInstrumentResponse(responseBody) || !responseBody.instrument) {
                console.warn(
                    `[TBankApi] InstrumentsService.GetInstrumentBy не вернул инструмент для "${figiOrUid}".`
                );
                return null;
            }

            const instrument = responseBody.instrument;
            const resolved: ResolvedInstrument = {
                ticker: instrument.ticker ?? figiOrUid,
                shareName: instrument.name ?? instrument.ticker ?? figiOrUid,
            };

            this.instrumentCache.set(figiOrUid, resolved);
            return resolved;
        } catch (error) {
            console.warn(
                `[TBankApi] Не удалось резолвить инструмент "${figiOrUid}" через InstrumentsService.`,
                error
            );
            return null;
        }
    }

    private looksLikeUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    private mergeTransactions(
        trades: Transaction[],
        nonTradeOperations: Transaction[]
    ): Transaction[] {
        const all = [...trades, ...nonTradeOperations];
        const seen = new Map<string, Transaction>();
        for (const tx of all) {
            const amountKey = Math.round(tx.amount * 1e6) / 1e6;
            const totalSumKey = Math.round(tx.totalSum * 1e6) / 1e6;
            let key: string;
            if (tx.type === 'CASH_IN' || tx.type === 'CASH_OUT') {
                const dateOnly = tx.date.slice(0, 10);
                key = `${tx.broker}|${tx.type}|${dateOnly}|${totalSumKey}`;
            } else {
                key = `${tx.broker}|${tx.ticker}|${tx.date}|${tx.type}|${amountKey}|${totalSumKey}`;
            }
            seen.set(key, tx);
        }
        const result = Array.from(seen.values());
        result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        return result;
    }

    // ---- Транспорт ----

    private async callMethod<TResponse>(
        token: string,
        methodPath: string,
        body: unknown
    ): Promise<TResponse> {
        return this.enqueue(() => this.executeWithRetry<TResponse>(token, methodPath, body));
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const resultPromise = this.requestQueueTail.then(() => task());
        this.requestQueueTail = resultPromise
            .catch(() => { })
            .then(() => sleep(TBankApi.MIN_REQUEST_INTERVAL_MS));
        return resultPromise;
    }

    private async executeWithRetry<TResponse>(
        token: string,
        methodPath: string,
        body: unknown
    ): Promise<TResponse> {
        let lastError: unknown = null;

        for (let attempt = 0; attempt <= TBankApi.MAX_RATE_LIMIT_RETRIES; attempt++) {
            try {
                return await this.performRequest<TResponse>(token, methodPath, body);
            } catch (error) {
                const isRateLimit = error instanceof RateLimitError;

                if (!isRateLimit || attempt === TBankApi.MAX_RATE_LIMIT_RETRIES) {
                    throw isRateLimit ? (error as RateLimitError).toTBankApiError() : error;
                }

                lastError = error;
                const retryAfterMs = (error as RateLimitError).retryAfterMs;
                const backoffMs = retryAfterMs ?? TBankApi.RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);

                console.warn(
                    `[TBankApi] Получен ответ 429 (Too Many Requests) для ${methodPath}. ` +
                    `Повторная попытка ${attempt + 1}/${TBankApi.MAX_RATE_LIMIT_RETRIES} через ${backoffMs} мс.`
                );

                await sleep(backoffMs);
            }
        }

        throw lastError instanceof RateLimitError
            ? lastError.toTBankApiError()
            : new TBankApiError('Не удалось выполнить запрос к T-Invest API после повторных попыток.', lastError);
    }

    private async performRequest<TResponse>(
        token: string,
        methodPath: string,
        body: unknown
    ): Promise<TResponse> {
        console.debug(`[TBankApi] -> ${methodPath}`, body);

        let responseStatus: number;
        let responseText: string;
        let responseHeaders: Record<string, string> = {};

        try {
            const response = await requestUrl({
                url: `${TBankApi.BASE_URL}${methodPath}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
                throw: false,
            });

            responseStatus = response.status;
            responseText = response.text;
            responseHeaders = response.headers ?? {};
        } catch (error) {
            throw new TBankApiError(
                `Сетевая ошибка при обращении к T-Invest API (${methodPath}). Проверьте подключение к интернету.`,
                error
            );
        }

        if (isRateLimitStatus(responseStatus)) {
            const retryAfterHeader = responseHeaders['retry-after'] ?? responseHeaders['Retry-After'];
            const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
            const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : null;

            throw new RateLimitError(
                `T-Invest API вернул 429 (Too Many Requests) для метода ${methodPath}.`,
                retryAfterMs
            );
        }

        if (responseStatus < 200 || responseStatus >= 300) {
            if (responseStatus === 401 || responseStatus === 403) {
                throw new TBankApiError(
                    'T-Invest API отклонил запрос: неверный или недостаточный по правам токен доступа.',
                    responseText
                );
            }

            throw new TBankApiError(
                `T-Invest API вернул ошибку ${responseStatus} для метода ${methodPath}: ${responseText}`,
                responseText
            );
        }

        try {
            return JSON.parse(responseText) as TResponse;
        } catch (error) {
            throw new TBankApiError(
                `Не удалось разобрать JSON-ответ T-Invest API для метода ${methodPath}.`,
                error
            );
        }
    }
}

class RateLimitError extends Error {
    constructor(message: string, public readonly retryAfterMs: number | null) {
        super(message);
        this.name = 'RateLimitError';
    }

    public toTBankApiError(): TBankApiError {
        return new TBankApiError(
            `${this.message} Превышен лимит попыток повторного запроса — попробуйте синхронизацию позже.`
        );
    }
}