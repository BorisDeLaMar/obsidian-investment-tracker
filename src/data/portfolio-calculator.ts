// src/data/portfolio-calculator.ts

import { Transaction, Position, PortfolioSnapshot, InstrumentKind, BrokerSource, BrokerSubPosition, BrokerSummary } from '../types';
import { MoexPriceInfo } from '../api/moex-api';
import { BrokerTimeline } from '../view/capital-chart'; // добавьте импорт вверху



/**
 * Внутреннее представление позиции по тикеру, используемое во время
 * пошагового прохода по транзакциям (без привязки к текущей рыночной цене).
 */
interface InternalPositionState {
	amount: number;
	averagePrice: number;
	shareName: string;
}

/**
 * Внутреннее представление денежного состояния портфеля на конкретный момент.
 */
interface CashState {
	cashBalance: number;
	totalInvested: number;
}

/** Порог, ниже которого количество бумаг считается нулевым (защита от погрешностей float). */
const AMOUNT_EPSILON = 1e-8;

/**
 * Калькулятор портфеля: строит текущие позиции по тикерам и исторический
 * таймлайн капитала (для линейного графика на дашборде) на основе единого
 * массива Transaction[], полученного из парсеров или T-Invest API.
 */
export class PortfolioCalculator {
	/**
	 * Рассчитывает текущие позиции по всем тикерам на основе истории транзакций
	 * и словаря актуальных рыночных цен (например, с MOEX ISS).
	 *
	 * @param transactions   Полная история транзакций (любых брокеров, любого порядка по дате).
	 * @param currentPrices  Словарь "тикер -> актуальная цена". Если цена для тикера
	 *                       отсутствует, используется средняя цена покупки как fallback
	 *                       (с предупреждением в консоль), чтобы позиция не пропадала
	 *                       из дашборда из-за временной недоступности котировки.
	 */
	public calculateCurrentPositions(
		transactions: Transaction[],
		currentPrices: Map<string, MoexPriceInfo>
	): Position[] {
		const sorted = [...transactions].sort(
			(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
		);

		// Ключ: "ticker|broker" — позиции считаются раздельно по брокерам.
		const positions = new Map<string, InternalPositionState>();

		for (const transaction of sorted) {
			if (transaction.type === 'BUY' || transaction.type === 'SELL') {
				this.applyTradeToPositions(positions, transaction);
			}
		}

		const lastFigiByTicker = new Map<string, string>();
		for (const transaction of sorted) {
			if (transaction.figi) {
				lastFigiByTicker.set(transaction.ticker, transaction.figi);
			}
		}

		// Собираем сырые подпозиции (ticker, broker) → данные.
		type RawSubPos = {
			ticker: string;
			broker: BrokerSource;
			shareName: string;
			amount: number;
			averagePrice: number;
			currentPrice: number;
			currentTotal: number;
			figi?: string;
			faceValue?: number;
			instrumentKind?: InstrumentKind;
		};

		const rawSubPositions: RawSubPos[] = [];

		for (const [key, state] of positions.entries()) {
			if (state.amount <= AMOUNT_EPSILON) {
				continue;
			}

			const ticker = key.slice(0, key.lastIndexOf('|'));
			const priceInfo = currentPrices.get(ticker);
			let currentPrice: number;
			let currentTotal: number;
			let faceValue: number | undefined;
			let instrumentKind: InstrumentKind | undefined;

			if (!priceInfo) {
				// Если цена не найдена, используем цену покупки
				currentPrice = state.averagePrice;
				currentTotal = state.amount * currentPrice;
			} else if (priceInfo.instrumentKind === 'BOND' && priceInfo.faceValue) {
				// Облигация с известным номиналом
				faceValue = priceInfo.faceValue;
				instrumentKind = 'BOND';
				
				// Если номинал НЕ в рублях (квазивалютная облигация), оставляем цену покупки
				if (priceInfo.faceCurrency && priceInfo.faceCurrency !== 'RUB') {
					currentPrice = state.averagePrice;
					currentTotal = state.amount * currentPrice;
				} else {
					// Обычные рублёвые облигации — считаем по номиналу и % цене
					currentPrice = faceValue * (priceInfo.price / 100);
					currentTotal = state.amount * currentPrice;
				}
			} else {
				// --- ДОБАВЛЕННЫЙ БЛОК ELSE ---
				// Обычные акции, фонды или облигации без данных по номиналу
				instrumentKind = priceInfo.instrumentKind;
				currentPrice = priceInfo.price;
				currentTotal = state.amount * currentPrice;
			}

			rawSubPositions.push({
				ticker,
				broker: (key.includes('|tbank') ? 'tbank' : 'sber') as BrokerSource,
				shareName: state.shareName,
				amount: state.amount,
				averagePrice: state.averagePrice,
				currentPrice,
				currentTotal,
				figi: lastFigiByTicker.get(ticker),
				faceValue,
				instrumentKind
			});
		}

		// Группируем подпозиции по тикеру.
		const groupedByTicker = new Map<string, RawSubPos[]>();
		for (const sub of rawSubPositions) {
			const list = groupedByTicker.get(sub.ticker);
			if (list) {
				list.push(sub);
			} else {
				groupedByTicker.set(sub.ticker, [sub]);
			}
		}

		const positionsResult: Position[] = [];

		for (const [, subList] of groupedByTicker) {
			const totalAmount = subList.reduce((s, p) => s + p.amount, 0);
			const totalCurrentTotal = subList.reduce((s, p) => s + p.currentTotal, 0);
			const weightedPrice = totalAmount > 0
				? subList.reduce((s, p) => s + p.amount * p.averagePrice, 0) / totalAmount
				: 0;
			const first = subList[0];

			const brokerBreakdown: BrokerSubPosition[] = subList.map((p) => ({
				broker: p.broker,
				amount: p.amount,
				averagePrice: p.averagePrice,
				currentValue: p.currentTotal
			}));

			const investedAmount = totalAmount * weightedPrice;
			const profitPercent = investedAmount > 0 ? ((totalCurrentTotal - investedAmount) / investedAmount) * 100 : 0;

			positionsResult.push({
				ticker: first.ticker,
				shareName: first.shareName,
				amount: totalAmount,
				averagePrice: weightedPrice,
				currentPrice: first.currentPrice,
				currentTotal: totalCurrentTotal,
				profitPercent,
				shareInPortfolio: 0,
				figi: first.figi,
				faceValue: first.faceValue,
				instrumentKind: first.instrumentKind,
				brokerBreakdown
			});
		}

		const totalPortfolioValue = positionsResult.reduce((s, p) => s + p.currentTotal, 0);
		for (const p of positionsResult) {
			p.shareInPortfolio = totalPortfolioValue > 0 ? (p.currentTotal / totalPortfolioValue) * 100 : 0;
		}

		positionsResult.sort((a, b) => b.currentTotal - a.currentTotal);
		return positionsResult;
	}

		/**
	 * Рассчитывает сводку по каждому брокеру отдельно для карточек дашборда.
	 */
	public calculateBrokerSummaries(
		transactions: Transaction[],
		positions: Position[]
	): BrokerSummary[] {
		const cashByBroker = new Map<BrokerSource, { invested: number; balance: number }>();

		for (const t of transactions) {
			const broker = t.broker;
			let cs = cashByBroker.get(broker);
			if (!cs) {
				cs = { invested: 0, balance: 0 };
				cashByBroker.set(broker, cs);
			}

			switch (t.type) {
				case 'CASH_IN':
					cs.balance += t.totalSum;
					cs.invested += t.totalSum;
					break;
				case 'CASH_OUT':
					cs.balance -= t.totalSum;
					cs.invested -= t.totalSum;
					break;
				case 'DIV':
				case 'COUPON':
					cs.balance += t.totalSum;
					break;
				case 'TAX':
				case 'FEE':
					cs.balance -= t.totalSum;
					break;
				case 'BUY':
					cs.balance -= t.totalSum;
					break;
				case 'SELL':
					cs.balance += t.totalSum;
					break;
			}
		}

		const assetsByBroker = new Map<BrokerSource, number>();
		for (const pos of positions) {
			for (const bp of pos.brokerBreakdown) {
				const prev = assetsByBroker.get(bp.broker) ?? 0;
				assetsByBroker.set(bp.broker, prev + bp.currentValue);
			}
		}

		const result: BrokerSummary[] = [];
		for (const [broker, cs] of cashByBroker.entries()) {
			const assetValue = assetsByBroker.get(broker) ?? 0;
			const value = assetValue + cs.balance;
			const profit = value - cs.invested;
			const profitPercent = cs.invested > 0 ? (profit / cs.invested) * 100 : 0;
			result.push({
				broker,
				currentValue: value,
				totalInvested: cs.invested,
				profit,
				profitPercent
			});
		}

		return result;
	}

	private applyTradeToPositions(
		positions: Map<string, InternalPositionState>,
		transaction: Transaction
	): void {
		const ticker = transaction.ticker;
		if (!ticker) {
			console.warn(
				'[PortfolioCalculator] Сделка без тикера, пропущена при расчёте позиций.',
				transaction
			);
			return;
		}

		const key = `${ticker}|${transaction.broker}`;
		const pricePerUnit =
			transaction.amount > 0 ? transaction.totalSum / transaction.amount : 0;

		const existing = positions.get(key);

		if (transaction.type === 'BUY') {
			if (!existing || existing.amount <= AMOUNT_EPSILON) {
				positions.set(key, {
					amount: transaction.amount,
					averagePrice: pricePerUnit,
					shareName: transaction.shareName || ticker
				});
				return;
			}

			const oldSum = existing.amount * existing.averagePrice;
			const newSum = transaction.amount * pricePerUnit;
			const newAmount = existing.amount + transaction.amount;
			const newAveragePrice = newAmount > 0 ? (oldSum + newSum) / newAmount : 0;

			positions.set(key, {
				amount: newAmount,
				averagePrice: newAveragePrice,
				shareName: existing.shareName || transaction.shareName || ticker
			});
			return;
		}

		if (transaction.type === 'SELL') {
			if (!existing) {
				console.warn(
					`[PortfolioCalculator] Продажа тикера "${ticker}" без предшествующей покупки в истории ` +
						'транзакций. Позиция создана с нулевой средней ценой покупки.',
					transaction
				);
				positions.set(key, {
					amount: -transaction.amount,
					averagePrice: 0,
					shareName: transaction.shareName || ticker
				});
				return;
			}

			const newAmount = existing.amount - transaction.amount;
			positions.set(key, {
				amount: newAmount,
				averagePrice: existing.averagePrice,
				shareName: existing.shareName || transaction.shareName || ticker
			});
		}
	}

	/**
	 * Строит исторический таймлайн капитала по дням от даты первой транзакции
	 * до сегодняшнего дня (включительно) -> PortfolioSnapshot[].
	 *
	 * Стоимость удерживаемых активов на прошлые даты считается по средней цене
	 * их покупки из транзакций (без рыночной переоценки задним числом), так как
	 * у плагина нет полной исторической базы котировок MOEX за каждый день —
	 * это явное и осознанное упрощение, соответствующее условию задачи.
	 */
	public generateCapitalTimeline(transactions: Transaction[]): PortfolioSnapshot[] {
		if (!transactions || transactions.length === 0) {
			return [];
		}

		const sorted = [...transactions].sort(
			(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
		);

		const firstRaw = sorted[0]?.date || '';
    	const firstDate = firstRaw && firstRaw.length >= 10 
        ? this.toDateOnly(firstRaw) 	
        : this.toDateOnly(new Date().toISOString());
    // --------------------------

    	const today = this.toDateOnly(new Date().toISOString());
    	const allDates = this.buildDateRange(firstDate, today);

		// Группируем транзакции по дню, чтобы применять их пачками при проходе
		// по датам, а не сканировать весь массив на каждой итерации.
		const transactionsByDate = new Map<string, Transaction[]>();
		for (const transaction of sorted) {
			const dateKey = this.toDateOnly(transaction.date);
			const bucket = transactionsByDate.get(dateKey);
			if (bucket) {
				bucket.push(transaction);
			} else {
				transactionsByDate.set(dateKey, [transaction]);
			}
		}

		const cashState: CashState = { cashBalance: 0, totalInvested: 0 };
		const positions = new Map<string, InternalPositionState>();

		const snapshots: PortfolioSnapshot[] = [];

		for (const dateKey of allDates) {
			const dayTransactions = transactionsByDate.get(dateKey);

			if (dayTransactions) {
				for (const transaction of dayTransactions) {
					this.applyTransactionToCashAndPositions(cashState, positions, transaction);
				}
			}

			const assetsValue = this.sumPositionsAtCostPrice(positions);
			const totalCapital = cashState.cashBalance + assetsValue;
			const profitAbsolute = totalCapital - cashState.totalInvested;

			snapshots.push({
				date: dateKey,
				totalCapital,
				cashBalance: cashState.cashBalance,
				assetsValue,
				totalInvested: cashState.totalInvested,
				profitAbsolute
			});
		}

		return snapshots;
	}

	/**
	 * Применяет одну транзакцию к денежному состоянию (cashBalance/totalInvested)
	 * и, если это сделка, к позициям — используется при построении таймлайна.
	 */
	private applyTransactionToCashAndPositions(
		cashState: CashState,
		positions: Map<string, InternalPositionState>,
		transaction: Transaction
	): void {
		switch (transaction.type) {
			case 'CASH_IN':
				cashState.cashBalance += transaction.totalSum;
				cashState.totalInvested += transaction.totalSum;
				break;

			case 'CASH_OUT':
				cashState.cashBalance -= transaction.totalSum;
				cashState.totalInvested -= transaction.totalSum;
				break;

			case 'DIV':
			case 'COUPON':
				cashState.cashBalance += transaction.totalSum;
				break;

			case 'TAX':
			case 'FEE':
				cashState.cashBalance -= transaction.totalSum;
				break;

			case 'BUY':
				cashState.cashBalance -= transaction.totalSum;
				this.applyTradeToPositions(positions, transaction);
				break;

			case 'SELL':
				cashState.cashBalance += transaction.totalSum;
				this.applyTradeToPositions(positions, transaction);
				break;

			default:
				console.warn(
					`[PortfolioCalculator] Неизвестный тип транзакции "${transaction.type}", пропущена при построении таймлайна.`,
					transaction
				);
		}
	}

	/**
	 * Суммарная стоимость всех текущих позиций по средней цене покупки,
	 * без рыночной переоценки — используется для исторических точек таймлайна.
	 */
	private sumPositionsAtCostPrice(positions: Map<string, InternalPositionState>): number {
		let total = 0;
		for (const state of positions.values()) {
			if (state.amount > AMOUNT_EPSILON) {
				total += state.amount * state.averagePrice;
			}
		}
		return total;
	}

	/** Приводит ISO-дату/timestamp к формату "YYYY-MM-DD". */
		/** Приводит ISO-дату/timestamp к формату "YYYY-MM-DD". */
	private toDateOnly(isoDate: string): string {
		return isoDate.length >= 10 ? isoDate.slice(0, 10) : isoDate;
	}

	/**
	 * Строит непрерывный список дат в формате "YYYY-MM-DD" от startDate до endDate
	 * включительно, с шагом в один день. Используется для того, чтобы график капитала
	 * имел ровную временную ось без пропусков в днях без транзакций.
	 */
	private buildDateRange(startDate: string, endDate: string): string[] {
		const dates: string[] = [];

		const start = this.parseDateOnly(startDate);
		const end = this.parseDateOnly(endDate);

		if (!startDate || !endDate || startDate.length === 0 || endDate.length === 0) {
        	return [];
    	}

		if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
			console.warn(
				`[PortfolioCalculator] Некорректный диапазон дат для таймлайна: "${startDate}" - "${endDate}". Возвращён пустой список дат.`
			);
			return dates;
		}

		// Защита от аномально длинного диапазона (например, из-за битой даты в транзакции
		// вроде "2099-01-01"), чтобы не уйти в многолетний цикл и не подвесить Obsidian.
		const MAX_DAYS = 20000; // ~54 года — с большим запасом на любой реалистичный портфель
		let dayCount = 0;

		const cursor = new Date(start.getTime());
		while (cursor.getTime() <= end.getTime() && dayCount < MAX_DAYS) {
			dates.push(this.formatDateOnly(cursor));
			cursor.setUTCDate(cursor.getUTCDate() + 1);
			dayCount++;
		}

		if (dayCount >= MAX_DAYS) {
			console.warn(
				`[PortfolioCalculator] Диапазон дат таймлайна превысил ${MAX_DAYS} дней и был обрезан. ` +
					'Проверьте корректность дат в транзакциях.'
			);
		}

		return dates;
	}

	/** Парсит строку "YYYY-MM-DD" в Date, зафиксированную на полночь UTC. */
	private parseDateOnly(dateOnly: string): Date {
		return new Date(`${dateOnly}T00:00:00.000Z`);
	}

	/** Форматирует Date обратно в строку "YYYY-MM-DD" (в UTC, чтобы избежать сдвига по часовому поясу). */
	private formatDateOnly(date: Date): string {
		const year = date.getUTCFullYear();
		const month = String(date.getUTCMonth() + 1).padStart(2, '0');
		const day = String(date.getUTCDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	/**
	 * Считает общую чистую сумму внесённых средств (CASH_IN - CASH_OUT)
	 * напрямую по списку транзакций. Используется для главной карточки.
	 */
	public calculateTotalInvested(transactions: Transaction[]): number {
		let total = 0;
		for (const t of transactions) {
			if (t.type === 'CASH_IN') {
				total += t.totalSum;
			} else if (t.type === 'CASH_OUT') {
				total -= t.totalSum;
			}
		}
		return total;
	}

	public generateBrokerTimelines(transactions: Transaction[]): BrokerTimeline[] {
		const tbankTx = transactions.filter(t => t.broker === 'tbank');
		const sberTx = transactions.filter(t => t.broker === 'sber');
		const result: BrokerTimeline[] = [];
		if (tbankTx.length > 0) {
			result.push({ broker: 'tbank', snapshots: this.generateCapitalTimeline(tbankTx) });
		}
		if (sberTx.length > 0) {
			result.push({ broker: 'sber', snapshots: this.generateCapitalTimeline(sberTx) });
		}
		return result;
	}
}