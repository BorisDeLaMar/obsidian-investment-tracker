import * as XLSX from 'xlsx';
import { Transaction } from '../types';

export class TBankXlsxParser {
    public parse(buffer: ArrayBuffer): Transaction[] {
        const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        const sheet = workbook.Sheets['broker_rep'];
        if (!sheet) return [];

        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const transactions: Transaction[] = [];

        const isinMap = this.parseIsinMapping(rows);

        // ------------------------------------------------------------
        // 1. Парсинг секции "1.1 Информация о совершенных сделках"
        // ------------------------------------------------------------
        let tradeHeaderRowIdx = -1;
        let tradeColMap: Record<string, number> = {};

        // Ищем строку заголовка, которая начинается с "Номер сделки"
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (String(row[0] || '').trim() === 'Номер сделки') {
                tradeHeaderRowIdx = i;
                // Сканируем все колонки этой строки и ищем названия
                row.forEach((val: string, idx: number) => {
                    const v = String(val).trim();
                    if (v === 'Номер сделки') tradeColMap.tradeId = idx;
                    else if (v === 'Дата заключения') tradeColMap.date = idx;
                    else if (v === 'Вид сделки') tradeColMap.type = idx;
                    else if (v === 'Время') tradeColMap.time = idx; // <-- добавляем
                    else if (v === 'Наименование актива') tradeColMap.name = idx;
                    else if (v === 'Код актива') tradeColMap.ticker = idx;
                    else if (v === 'Цена за единицу') tradeColMap.price = idx;
                    else if (v === 'Валюта цены') tradeColMap.currency = idx;
                    else if (v === 'Количество') tradeColMap.amount = idx;
                    else if (v === 'Сумма сделки') tradeColMap.totalSum = idx;
                    else if (v === 'НКД') tradeColMap.aci = idx;
                    else if (v === 'Комиссия брокера') tradeColMap.brokerFee = idx;
                });
                break;
            }
        }

        // Если заголовок найден, парсим строки сделок
        if (tradeHeaderRowIdx !== -1) {
            for (let i = tradeHeaderRowIdx + 1; i < rows.length; i++) {
                const row = rows[i];
                if (String(row[0]).startsWith('1.2') || row.every((c: any) => !c)) break;

                const tradeId = String(row[tradeColMap.tradeId] || '').trim();
                if (!tradeId) continue;

                const dateStr = String(row[tradeColMap.date] || '').trim();
                const ticker = String(row[tradeColMap.ticker] || '').trim();
                const timeStr = String(row[tradeColMap.time] || '').trim(); // если колонка есть, иначе ''
                const time = timeStr || undefined;
                const typeStr = String(row[tradeColMap.type] || '').trim();
                const amount = parseFloat(String(row[tradeColMap.amount] || '0'));
                const price = parseFloat(String(row[tradeColMap.price] || '0'));
                const totalSum = parseFloat(String(row[tradeColMap.totalSum] || '0'));
                const brokerFee = parseFloat(String(row[tradeColMap.brokerFee] || '0'));
                const currency = String(row[tradeColMap.currency] || 'RUB').trim();

                if (!dateStr || !ticker || amount === 0 || price === 0) continue;

                let type: 'BUY' | 'SELL' | null = null;
                if (typeStr.includes('Покупка')) type = 'BUY';
                else if (typeStr.includes('Продажа')) type = 'SELL';
                if (!type) continue;

                const isoDate = this.normalizeDate(dateStr);
                if (!isoDate) continue;

                // Добавляем сделку
                transactions.push({
                    id: `tbank-xlsx-trade-${tradeId}`,
                    date: isoDate,
                    time: time, // <-- добавляем
                    broker: 'tbank',
                    ticker: ticker.toUpperCase(),
                    shareName: String(row[tradeColMap.name] || ticker).trim(),
                    type,
                    amount: Math.abs(amount),
                    price: Math.abs(price),
                    totalSum: Math.abs(totalSum),
                    currency: currency.toUpperCase(),
                    figi: ticker,
                    tradeId
                });

                // Если есть брокерская комиссия, добавляем как FEE
                if (brokerFee > 0) {
                    transactions.push({
                        id: `tbank-xlsx-fee-${tradeId}`,
                        date: isoDate,
                        broker: 'tbank',
                        ticker: 'RUB',
                        shareName: 'Комиссия брокера',
                        type: 'FEE',
                        amount: 1,
                        price: Math.abs(brokerFee),
                        totalSum: Math.abs(brokerFee),
                        currency: 'RUB',
                        tradeId
                    });
                }
            }
        }

        // ------------------------------------------------------------
        // 2. Парсинг секции "2. Операции с денежными средствами"
        // ------------------------------------------------------------
        let cashHeaderRowIdx = -1;
        let cashColMap: Record<string, number> = {};

