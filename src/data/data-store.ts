// src/data/data-store.ts

import { App, normalizePath } from 'obsidian';
import { Transaction } from '../types';

/**
 * Идентификатор плагина. Должен совпадать с полем "id" в manifest.json,
 * так как именно оно определяет путь к папке плагина внутри .obsidian/plugins/.
 */
const PLUGIN_ID = 'obsidian-investment-tracker';

/**
 * Схема содержимого data.json. Обёрнута в объект с полем `transactions`
 * (а не хранится как «голый» массив), чтобы в будущем можно было безопасно
 * дописать в этот же файл другие агрегаты (например, кэш котировок MOEX
 * или таймлайн стоимости портфеля) без breaking change формата файла.
 */
interface DataFileSchema {
	/** Версия схемы файла — на случай будущих миграций формата. */
	schemaVersion: number;
	transactions: Transaction[];
}

const EMPTY_DATA: DataFileSchema = {
	schemaVersion: 1,
	transactions: []
};

/**
 * Хранилище агрегированных данных плагина поверх скрытого JSON-файла
 * `.obsidian/plugins/obsidian-investment-tracker/data.json`.
 *
 * Все операции чтения/записи идут через `this.app.vault.adapter`, так как
 * эта директория находится вне обычного пользовательского хранилища заметок
 * и не должна индексироваться Obsidian как часть vault-контента.
 */
export class DataStore {
	private readonly pluginDirPath: string;
	private readonly dataFilePath: string;

	/**
	 * Простой in-memory кеш последних прочитанных данных, чтобы дашборд
	 * (который может дёргать getTransactions() многократно за рендер)
	 * не делал лишние обращения к диску. Кеш сбрасывается при каждой
	 * успешной записи через saveTransactions().
	 */
	private cache: DataFileSchema | null = null;

	constructor(private readonly app: App) {
		this.pluginDirPath = normalizePath(`${this.app.vault.configDir}/plugins/${PLUGIN_ID}`);
		this.dataFilePath = normalizePath(`${this.pluginDirPath}/data.json`);
	}

