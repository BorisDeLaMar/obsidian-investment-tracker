// src/data/portfolio-calculator.ts

import { Transaction, Position, PortfolioSnapshot, InstrumentKind, BrokerSource, BrokerSubPosition, BrokerSummary } from '../types';
import { MoexPriceInfo } from '../api/moex-api';
import { BrokerTimeline } from '../view/capital-chart';

interface InternalPositionState {
    amount: number;
    averagePrice: number;
    shareName: string;
}

const AMOUNT_EPSILON = 1e-8;

export class PortfolioCalculator {
    // --- existing methods (generateCapitalTimeline, etc.) remain the same, but we update applyTradeToPositions and calculateCurrentPositions ---

    public calculateCurrentPositions(
        transactions: Transaction[],
        currentPrices: Map<string, MoexPriceInfo>
    ): Position[] {
        const sorted = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        const positions = new Map<string, InternalPositionState>();
        for (const transaction of sorted) {
            if (transaction.type === 'BUY' || transaction.type === 'SELL') {
                this.applyTradeToPositions(positions, transaction);
            }
        }

        const lastFigiByTicker = new Map<string, string>();
        for (const transaction of sorted) {
            if (transaction.figi) lastFigiByTicker.set(transaction.ticker, transaction.figi);
        }

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
            hasMarketPrice: boolean;
        };

        const rawSubPositions: RawSubPos[] = [];

        for (const [key, state] of positions.entries()) {
            if (state.amount <= AMOUNT_EPSILON) continue;

            const ticker = key.slice(0, key.lastIndexOf('|'));
            const priceInfo = currentPrices.get(ticker);
			const shareNameFromPrice = priceInfo?.shareName || state.shareName;
            let currentPrice: number;
            let currentTotal: number;
            let faceValue: number | undefined;
            let instrumentKind: InstrumentKind | undefined;
            let hasMarketPrice = false;

            if (!priceInfo) {
                currentPrice = state.averagePrice;
                currentTotal = state.amount * currentPrice;
                hasMarketPrice = false;
            } else if (priceInfo.instrumentKind === 'BOND' && priceInfo.faceValue) {
                faceValue = priceInfo.faceValue;
                instrumentKind = 'BOND';

				// Считаем RUB-облигацией, если валюта RUB или SUR (или пустая)
				const isRub = !priceInfo.faceCurrency || 
							priceInfo.faceCurrency === 'RUB' || 
							priceInfo.faceCurrency === 'SUR';
				if (isRub) {
					hasMarketPrice = true;
					currentPrice = faceValue * (priceInfo.price / 100);
					currentTotal = state.amount * currentPrice;
				} else {
					// Валютная облигация (USD, CNY и т.д.)
					if (priceInfo.rubRate != null) {
						const priceInForeign = (priceInfo.price / 100) * faceValue;
						currentPrice = priceInForeign * priceInfo.rubRate;
						currentTotal = state.amount * currentPrice;
						hasMarketPrice = true;
					} else {
						hasMarketPrice = false;
						currentPrice = state.averagePrice; // для корректного подсчёта портфеля
						currentTotal = state.amount * currentPrice;
					}
				}
            } else {
                instrumentKind = priceInfo.instrumentKind;
                currentPrice = priceInfo.price;
                currentTotal = state.amount * currentPrice;
                hasMarketPrice = true;
            }

			//console.log(`[CALC] Позиция ${ticker}: priceInfo=${priceInfo}, hasMarketPrice=${hasMarketPrice}, currentPrice=${currentPrice}`);

            rawSubPositions.push({
                ticker,
                broker: (key.includes('|tbank') ? 'tbank' : 'sber') as BrokerSource,
                shareName: shareNameFromPrice,
                amount: state.amount,
                averagePrice: state.averagePrice,
                currentPrice,
                currentTotal,
                figi: lastFigiByTicker.get(ticker),
                faceValue,
                instrumentKind,
                hasMarketPrice
            });
        }

