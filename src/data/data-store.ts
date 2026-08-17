// src/data/data-store.ts

import { App, normalizePath } from 'obsidian';
import { Transaction } from '../types';

const PLUGIN_ID = 'obsidian-investment-tracker';

interface TransactionsFileSchema {
    schemaVersion: number;
    transactions: Transaction[];
}

const EMPTY_TRANSACTIONS: TransactionsFileSchema = {
    schemaVersion: 1,
    transactions: []
};

/**
 * Хранилище транзакций в отдельном файле transactions.json.
 * Настройки остаются в data.json (управляются Obsidian).
 */
export class DataStore {
    private readonly pluginDirPath: string;
    private readonly transactionsFilePath: string;
    private cache: TransactionsFileSchema | null = null;

    constructor(private readonly app: App) {
        this.pluginDirPath = normalizePath(`${this.app.vault.configDir}/plugins/${PLUGIN_ID}`);
        this.transactionsFilePath = normalizePath(`${this.pluginDirPath}/transactions.json`);
    }

	// src/data/data-store.ts

	// ... внутри класса DataStore ...

	/**
	 * Проверяет, есть ли уже транзакция с такими же брокером, типом и суммой,
	 * чья дата отличается от указанной не более чем на maxDaysDiff дней.
	 */
	private hasDuplicateCashOperation(
		existing: Transaction[],
		candidate: Transaction,
		maxDaysDiff: number = 4
	): boolean {
		if (candidate.type !== 'CASH_IN' && candidate.type !== 'CASH_OUT') {
			return false;
		}
		const candDate = new Date(candidate.date);
		for (const tx of existing) {
			if (tx.broker !== candidate.broker) continue;
			if (tx.type !== candidate.type) continue;
			if (Math.abs(tx.totalSum - candidate.totalSum) > 0.01) continue;
			const txDate = new Date(tx.date);
			const diffDays = Math.abs((txDate.getTime() - candDate.getTime()) / (1000 * 60 * 60 * 24));
			if (diffDays <= maxDaysDiff) {
				return true;
			}
		}
		return false;
	}

	public async saveTransactions(newTransactions: Transaction[], replace: boolean = false): Promise<void> {
		console.log(`[DataStore] saveTransactions вызван. Количество: ${newTransactions.length}, replace=${replace}`);

		if (!newTransactions || newTransactions.length === 0) {
			return;
		}

		if (replace) {
			const data: TransactionsFileSchema = {
				schemaVersion: 1,
				transactions: newTransactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
			};
			await this.writeFile(data);
			console.log(`[DataStore] Полная замена: записано ${newTransactions.length} транзакций.`);
			return;
		}

		const existingData = await this.readFile();
		const existingTransactions = existingData.transactions;

		// Собираем ключи существующих транзакций для точного совпадения (для BUY/SELL)
		const existingKeys = new Set<string>();
		for (const tx of existingTransactions) {
			existingKeys.add(this.generateDedupKey(tx));
		}

		const merged = [...existingTransactions];
		let addedCount = 0;

		for (const tx of newTransactions) {
			const key = this.generateDedupKey(tx);

			// Для CASH_IN/OUT используем проверку с диапазоном дат
			if (tx.type === 'CASH_IN' || tx.type === 'CASH_OUT') {
				if (this.hasDuplicateCashOperation(merged, tx, 4)) {
					console.log(`[DataStore] Пропущен дубликат (с допуском ±4 дня): ${key}`);
					continue;
				}
			} else {
				// Для остальных типов используем точное совпадение ключа
				if (existingKeys.has(key) || merged.some(m => this.generateDedupKey(m) === key && m.id !== tx.id)) {
					console.log(`[DataStore] Пропущен дубликат (точное совпадение): ${key}`);
					continue;
				}
			}

			// Добавляем
			merged.push(tx);
			existingKeys.add(key);
			addedCount++;
			console.log(`[DataStore] Добавлена новая транзакция: ${key}, тип=${tx.type}, сумма=${tx.totalSum}`);
		}

		merged.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

		const updatedData: TransactionsFileSchema = {
			schemaVersion: existingData.schemaVersion,
			transactions: merged
		};
		await this.writeFile(updatedData);
		console.log(`[DataStore] Импорт завершён. Добавлено ${addedCount} новых транзакций. Всего в базе: ${merged.length}.`);
	}

	private generateDedupKey(tx: Transaction): string {
		const dateOnly = tx.date.slice(0, 10);
		const totalKey = Math.round(tx.totalSum * 100) / 100;

		// Для BUY/SELL используем полный ключ (брокер|тип|дата|тикер|сумма)
		if (tx.type === 'BUY' || tx.type === 'SELL') {
			const ticker = tx.ticker || '';
			return `${tx.broker}|${tx.type}|${dateOnly}|${ticker}|${totalKey}`;
		}

		// Для всех остальных (CASH_IN, CASH_OUT, FEE, TAX, DIV, COUPON)
		// используем только брокер, дату и сумму (без типа и тикера)
		return `${tx.broker}|${dateOnly}|${totalKey}`;
	}

    public async getTransactions(): Promise<Transaction[]> {
        const data = await this.readFile();
        return [...data.transactions].sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );
    }

    public async clearAllTransactions(): Promise<void> {
        await this.writeFile({ ...EMPTY_TRANSACTIONS });
        console.log('[DataStore] Все транзакции удалены.');
    }

    // ---- Внутренние методы ----

    private async ensurePluginDirectoryExists(): Promise<void> {
        const dirExists = await this.app.vault.adapter.exists(this.pluginDirPath);
        if (!dirExists) {
            await this.app.vault.adapter.mkdir(this.pluginDirPath);
        }
    }

    private async readFile(): Promise<TransactionsFileSchema> {
        if (this.cache) return this.cache;

        try {
            const fileExists = await this.app.vault.adapter.exists(this.transactionsFilePath);
            if (!fileExists) {
                this.cache = { ...EMPTY_TRANSACTIONS };
                return this.cache;
            }

            const raw = await this.app.vault.adapter.read(this.transactionsFilePath);
            if (!raw || raw.trim().length === 0) {
                this.cache = { ...EMPTY_TRANSACTIONS };
                return this.cache;
            }

            const parsed = JSON.parse(raw) as Partial<TransactionsFileSchema>;
            if (!parsed || !Array.isArray(parsed.transactions)) {
                console.warn('[DataStore] transactions.json повреждён, инициализация пустой.');
                this.cache = { ...EMPTY_TRANSACTIONS };
                return this.cache;
            }

            this.cache = {
                schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
                transactions: parsed.transactions
            };
            return this.cache;
        } catch (error) {
            console.error('[DataStore] Ошибка чтения transactions.json', error);
            this.cache = { ...EMPTY_TRANSACTIONS };
            return this.cache;
        }
    }

    private async writeFile(data: TransactionsFileSchema): Promise<void> {
        console.log('[DataStore] Запись transactions.json, количество:', data.transactions.length);
        await this.ensurePluginDirectoryExists();
        const serialized = JSON.stringify(data, null, 2);
        try {
            await this.app.vault.adapter.write(this.transactionsFilePath, serialized);
            this.cache = data;
            console.log('[DataStore] transactions.json успешно записан.');
        } catch (error) {
            console.error('[DataStore] Ошибка записи transactions.json', error);
            throw error;
        }
    }
}