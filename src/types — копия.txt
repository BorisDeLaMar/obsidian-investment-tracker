	// src/types.ts
/**
 * Брокер, из отчёта которого получена транзакция.
 */
export type BrokerSource = 'tbank' | 'sber';

/**
 * Тип операции в едином представлении плагина.
 */
export type TransactionType =
	| 'BUY'
	| 'SELL'
	| 'DIV'
	| 'COUPON'
	| 'TAX'
	| 'FEE'
	| 'CASH_IN'
	| 'CASH_OUT';

export type InstrumentKind = 'STOCK' | 'BOND' | 'FUND' | 'UNKNOWN';

export interface Transaction {
    id: string;
    date: string;
    /** Время сделки в формате "HH:MM:SS" (опционально) – используется для точной дедупликации */
    time?: string;
    broker: 'tbank' | 'sber';
    ticker: string;
    shareName: string;
    type: TransactionType | 'BUY' | 'SELL';
    amount: number;
    price: number;
    totalSum: number;
    currency?: string;
    figi?: string;
    tradeId?: string;
}

export interface Position {
	ticker: string;
	shareName: string;
	amount: number;
	averagePrice: number;
	currentPrice: number;
	currentTotal: number;
	shareInPortfolio: number;
	profitPercent: number;
	/** FIGI последней известной сделки по этому тикеру — используется как fallback для получения цены. */
	figi?: string;
	/**
	 * Номинал облигации (только для instrumentKind === 'BOND'), нужен, чтобы правильно
	 * перевести currentPrice (в процентах от номинала) в рублёвую стоимость.
	 */
	faceValue?: number;
	instrumentKind?: InstrumentKind;
		/** Разбивка позиции по брокерам — всегда непустой массив (1 или 2 элемента). */
	brokerBreakdown: BrokerSubPosition[];
	hasMarketPrice: boolean;
}

/**
 * Настройки плагина.
 */
export interface PluginSettings {
	/** Персональный токен доступа к T-Invest API (Bearer-токен, выпускается в личном кабинете). */
	tbankApiToken: string;

	/** Путь к папке в хранилище Obsidian, куда пользователь может класть отчёты для ручного импорта. */
	reportFolderPath: string;

	/** Дата последней успешной синхронизации с T-Invest API, ISO 8601. Используется как "fromDate" для инкрементальной загрузки. */
	lastSyncDate: string;

	/** Дата, раньше которой не нужно запрашивать историю у T-Invest API (например, дата открытия счёта). */
	syncFromDate: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	tbankApiToken: '',
	reportFolderPath: 'Investments/Reports',
	lastSyncDate: '',
	syncFromDate: ''
};

/**
 * Точка исторического таймлайна капитала — одна дата в графике "стоимость портфеля
 * vs сумма внесённых средств".
 */
export interface PortfolioSnapshot {
	/** Дата снапшота в формате "YYYY-MM-DD". */
	date: string;

	/** Общая стоимость портфеля на эту дату: cashBalance + assetsValue. */
	totalCapital: number;

	/** Остаток денежных средств на эту дату. */
	cashBalance: number;

	/** Стоимость удерживаемых активов на эту дату (по цене покупки, без учёта рыночной переоценки). */
	assetsValue: number;

	/** Чистая сумма внесённых средств на эту дату: накопленные CASH_IN минус CASH_OUT. */
	totalInvested: number;

	/** Абсолютная прибыль/убыток на эту дату: totalCapital - totalInvested. */
	profitAbsolute: number;
}

/**
 * Детализация позиции по одному брокеру внутри общей позиции по тикеру.
 */
export interface BrokerSubPosition {
	broker: BrokerSource;
	amount: number;
	averagePrice: number;
	/** Текущая рублёвая стоимость этой подпозиции (amount × currentPrice). */
	currentValue: number;
}

/**
 * Сводка по одному брокеру для карточек дашборда.
 */
export interface BrokerSummary {
	broker: BrokerSource;
	/** Рыночная стоимость активов + остаток кэша у этого брокера. */
	currentValue: number;
	/** Чистая сумма внесённых средств (CASH_IN - CASH_OUT). */
	totalInvested: number;
	/** Прибыль в рублях (currentValue - totalInvested). */
	profit: number;
	/** Прибыль в процентах. */
	profitPercent: number;
}