	        const groupedByTicker = new Map<string, RawSubPos[]>();
        for (const sub of rawSubPositions) {
            const list = groupedByTicker.get(sub.ticker);
            if (list) list.push(sub);
            else groupedByTicker.set(sub.ticker, [sub]);
        }

        const positionsResult: Position[] = [];

        for (const [, subList] of groupedByTicker) {
            const totalAmount = subList.reduce((s, p) => s + p.amount, 0);
            const totalCurrentTotal = subList.reduce((s, p) => s + p.currentTotal, 0);
            const weightedPrice = totalAmount > 0
                ? subList.reduce((s, p) => s + p.amount * p.averagePrice, 0) / totalAmount
                : 0;
            const first = subList[0];

            const brokerBreakdown: BrokerSubPosition[] = subList.map(p => ({
                broker: p.broker,
                amount: p.amount,
                averagePrice: p.averagePrice,
                currentValue: p.currentTotal
            }));

            const investedAmount = totalAmount * weightedPrice;
            const profitPercent = investedAmount > 0 ? ((totalCurrentTotal - investedAmount) / investedAmount) * 100 : 0;

            positionsResult.push({
                ticker: first.ticker,
                shareName: first.shareName, // но оно уже будет исправлено через rawSubPos
                amount: totalAmount,
                averagePrice: weightedPrice,
                currentPrice: first.currentPrice,
                currentTotal: totalCurrentTotal,
                profitPercent,
                shareInPortfolio: 0,
                figi: first.figi,
                faceValue: first.faceValue,
                instrumentKind: first.instrumentKind,
                brokerBreakdown,
                hasMarketPrice: first.hasMarketPrice
            });
        }

        const totalPortfolioValue = positionsResult.reduce((s, p) => s + p.currentTotal, 0);
        for (const p of positionsResult) {
            p.shareInPortfolio = totalPortfolioValue > 0 ? (p.currentTotal / totalPortfolioValue) * 100 : 0;
        }

