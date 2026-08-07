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

    public async saveTransactions(newTransactions: Transaction[]): Promise<void> {
        console.log('[DataStore] saveTransactions вызван. Количество:', newTransactions.length);

        if (!newTransactions || newTransactions.length === 0) {
            return;
        }

        const existingData = await this.readFile();
        const existingTransactions = existingData.transactions;

        // Объединяем и дедуплицируем
        const all = [...existingTransactions, ...newTransactions];
        const seen = new Map<string, Transaction>();
        for (const tx of all) {
			const amountKey = Math.round(tx.amount * 1e6) / 1e6;
			const totalSumKey = Math.round(tx.totalSum * 1e6) / 1e6;
			const key = `${tx.broker}|${tx.ticker}|${tx.date}|${tx.type}|${amountKey}|${totalSumKey}`;
            seen.set(key, tx);
        }
        const merged = Array.from(seen.values());
        merged.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        const updatedData: TransactionsFileSchema = {
            schemaVersion: existingData.schemaVersion,
            transactions: merged
        };

        await this.writeFile(updatedData);
        console.log(`[DataStore] Импорт завершён. Всего в базе: ${merged.length}.`);
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