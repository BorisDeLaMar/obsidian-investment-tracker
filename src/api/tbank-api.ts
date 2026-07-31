	// src/api/tbank-api.ts

import { requestUrl } from 'obsidian';
import { Transaction, TransactionType } from '../types';

/**
 * Ошибка взаимодействия с T-Invest API.
 * Отдельный класс, чтобы UI плагина мог показывать пользователю
 * осмысленное сообщение вместо "Failed to fetch".
 */
export class TBankApiError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = 'TBankApiError';
	}
}

/**
 * Представление MoneyValue из контракта T-Invest API v2
 * (units — целая часть в виде строки, nano — дробная часть * 1e9, знак совпадает с units).
 */
interface MoneyValue {
	currency: string;
	units: string;
	nano: number;
}

// ---------------------------------------------------------------------------
// Контракты UsersService.GetAccounts (список счетов токена)
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

/** Одна строка отчёта о сделках (реальная схема, подтверждённая фактическим ответом API). */
interface BrokerReportRow {
	tradeId?: string;
	orderId?: string;
	figi?: string;
	/** Для акций — короткий тикер (например "SBER"); для облигаций сервер кладёт сюда ISIN. */
	ticker?: string;
	/** Человекочитаемое название бумаги, например "Сбербанк России". */
	name?: string;
	/** Направление сделки русским текстом: "Покупка" | "Продажа". */
	direction?: string;
	/** Количество приходит строкой. */
	quantity?: string;
	/**
	 * Цена за единицу. Валюта внутри MoneyValue может быть "%" — для облигаций
	 * это процент от номинала, а не денежная цена. Явно не пытаемся привести
	 * такую цену к рублям, чтобы не исказить отчёт по облигациям.
	 */
	price?: MoneyValue;
	/** Сумма сделки БЕЗ накопленного купонного дохода (НКД). */
	orderAmount?: MoneyValue;
	/** Полная сумма сделки С учётом НКД (orderAmount + aciValue) — приоритетный источник totalSum. */
	totalOrderAmount?: MoneyValue;
	/** Накопленный купонный доход (для облигаций); для акций обычно 0. */
	aciValue?: MoneyValue;
	brokerCommission?: MoneyValue;
	exchangeCommission?: MoneyValue;
	exchangeClearingCommission?: MoneyValue;
	/** Дата и время заключения сделки, RFC3339 (например "2026-07-01T05:14:13Z"). */
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
	| 'INSTRUMENT_ID_TYPE_UID';

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
// Таблицы соответствия operationType -> TransactionType.
// ---------------------------------------------------------------------------

const TRADE_OPERATION_TYPES = new Set<string>([
	'OPERATION_TYPE_BUY',
	'OPERATION_TYPE_BUY_CARD',
	'OPERATION_TYPE_BUY_MARGIN',
	'OPERATION_TYPE_SELL',
	'OPERATION_TYPE_SELL_CARD',
	'OPERATION_TYPE_SELL_MARGIN',
	'OPERATION_TYPE_DELIVERY_BUY'
]);

const CASH_IN_OPERATION_TYPES = new Set<string>([
	'OPERATION_TYPE_INPUT',
	'OPERATION_TYPE_INPUT_SWIFT',
	'OPERATION_TYPE_INPUT_ACQUIRING'
]);

const CASH_OUT_OPERATION_TYPES = new Set<string>([
	'OPERATION_TYPE_OUTPUT',
	'OPERATION_TYPE_OUTPUT_SWIFT',
	'OPERATION_TYPE_OUTPUT_ACQUIRING'
]);

const DIVIDEND_OPERATION_TYPES = new Set<string>([
	'OPERATION_TYPE_DIVIDEND',
	'OPERATION_TYPE_DIV_EXT',
	'OPERATION_TYPE_DIVIDEND_TRANSFER'
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
	'OPERATION_TYPE_TAX_CORRECTION_COUPON'
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
	'OPERATION_TYPE_OVER_COM'
]);

/**
 * Резервный разбор по человекочитаемому полю `type`, если operationType
 * не задан или не найден ни в одной из таблиц выше.
 */
function guessTypeFromText(text: string | undefined): TransactionType | 'TRADE' | null {
	if (!text) {
		return null;
	}
	const normalized = text.toLowerCase();

	if (normalized.includes('покупка') || normalized.includes('продажа')) {
		return 'TRADE';
	}
	if (normalized.includes('дивиденд')) {
		return 'DIV';
	}
	if (normalized.includes('купон')) {
		return 'COUPON';
	}
	if (normalized.includes('налог')) {
		return 'TAX';
	}
	if (normalized.includes('комис') || normalized.includes('плата') || normalized.includes('сбор')) {
		return 'FEE';
	}
	if (normalized.includes('пополнение') || normalized.includes('ввод денежных')) {
		return 'CASH_IN';
	}
	if (normalized.includes('вывод')) {
		return 'CASH_OUT';
	}
	return null;
}

/**
 * Резолвит машиночитаемый operationType (или, если он не распознан, текст `type`)
 * в наш TransactionType. Возвращает null, если тип определить не удалось —
 * такая строка логируется и пропускается без падения импорта.
 */
function resolveNonTradeType(op: OperationRow): TransactionType | 'TRADE' | null {
	if (op.operationType) {
		if (TRADE_OPERATION_TYPES.has(op.operationType)) return 'TRADE';
		if (CASH_IN_OPERATION_TYPES.has(op.operationType)) return 'CASH_IN';
		if (CASH_OUT_OPERATION_TYPES.has(op.operationType)) return 'CASH_OUT';
		if (DIVIDEND_OPERATION_TYPES.has(op.operationType)) return 'DIV';
		if (COUPON_OPERATION_TYPES.has(op.operationType)) return 'COUPON';
		if (TAX_OPERATION_TYPES.has(op.operationType)) return 'TAX';
		if (FEE_OPERATION_TYPES.has(op.operationType)) return 'FEE';
	}
	return guessTypeFromText(op.type);
}

/** Переводит MoneyValue в число (units.nano). */
function moneyValueToNumber(value: MoneyValue | undefined): number {
	if (!value) {
		return 0;
	}
	const units = Number.parseInt(value.units, 10) || 0;
	const nanoFraction = (value.nano || 0) / 1_000_000_000;
	return units + nanoFraction;
}

/** Простая пауза, используется в очереди запросов, цикле опроса готовности отчёта и при ретраях. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Направление сделки из GetBrokerReport, поле `direction` ("Покупка"/"Продажа"). */
function mapTradeDirectionToTransactionType(direction: string | undefined): 'BUY' | 'SELL' | null {
	if (!direction) {
		return null;
	}
	const normalized = direction.trim().toLowerCase();
	if (normalized.includes('покупка')) {
		return 'BUY';
	}
	if (normalized.includes('продажа')) {
		return 'SELL';
	}
	return null;
}

/** Приводит валюту MoneyValue к верхнему регистру (сервер отдаёт "rub", а не "RUB"). */
function normalizeCurrency(currency: string | undefined): string | undefined {
	return currency ? currency.toUpperCase() : undefined;
}

/** Определяет, является ли HTTP-статус кодом "слишком много запросов". */
function isRateLimitStatus(status: number): boolean {
	return status === 429;
}

/**
 * Клиент T-Invest API v2 (REST-транскрипция gRPC-контрактов через grpc-gateway).
 *
 * Базовый адрес: https://invest-public-api.tinkoff.ru/rest
 * Методы:
 *   - tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts         (список счетов
 *     токена — нужен для accountId, обязательного параметра GetBrokerReport/GetOperations)
 *   - tinkoff.public.invest.api.contract.v1.OperationsService/GetBrokerReport  (сделки BUY/SELL)
 *   - tinkoff.public.invest.api.contract.v1.OperationsService/GetOperations   (деньги, дивиденды,
 *     купоны, налоги, комиссии — источник для всего, что не является сделкой)
 *   - tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy (резолвинг
 *     FIGI/instrumentUid в тикер и человекочитаемое название, с локальным кешем в памяти)
 *
 * Все HTTP-вызовы идут через Obsidian requestUrl (а не через браузерный fetch), так как
 * requestUrl выполняется в контексте Electron/Node и не подчиняется CORS-политике браузера.
 * Дополнительно все вызовы проходят через единую сериализованную очередь с гарантированной
 * паузой между запросами и retry с экспоненциальной задержкой на HTTP 429, чтобы не упираться
 * в лимит частоты запросов T-Invest API при длинных периодах синхронизации (разбитых на чанки
 * по 30 дней).
 *
 * Структура и enum-значения GetOperations/GetInstrumentBy/GetAccounts основаны на публичном
 * знании контракта v2 и не сверены построчно с актуальной proto/OpenAPI спецификацией —
 * перед продовым использованием стоит проверить их по https://github.com/RussianInvestments/investAPI.
 */
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