        positionsResult.sort((a, b) => b.currentTotal - a.currentTotal);
        return positionsResult;
    }

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
			console.warn('[PortfolioCalculator] Сделка без тикера, пропущена', transaction);
			return;
		}
		const key = `${ticker}|${transaction.broker}`;
		//console.log(`[PortfolioCalculator] Обработка сделки: ${transaction.type} для ${key}, amount=${transaction.amount}, totalSum=${transaction.totalSum}`);
        const pricePerUnit = transaction.amount > 0 ? transaction.totalSum / transaction.amount : 0;

        if (transaction.type === 'BUY') {
            const existing = positions.get(key);
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
            const existing = positions.get(key);
            if (!existing) {
                // Если продажа без покупки – игнорируем или создаём отрицательную (но лучше создать временную)
                // Для безопасности просто не делаем ничего или создаём отрицательную
                return;
            }
            const newAmount = existing.amount - transaction.amount;
            // Если позиция полностью продана – удаляем из Map
            if (newAmount <= AMOUNT_EPSILON) {
                positions.delete(key);
            } else {
                positions.set(key, {
                    amount: newAmount,
                    averagePrice: existing.averagePrice,
                    shareName: existing.shareName || transaction.shareName || ticker
                });
            }
        }
    }

	public generateCapitalTimeline(transactions: Transaction[]): PortfolioSnapshot[] {
		if (!transactions || transactions.length === 0) {
			return [];
		}

		// 1. Сортируем и определяем диапазон
		const sorted = [...transactions].sort(
			(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
		);

		const firstDate = this.toDateOnly(sorted[0].date) || this.toDateOnly(new Date().toISOString());
		const today = this.toDateOnly(new Date().toISOString());
		const allDates = this.buildDateRange(firstDate, today);

		// 2. Группируем транзакции по дням
		const transactionsByDate = new Map<string, Transaction[]>();
		for (const transaction of sorted) {
			const dateKey = this.toDateOnly(transaction.date);
			if (!transactionsByDate.has(dateKey)) {
				transactionsByDate.set(dateKey, []);
			}
			transactionsByDate.get(dateKey)!.push(transaction);
		}

		// 3. Состояния (totalInvested считаем отдельно от cashBalance)
		let cashBalance = 0;
		let cumulativeInvested = 0;
		const positions = new Map<string, InternalPositionState>();
		const snapshots: PortfolioSnapshot[] = [];

		// 4. Проходим по каждому дню
		for (const dateKey of allDates) {
			const dayTxs = transactionsByDate.get(dateKey);

			if (dayTxs) {
				for (const tx of dayTxs) {
					switch (tx.type) {
						case 'CASH_IN':
							cashBalance += tx.totalSum;
							cumulativeInvested += tx.totalSum;
							break;
						case 'CASH_OUT':
							cashBalance -= tx.totalSum;
							cumulativeInvested -= tx.totalSum;
							break;
						case 'DIV':
						case 'COUPON':
							cashBalance += tx.totalSum;
							break;
						case 'TAX':
						case 'FEE':
							cashBalance -= tx.totalSum;
							break;
						case 'BUY':
							cashBalance -= tx.totalSum;
							this.applyTradeToPositions(positions, tx);
							break;
						case 'SELL':
							cashBalance += tx.totalSum;
							this.applyTradeToPositions(positions, tx);
							break;
					}
				}
			}

			// 5. Считаем активы по средней цене и формируем снапшот
			const assetsValue = this.sumPositionsAtCostPrice(positions);
			const totalCapital = cashBalance + assetsValue;
			const profitAbsolute = totalCapital - cumulativeInvested;

			snapshots.push({
				date: dateKey,
				totalCapital,
				cashBalance,
				assetsValue,
				totalInvested: cumulativeInvested, // <--- ЗНАЧЕНИЕ ГАРАНТИРОВАННО ПЕРЕДАЁТСЯ
				profitAbsolute
			});
		}

		return snapshots;
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

	private toDateOnly(isoDate: string): string {
		if (!isoDate) return '';
		// Если дата содержит время через T или пробел, берём только первую часть
		const parts = isoDate.split(/[ T]/);
		return parts[0] || '';
	}

	private buildDateRange(startDate: string, endDate: string): string[] {
		if (!startDate || !endDate) {
			console.warn('[PortfolioCalculator] buildDateRange: пустая startDate или endDate');
			// В крайнем случае возвращаем сегодняшнюю дату
			const today = new Date();
			return [this.formatDateOnly(today)];
		}

		// Пытаемся распарсить даты. Если не получается – используем сегодня.
		let start = new Date(startDate);
		let end = new Date(endDate);

		if (isNaN(start.getTime())) {
			console.warn(`[PortfolioCalculator] startDate "${startDate}" невалидна, используем сегодня`);
			start = new Date();
		}
		if (isNaN(end.getTime())) {
			console.warn(`[PortfolioCalculator] endDate "${endDate}" невалидна, используем сегодня`);
			end = new Date();
		}

		// Если start > end, меняем местами (на всякий случай)
		if (start.getTime() > end.getTime()) {
			console.warn('[PortfolioCalculator] startDate > endDate, меняем местами');
			[start, end] = [end, start];
		}

		const dates: string[] = [];
		let cursor = new Date(start);
		const MAX_DAYS = 20000;
		let dayCount = 0;

		while (cursor.getTime() <= end.getTime() && dayCount < MAX_DAYS) {
			dates.push(this.formatDateOnly(cursor));
			cursor.setUTCDate(cursor.getUTCDate() + 1);
			dayCount++;
		}

		if (dates.length === 0) {
			// Если диапазон не дал ни одной даты (например, start == end), добавляем одну точку
			dates.push(this.formatDateOnly(start));
		}

		return dates;
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