        // Ищем строку с "Дата" и "Операция" и "Сумма зачисления"
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (String(row[0] || '').trim() === 'Дата') {
                let hasOp = false, hasIn = false, hasOut = false;
                row.forEach((val: string) => {
                    const v = String(val).trim();
                    if (v === 'Операция') hasOp = true;
                    if (v === 'Сумма зачисления') hasIn = true;
                    if (v === 'Сумма списания') hasOut = true;
                });

                if (hasOp && hasIn && hasOut) {
                    cashHeaderRowIdx = i;
                    row.forEach((val: string, idx: number) => {
                        const v = String(val).trim();
                        if (v === 'Дата исполнения') cashColMap.date = idx;
                        else if (v === 'Операция') cashColMap.type = idx;
                        else if (v === 'Сумма зачисления') cashColMap.in = idx;
                        else if (v === 'Сумма списания') cashColMap.out = idx;
                        else if (v === 'Примечание') cashColMap.note = idx;
                    });
                    break;
                }
            }
        }

        if (cashHeaderRowIdx !== -1) {
            for (let i = cashHeaderRowIdx + 1; i < rows.length; i++) {
                const row = rows[i];
                if (String(row[0]).startsWith('3.') || row.every((c: any) => !c)) break;

                const dateStr = String(row[cashColMap.date] || '').trim();
                const typeText = String(row[cashColMap.type] || '').trim();
                const amountIn = parseFloat(String(row[cashColMap.in] || '0'));
                const amountOut = parseFloat(String(row[cashColMap.out] || '0'));
                const note = String(row[cashColMap.note] || '').trim();

                if (!dateStr) continue;

                const isoDate = this.normalizeDate(dateStr);
                if (!isoDate) continue;

                let transactionType: Transaction['type'] | null = null;
                let amount = 0;
                let shareName = '';

                if (typeText === 'Покупка/продажа') continue; // пропускаем сделки

                if (typeText.includes('Комиссия за сделки')) {
                    transactionType = 'FEE';
                    amount = Math.abs(amountOut);
                    shareName = 'Комиссия за сделки';
                } else if (typeText.includes('Выплата доходов по корпоративным действиям')) {
                    transactionType = 'DIV';
                    amount = Math.abs(amountIn);
                    shareName = note.length > 0 ? note : 'Выплата доходов';
                } else if (typeText.includes('Налог (дивиденды)')) {
                    transactionType = 'TAX';
                    amount = Math.abs(amountOut);
                    shareName = 'Налог на доходы';
                } else if (typeText.toLowerCase().includes('пополнение')) {
                    transactionType = 'CASH_IN';
                    amount = Math.abs(amountIn);
                    shareName = 'Пополнение счёта';
                } else if (typeText.toLowerCase().includes('вывод') || typeText.toLowerCase().includes('списание')) {
                    transactionType = 'CASH_OUT';
                    amount = Math.abs(amountOut);
                    shareName = 'Вывод средств';
                } else {
                    continue;
                }

                if (amount === 0) continue;

                let ticker = 'RUB';
                const isinMatch = note.match(/\b(RU[A-Z0-9]{10})\b/);
                if (isinMatch) ticker = isinMatch[1];
                else if (note.includes('ISIN:')) {
                    const parts = note.split('ISIN:');
                    if (parts.length > 1) {
                        const maybeIsin = parts[1].split(',')[0].trim();
                        if (/^[A-Z0-9]{12}$/.test(maybeIsin)) ticker = maybeIsin;
                    }
                }

                const idBase = `tbank-xlsx-cash-${isoDate}-${transactionType}-${amount}`;
                const isin = isinMap.get(ticker);
                transactions.push({
                    id: idBase,
                    date: isoDate,
                    broker: 'tbank',
                    ticker: ticker.toUpperCase(),
                    shareName: shareName,
                    type: transactionType,
                    figi: isin || ticker,
                    amount: 1,
                    price: amount,
                    totalSum: amount,
                    currency: 'RUB'
                });
            }
        }

        transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        return transactions;
    }

        /**
     * Парсит секцию "3.1 Движение по ценным бумагам" и возвращает Map<код_актива, ISIN>
     */
    private parseIsinMapping(rows: any[][]): Map<string, string> {
        const map = new Map<string, string>();

        // Ищем строку с заголовками "Наименование актива", "Код актива", "ISIN"
        let headerIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowStr = row.map(c => String(c).trim()).join(' ');
            if (rowStr.includes('Наименование актива') && rowStr.includes('Код актива') && rowStr.includes('ISIN')) {
                headerIndex = i;
                break;
            }
        }

        if (headerIndex === -1) {
            console.warn('[TBankXlsxParser] Секция 3.1 (Движение по ЦБ) не найдена, ISIN-маппинг пуст.');
            return map;
        }

        // Определяем индексы колонок
        const headerRow = rows[headerIndex];
        let codeIdx = -1, isinIdx = -1;
        headerRow.forEach((val: string, idx: number) => {
            const v = String(val).trim();
            if (v === 'Код актива') codeIdx = idx;
            if (v === 'ISIN') isinIdx = idx;
        });

        if (codeIdx === -1 || isinIdx === -1) {
            console.warn('[TBankXlsxParser] Не найдены колонки "Код актива" или "ISIN" в секции 3.1.');
            return map;
        }

        // Читаем строки данных до следующей секции (например, 3.2 или 4.1)
        for (let i = headerIndex + 1; i < rows.length; i++) {
            const row = rows[i];
            const firstCell = String(row[0] || '').trim();
            // Если встречаем новую секцию – выходим
            if (firstCell.startsWith('3.2') || firstCell.startsWith('4.')) break;
            // Если строка пустая – пропускаем
            if (row.every(c => !c)) continue;

            const code = String(row[codeIdx] || '').trim();
            const isin = String(row[isinIdx] || '').trim();
            if (code && isin) {
                map.set(code, isin);
            }
        }

        console.log(`[TBankXlsxParser] Найдено ISIN для ${map.size} инструментов.`);
        return map;
    }

    private normalizeDate(dateStr: string): string {
        const trimmed = dateStr.trim();
        const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

        const ruMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
        if (ruMatch) return `${ruMatch[3]}-${ruMatch[2]}-${ruMatch[1]}`;

        return trimmed.slice(0, 10);
    }
}