	/**
	 * Максимальная длина периода одного вызова GetBrokerReport/GetOperations — жёсткое
	 * ограничение сервера T-Invest API (см. ошибку INVALID_ARGUMENT: "The required period
	 * should not exceed 31 days"). Берём 30 вместо 31 дня с небольшим запасом.
	 */
	private static readonly MAX_REPORT_PERIOD_DAYS = 30;

	/**
	 * Минимальная гарантированная пауза между двумя последовательными HTTP-запросами
	 * этого инстанса TBankApi (любыми — генерация отчёта, опрос готовности, GetOperations,
	 * GetInstrumentBy). Не подтверждена официальной документацией как точный лимит API —
	 * это осторожное консервативное значение, подобранное эмпирически после ошибки 429.
	 * При повторных 429 стоит увеличить это число.
	 */
	private static readonly MIN_REQUEST_INTERVAL_MS = 4000;

	/** Максимальное количество повторных попыток одного запроса при ответе 429. */
	private static readonly MAX_RATE_LIMIT_RETRIES = 5;

	/** Базовая задержка для экспоненциального backoff при 429 (удваивается с каждой попыткой). */
	private static readonly RATE_LIMIT_BASE_DELAY_MS = 5000;

	private readonly instrumentCache: Map<string, ResolvedInstrument> = new Map();
	private accountIdCache: string | null = null;
	private lastResolvedAccountName: string | null = null;