	/**
	 * Сохраняет новые транзакции, объединяя их с уже существующими в data.json
	 * и отсекая дубликаты.
	 *
	 * Правило дедупликации: транзакции считаются дубликатом, если у них совпадают
	 * дата (с точностью до дня, "YYYY-MM-DD"), брокер, тикер (без учёта регистра),
	 * тип операции и итоговая сумма (с округлением до 2 знаков после запятой —
	 * чтобы избежать ложных расхождений из-за погрешностей float).
	 */
	public async saveTransactions(newTransactions: Transaction[]): Promise<void> {
		console.log('[DataStore] saveTransactions вызван! Количество транзакций:', newTransactions.length);
		if (newTransactions.length > 0) {
			console.log('[DataStore] Первая транзакция:', newTransactions[0]);
		}

		if (!newTransactions || newTransactions.length === 0) {
			return;
		}

		const existingData = await this.readFile();
		const dedupMap = new Map<string, Transaction>();

		// Заполняем карту существующими транзакциями
		for (const transaction of existingData.transactions) {
			dedupMap.set(this.buildDedupKey(transaction), transaction);
		}

		let addedCount = 0;
		let replacedCount = 0; // Считаем замены

		for (const transaction of newTransactions) {
			const key = this.buildDedupKey(transaction);
			const existing = dedupMap.get(key);
			
			if (existing) {
				// Если ключ совпадает, заменяем старую транзакцию новой (более актуальной)
				dedupMap.set(key, transaction);
				replacedCount++;
			} else {
				dedupMap.set(key, transaction);
				addedCount++;
			}
		}

		const mergedTransactions = Array.from(dedupMap.values());
		mergedTransactions.sort(
			(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
		);

		const updatedData: DataFileSchema = {
			schemaVersion: existingData.schemaVersion,
			transactions: mergedTransactions
		};

		await this.writeFile(updatedData);

		console.log(
			`[DataStore] Импорт завершён: добавлено ${addedCount} новых транзакций, ` +
			`заменено ${replacedCount} старых (обновлены данными из нового импорта). ` +
			`Всего в базе: ${mergedTransactions.length}.`
		);
	}

	/**
	 * Возвращает все сохранённые транзакции, отсортированные по дате
	 * от самых старых к самым новым.
	 *
	 * Метод асинхронный, так как Obsidian.Vault.adapter не предоставляет
	 * синхронного API для чтения файлов (read/write/exists строго Promise-based).
	 */
	public async getTransactions(): Promise<Transaction[]> {
		const data = await this.readFile();
		const sorted = [...data.transactions].sort(
			(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
		);
		return sorted;
	}

	/**
	 * Полностью очищает базу транзакций (например, для команды "Сбросить данные плагина").
	 * Явно вынесен отдельным методом, чтобы такое разрушительное действие
	 * не пряталось внутри saveTransactions с пустым массивом.
	 */
	public async clearAllTransactions(): Promise<void> {
		await this.writeFile({ ...EMPTY_DATA });
		console.log('[DataStore] Все транзакции удалены из локального хранилища.');
	}

	// ---------------------------------------------------------------------------
	// Внутренняя работа с файловой системой
	// ---------------------------------------------------------------------------

	/**
	 * Гарантирует существование папки плагина перед записью файла.
	 * Обычно она уже существует (Obsidian сам создаёт её при установке плагина),
	 * но при первом запуске сразу после ручной установки директории может не быть.
	 */
	private async ensurePluginDirectoryExists(): Promise<void> {
		const dirExists = await this.app.vault.adapter.exists(this.pluginDirPath);
		if (!dirExists) {
			await this.app.vault.adapter.mkdir(this.pluginDirPath);
		}
	}

	/**
	 * Читает и парсит data.json. При отсутствии файла, пустом содержимом
	 * или повреждённом JSON возвращает пустую схему вместо падения — импорт
	 * не должен срываться из-за проблем с ранее сохранёнными данными.
	 * Результат кешируется в памяти до следующей успешной записи.
	 */
	private async readFile(): Promise<DataFileSchema> {
		if (this.cache) {
			return this.cache;
		}

		try {
			const fileExists = await this.app.vault.adapter.exists(this.dataFilePath);
			if (!fileExists) {
				this.cache = { ...EMPTY_DATA, transactions: [] };
				return this.cache;
			}

			const rawContent = await this.app.vault.adapter.read(this.dataFilePath);
			if (!rawContent || rawContent.trim().length === 0) {
				this.cache = { ...EMPTY_DATA, transactions: [] };
				return this.cache;
			}

			const parsed = JSON.parse(rawContent) as Partial<DataFileSchema>;

			if (!parsed || !Array.isArray(parsed.transactions)) {
				console.warn(
					'[DataStore] Файл data.json повреждён или имеет неожиданный формат ' +
						'(поле transactions отсутствует или не является массивом). ' +
						'Хранилище инициализировано как пустое, старый файл не удалён.'
				);
				this.cache = { ...EMPTY_DATA, transactions: [] };
				return this.cache;
			}

			this.cache = {
				schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
				transactions: parsed.transactions
			};
			return this.cache;
		} catch (error) {
			console.error(
				'[DataStore] Ошибка при чтении/разборе data.json. Хранилище инициализировано как пустое.',
				error
			);
			this.cache = { ...EMPTY_DATA, transactions: [] };
			return this.cache;
		}
	}

	/**
	 * Сериализует и записывает схему данных в data.json, обновляя in-memory кеш.
	 */
	private async writeFile(data: DataFileSchema): Promise<void> {
		await this.ensurePluginDirectoryExists();

		const serialized = JSON.stringify(data, null, 2);

		try {
			await this.app.vault.adapter.write(this.dataFilePath, serialized);
			this.cache = data;
		} catch (error) {
			console.error('[DataStore] Не удалось записать data.json на диск.', error);
			throw error;
		}
	}

	// ---------------------------------------------------------------------------
	// Дедупликация
	// ---------------------------------------------------------------------------

	private buildDedupKey(transaction: Transaction): string {
		// 1. Если есть tradeId – используем его как самый надёжный ключ
		if (transaction.tradeId) {
			return `${transaction.broker}|TRADE|${transaction.tradeId}`;
		}

		const isoDate = transaction.date ?? '';
		const dateOnly = isoDate.length >= 10 ? isoDate.slice(0, 10) : isoDate;
		const normalizedTicker = (transaction.ticker ?? '').trim().toUpperCase();
		// Добавляем название (shareName) для надёжности, приводим к нижнему регистру, удаляем лишние пробелы
		const normalizedName = (transaction.shareName ?? '').trim().toLowerCase();

		// 2. Для сделок BUY/SELL – максимально детальный ключ
		if (transaction.type === 'BUY' || transaction.type === 'SELL') {
			const amountRounded = Math.round((transaction.amount || 0) * 100) / 100;
			const priceRounded = Math.round((transaction.price || 0) * 100) / 100;
			// Время, если есть, добавляем в формате HH:MM:SS
			const timePart = transaction.time ? `|${transaction.time}` : '';
			// Название включаем для дополнительной защиты от коллизий
			return `${dateOnly}${timePart}|${transaction.broker}|${normalizedTicker}|${normalizedName}|${transaction.type}|${amountRounded}|${priceRounded}`;
		}

		// 3. Для денежных операций – старый ключ по дате, брокеру, тикеру, типу и сумме
		const roundedSum = Math.round((transaction.totalSum ?? 0) * 100) / 100;
		return `${dateOnly}|${transaction.broker}|${normalizedTicker}|${transaction.type}|${roundedSum.toFixed(2)}`;
	}
}