	/**
	 * Хвост сериализованной очереди запросов. Каждый новый вызов callMethod "подвешивается"
	 * к этому промису вместо немедленного fetch — так гарантируется, что даже при
	 * параллельном вызове (например, fetchTrades и fetchNonTradeOperations через Promise.all)
	 * реальные HTTP-запросы на сервер уходят строго по одному, с паузой между ними.
	 * Без этой очереди простая проверка "прошло ли N мс с последнего запроса" была бы
	 * подвержена гонке: оба параллельных вызова могли бы прочитать одно и то же значение
	 * "последнее время запроса" до того, как кто-то из них успеет его обновить.
	 */
	private requestQueueTail: Promise<void> = Promise.resolve();

	/**
	 * Основной публичный метод: определяет accountId (через GetAccounts, с кешированием),
	 * затем параллельно забирает сделки (GetBrokerReport) и все остальные операции
	 * (GetOperations) по этому счёту, резолвит тикеры для нетрейдовых операций через
	 * InstrumentsService и объединяет всё в единый, отсортированный по дате Transaction[]
	 * без дублирования сделок.
	 *
	 * @param token    Bearer-токен T-Invest API.
	 * @param fromDate Начало периода, ISO 8601 (например "2026-01-01T00:00:00Z").
	 * @param toDate   Конец периода, ISO 8601.
	 */
	public async fetchBrokerReport(
		token: string,
		fromDate: string,
		toDate: string
	): Promise<Transaction[]> {
		if (!token || token.trim().length === 0) {
			throw new TBankApiError(
				'Токен T-Invest API не задан. Укажите его в настройках плагина.'
			);
		}

		const fromMs = new Date(fromDate).getTime();
		const toMs = new Date(toDate).getTime();

		if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
			throw new TBankApiError(
				`Некорректный формат дат периода синхронизации: from="${fromDate}", to="${toDate}".`
			);
		}

		// Период нулевой или отрицательной длины — типичная ситуация при повторном нажатии
		// "Синхронизировать" в тот же день сразу после успешной синхронизации: lastSyncDate
		// (использованный как fromDate) уже равен верхней границе toDate, так как новый
		// полностью закрытый расчётный день ещё не наступил. Это не ошибка, а штатный
		// случай "синхронизировать нечего" — обращаться к API не нужно.
		if (fromMs >= toMs) {
			console.log(
				`[TBankApi] Период синхронизации пуст (from="${fromDate}" >= to="${toDate}"). ` +
					'Скорее всего, с момента последней синхронизации ещё не наступил новый ' +
					'полностью завершённый день. Запрос к API пропущен.'
			);
			return [];
		}

		const accountId = await this.resolveAccountId(token);
		console.debug(`[TBankApi] Используется accountId: "${accountId}"`);

		const [trades, nonTradeOperations] = await Promise.all([
			this.fetchTrades(token, accountId, fromDate, toDate),
			this.fetchNonTradeOperations(token, accountId, fromDate, toDate)
		]);

		return this.mergeTransactions(trades, nonTradeOperations);
	}

	/**
	 * Fallback-получение текущих цен по списку figi через T-Invest API MarketDataService.
	 * Используется только для инструментов, которые MOEX ISS не может опознать по тикеру
	 * (внутренние коды биржевых фондов брокера, например "TRUR@").
	 */
	public async fetchLastPricesByFigi(token: string, figiList: string[]): Promise<Map<string, number>> {
		const result = new Map<string, number>();
		if (figiList.length === 0) {
			return result;
		}

		try {
			const responseBody = await this.callMethod<{ lastPrices?: Array<{ figi?: string; price?: MoneyValue }> }>(
				token,
				TBankApi.GET_LAST_PRICES_METHOD_PATH,
				{ figi: figiList }
			);

			for (const item of responseBody.lastPrices ?? []) {
				if (item.figi && item.price) {
					result.set(item.figi, moneyValueToNumber(item.price));
				}
			}
		} catch (error) {
			console.warn('[TBankApi] Не удалось получить цены через MarketDataService.GetLastPrices.', error);
		}

		return result;
	}

	/**
	 * Лёгкая проверка работоспособности токена: выполняет только UsersService.GetAccounts
	 * (без обращения к GetBrokerReport/GetOperations). Не подвержена ограничениям
	 * по длине периода или расчётному лагу, так как не запрашивает отчёты вообще —
	 * подходит для быстрой проверки "токен рабочий" в настройках плагина.
	 *
	 * @returns Человекочитаемое имя/id выбранного счёта — полезно показать пользователю,
	 *          к какому именно счёту подключен токен.
	 */
	public async checkConnection(token: string): Promise<{ accountId: string; accountName: string }> {
		if (!token || token.trim().length === 0) {
			throw new TBankApiError(
				'Токен T-Invest API не задан. Укажите его в настройках плагина.'
			);
		}

		const accountId = await this.resolveAccountId(token);
		return { accountId, accountName: this.lastResolvedAccountName ?? accountId };
	}

	// -------------------------------------------------------------------------
	// Определение accountId через UsersService.GetAccounts
	// -------------------------------------------------------------------------

    // 2. Убраны лишние скобки () после аргументов
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

	// -------------------------------------------------------------------------
	// Определение accountId, разбивка периода на чанки, обход "no data" — ветка сделок
	// -------------------------------------------------------------------------

	private isNoDataForPeriodError(error: unknown): boolean {
		if (!(error instanceof TBankApiError)) {
			return false;
		}
		return (
			error.message.includes('No data for the specified period') ||
			error.message.includes('"description":"30238"')
		);
	}

	/**
	 * Разбивает диапазон [fromDate, toDate] на последовательные под-периоды длиной
	 * не более maxDays дней каждый (включительно), чтобы обойти ограничение
	 * GetBrokerReport/GetOperations на максимальную длину запрашиваемого периода.
	 */
	private splitDateRangeIntoChunks(
		fromDate: string,
		toDate: string,
		maxDays: number
	): Array<{ from: string; to: string }> {
		const chunks: Array<{ from: string; to: string }> = [];

		const start = new Date(fromDate);
		const end = new Date(toDate);

		if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) {
			console.warn(
				`[TBankApi] Некорректный диапазон дат для запроса отчёта: "${fromDate}" - "${toDate}". ` +
					'Запрос будет выполнен как есть, без разбиения на чанки.'
			);
			return [{ from: fromDate, to: toDate }];
		}

		const maxChunkMs = maxDays * 24 * 60 * 60 * 1000;
		let chunkStart = start.getTime();
		const endMs = end.getTime();

		while (chunkStart <= endMs) {
			const chunkEnd = Math.min(chunkStart + maxChunkMs, endMs);
			chunks.push({
				from: new Date(chunkStart).toISOString(),
				to: new Date(chunkEnd).toISOString()
			});

			if (chunkEnd >= endMs) {
				break;
			}

			chunkStart = chunkEnd + 1;
		}

		return chunks;
	}

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

		for (const chunk of periodChunks) {
			console.log(`[TBankApi] Обрабатывается чанк: ${chunk.from} - ${chunk.to}`);
			try {
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
					if ((firstPage.pagesCount ?? 1) > 1) {
						console.warn(
							'[TBankApi] Отчёт пришёл синхронно сразу с несколькими страницами, но без taskId — ' +
								'догрузить оставшиеся страницы невозможно. Обработана только первая страница.'
						);
					}
				}

				allTransactions.push(...this.mapTradeRowsToTransactions(rows));
			} catch (error) {
				if (this.isNoDataForPeriodError(error)) {
					console.log(
						`[TBankApi] Нет данных по сделкам за период ${chunk.from} - ${chunk.to} (счёт ещё не был активен). Пропущено.`
					);
					continue;
				}
				throw error;
			}
		}

		return allTransactions;
	}

	/**
	 * Запрашивает генерацию отчёта. API может ответить двумя способами:
	 *  1) generateBrokerReportResponse с taskId — асинхронный сценарий, дальше нужно
	 *     опрашивать готовность через pollReportUntilReady;
	 *  2) getBrokerReportResponse с готовыми данными сразу — синхронный сценарий
	 *     (подтверждён фактическим ответом сервера для некоторых периодов/объёмов
	 *     данных), опрос не требуется.
	 */
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
				to: toDate
			}
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
						page: 0
					}
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
					page
				}
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

	/**
	 * Преобразует сырые строки GetBrokerReport в Transaction[] на основе реальной схемы
	 * ответа API (подтверждённой фактическим дампом строки, а не документацией).
	 *
	 * Приоритет источника суммы сделки: totalOrderAmount (сумма с учётом НКД) ->
	 * orderAmount (без НКД) -> amount * price как последний резерв. Для облигаций
	 * price.currency может быть "%" (цена в процентах от номинала) — в этом случае
	 * price в Transaction всё равно заполняется числом из ответа API, но потребитель
	 * (UI, PortfolioCalculator) должен понимать, что для облигаций это НЕ рублёвая
	 * цена за единицу — известное ограничение текущей версии, требующее отдельной
	 * обработки облигаций в будущем.
	 */
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

			transactions.push({
				id: row.tradeId ?? `tbank-trade-${row.tradeDatetime}-${ticker}-${amount}-${price}`,
				date: new Date(row.tradeDatetime).toISOString(),
				broker: 'tbank',
				ticker,
				shareName: row.name ?? ticker,
				type,
				amount,
				price,
				totalSum,
				currency,
				figi: row.figi
			});
		}

		return transactions;
	}

	// -------------------------------------------------------------------------
	// Ветка Б: остальные операции через GetOperations (с разбивкой на чанки
	// и пропуском периодов "нет данных" — по аналогии с fetchTrades)
	// -------------------------------------------------------------------------

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
					state: 'OPERATION_STATE_EXECUTED'
				};

				const responseBody = await this.callMethod<unknown>(
					token,
					TBankApi.OPERATIONS_METHOD_PATH,
					requestBody
				);

				if (!isOperationsResponse(responseBody)) {
					throw new TBankApiError(
						'T-Invest API вернул неожиданный формат ответа на запрос GetOperations. ' +
							'Проверьте права токена (нужен доступ к операциям по счёту).'
					);
				}

				const operations = responseBody.operations ?? [];

				for (const op of operations) {
					const resolvedType = resolveNonTradeType(op);

					// Сделки в этой ветке намеренно игнорируются — они уже получены через
					// GetBrokerReport и содержат более точные параметры (комиссии, номер сделки и т.д.).
					if (!resolvedType || resolvedType === 'TRADE') {
						continue;
					}

					if (!op.date) {
						console.warn('[TBankApi] Операция GetOperations без даты, пропущена.', op);
						continue;
					}

					const totalSum = Math.abs(moneyValueToNumber(op.payment));
					const price = Math.abs(moneyValueToNumber(op.price));
					const amount = Math.abs(Number.parseFloat(op.quantity ?? '0')) || 0;
					const currency = op.currency ?? op.payment?.currency;

					const instrumentId = op.figi || op.instrumentUid || '';
					let ticker = '';
					let shareName = '';

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
						currency
					});
				}
			} catch (error) {
				if (this.isNoDataForPeriodError(error)) {
					console.log(
						`[TBankApi] Нет данных по операциям за период ${chunk.from} - ${chunk.to} (счёт ещё не был активен). Пропущено.`
					);
					continue;
				}
				throw error;
			}
		}

		return allTransactions;
	}

	// -------------------------------------------------------------------------
	// Резолвинг инструментов (InstrumentsService.GetInstrumentBy) с кешем
	// -------------------------------------------------------------------------

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
				id: figiOrUid
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
				shareName: instrument.name ?? instrument.ticker ?? figiOrUid
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

	/** Грубая эвристика: instrumentUid — это UUID v4, FIGI — короткий буквенно-цифровой код. */
	private looksLikeUuid(value: string): boolean {
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
	}

	// -------------------------------------------------------------------------
	// Слияние сделок и нетрейдовых операций
	// -------------------------------------------------------------------------

	private mergeTransactions(
		trades: Transaction[],
		nonTradeOperations: Transaction[]
	): Transaction[] {
		const seenIds = new Set<string>();
		const merged: Transaction[] = [];

		for (const transaction of [...trades, ...nonTradeOperations]) {
			if (seenIds.has(transaction.id)) {
				continue;
			}
			seenIds.add(transaction.id);
			merged.push(transaction);
		}

		merged.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
		return merged;
	}

	// -------------------------------------------------------------------------
	// Транспортный слой: requestUrl + сериализованная очередь + retry на 429
	// -------------------------------------------------------------------------

	/**
	 * Единая точка выполнения POST-запросов к grpc-gateway T-Invest API.
	 * Каждый вызов "встаёт в очередь" через enqueue(), которая гарантирует:
	 *  - строго последовательное выполнение всех запросов этого инстанса TBankApi
	 *    (даже если сам код вызвал несколько операций параллельно через Promise.all);
	 *  - минимальную паузу MIN_REQUEST_INTERVAL_MS между концом одного запроса
	 *    (включая его retry-попытки) и стартом следующего.
	 * Использует Obsidian requestUrl вместо браузерного fetch, так как requestUrl
	 * выполняется в контексте Electron/Node и не подчиняется CORS-политике браузера —
	 * это устраняет наблюдавшуюся ошибку "blocked by CORS policy", которая на самом деле
	 * была лишь побочным эффектом сетевого сбоя (в частности, ответа 429 без нужных
	 * заголовков), а не самостоятельной причиной.
	 */
	private async callMethod<TResponse>(
		token: string,
		methodPath: string,
		body: unknown
	): Promise<TResponse> {
		return this.enqueue(() => this.executeWithRetry<TResponse>(token, methodPath, body));
	}

	/**
	 * Ставит переданную асинхронную задачу в конец общей очереди запросов инстанса.
	 * Использует "chained promise": следующая задача стартует только после того, как
	 * предыдущая полностью завершится (успешно или с ошибкой) и после этого пройдёт
	 * пауза MIN_REQUEST_INTERVAL_MS. Такой подход надёжен при параллельных вызовах
	 * (например, из Promise.all в fetchBrokerReport), в отличие от простой проверки
	 * "прошло ли N мс с последнего запроса", которая подвержена гонке между корутинами.
	 */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const resultPromise = this.requestQueueTail.then(() => task());

		// Хвост очереди обновляется на промис паузы (не результата задачи), чтобы гарантировать
		// интервал MIN_REQUEST_INTERVAL_MS перед стартом следующей задачи независимо от того,
		// завершилась текущая успехом или ошибкой (используем .catch(() => {}), чтобы отклонение
		// текущей задачи не "отравляло" очередь и не блокировало последующие запросы).
		this.requestQueueTail = resultPromise
			.catch(() => {
				/* ошибка обработается на стороне вызывающего кода через await resultPromise */
			})
			.then(() => sleep(TBankApi.MIN_REQUEST_INTERVAL_MS));

		return resultPromise;
	}

	/**
	 * Выполняет один HTTP-запрос с автоматическим повтором при ответе 429
	 * (Too Many Requests). Использует экспоненциальный backoff: каждая следующая
	 * попытка ждёт вдвое дольше предыдущей. Если сервер прислал заголовок
	 * Retry-After, он имеет приоритет над расчётной задержкой.
	 */
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

		// Формально недостижимо (цикл выше либо возвращает, либо бросает), но нужно для типов.
		throw lastError instanceof RateLimitError
			? lastError.toTBankApiError()
			: new TBankApiError('Не удалось выполнить запрос к T-Invest API после повторных попыток.', lastError);
	}

	/** Выполняет непосредственно один HTTP-вызов через Obsidian requestUrl. */
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
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify(body),
				// Без этого флага Obsidian requestUrl бросает исключение сам при статусах >= 400,
				// что помешало бы нам вручную различать 401/403/429/прочие ошибки ниже.
				throw: false
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

/**
 * Внутренний служебный класс ошибки 429 — используется только внутри executeWithRetry
 * для передачи retryAfterMs между performRequest и логикой повторных попыток.
 * Наружу (из fetchBrokerReport) наружу выходит уже обычный TBankApiError.
 */
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