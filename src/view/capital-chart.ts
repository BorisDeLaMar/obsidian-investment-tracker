// src/view/capital-chart.ts

import {
	Chart,
	ChartConfiguration,
	TooltipItem,
	registerables
} from 'chart.js';
import { PortfolioSnapshot } from '../types';

Chart.register(...registerables);

function formatCurrency(value: number): string {
	return new Intl.NumberFormat('ru-RU', {
		style: 'currency',
		currency: 'RUB',
		maximumFractionDigits: 0,
		minimumFractionDigits: 0
	}).format(value);
}

function formatDateLabel(isoDate: string): string {
    // Обрезаем всё, что идёт после T (время), чтобы осталась только дата
    const datePart = isoDate.split('T')[0];
    const parts = datePart.split('-');
    if (parts.length !== 3) return datePart;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function resolveThemeColor(variableName: string, fallback: string): string {
	const computed = getComputedStyle(document.body).getPropertyValue(variableName).trim();
	return computed.length > 0 ? computed : fallback;
}

export interface BrokerTimeline {
	broker: 'tbank' | 'sber';
	snapshots: PortfolioSnapshot[];
}

export class CapitalChart {
	private canvasEl: HTMLCanvasElement | null = null;
	private chartInstance: Chart<'line', number[], string> | null = null;
	private isMerged = false;
	private toggleContainer: HTMLElement | null = null;

	constructor(
		private readonly container: HTMLElement,
		private readonly combinedSnapshots: PortfolioSnapshot[],
		private readonly brokerTimelines?: BrokerTimeline[]
	) {}

	public render(): void {
		this.destroy();
		this.clearContainer();

		// Кнопка-переключатель "Единый / По брокерам".
		if (this.brokerTimelines && this.brokerTimelines.length > 1) {
			this.toggleContainer = this.container.createDiv({ cls: 'investment-chart-toggle' });
			this.toggleContainer.style.cssText = 'margin-bottom: 8px; display: flex; gap: 8px;';

			const mergedBtn = this.toggleContainer.createEl('button', { text: 'Единый график' });
			const splitBtn = this.toggleContainer.createEl('button', { text: 'По брокерам' });

			mergedBtn.style.cssText = 'font-size: 11px; padding: 2px 8px;';
			splitBtn.style.cssText = 'font-size: 11px; padding: 2px 8px;';

			mergedBtn.addEventListener('click', () => { this.isMerged = false; this.render(); });
			splitBtn.addEventListener('click', () => { this.isMerged = true; this.render(); });
		}

		if ((!this.isMerged && (!this.combinedSnapshots || this.combinedSnapshots.length === 0)) ||
			(this.isMerged && (!this.brokerTimelines || this.brokerTimelines.length === 0))) {
			this.renderEmptyState();
			return;
		}

		if (!this.container.style.height || this.container.clientHeight === 0) {
			this.container.style.height = '360px';
		}
		this.container.style.position = this.container.style.position || 'relative';

		this.canvasEl = document.createElement('canvas');
		this.container.appendChild(this.canvasEl);

		const context = this.canvasEl.getContext('2d');
		if (!context) return;

		const textColor = resolveThemeColor('--text-normal', '#dcddde');
		const mutedTextColor = resolveThemeColor('--text-muted', '#999999');
		const gridColor = resolveThemeColor('--background-modifier-border', 'rgba(255, 255, 255, 0.1)');
		const tooltipBg = resolveThemeColor('--background-secondary', '#2a2a2a');

		let datasets: ChartConfiguration<'line', number[], string>['data']['datasets'];

		if (this.isMerged && this.brokerTimelines) {
			const tbankLine = this.brokerTimelines.find(t => t.broker === 'tbank');
			const sberLine = this.brokerTimelines.find(t => t.broker === 'sber');

			const allDates = new Set<string>();
			const tbankMap = new Map<string, number>();
			const sberMap = new Map<string, number>();

			if (tbankLine) {
				for (const s of tbankLine.snapshots) { allDates.add(s.date); tbankMap.set(s.date, s.totalCapital); }
			}
			if (sberLine) {
				for (const s of sberLine.snapshots) { allDates.add(s.date); sberMap.set(s.date, s.totalCapital); }
			}

			const labels = Array.from(allDates).sort();
			const tbankData = labels.map(d => tbankMap.get(d) ?? null);
			const sberData = labels.map(d => sberMap.get(d) ?? null);

			datasets = [
				{
					label: 'Т-Банк',
					data: tbankData as number[],
					borderColor: '#F9A825',
					backgroundColor: 'rgba(249, 168, 37, 0.12)',
					borderWidth: 2,
					pointRadius: 0,
					pointHoverRadius: 4,
					fill: true,
					tension: 0.15,
					stack: 'brokerStack',  // <--- ДОБАВЛЯЕМ (одинаковый ключ для стекования)
					spanGaps: false
				},
				{
					label: 'Сбер',
					data: sberData as number[],
					borderColor: '#43A047',
					backgroundColor: 'rgba(67, 160, 71, 0.12)',
					borderWidth: 2,
					pointRadius: 0,
					pointHoverRadius: 4,
					fill: true,
					tension: 0.15,
					stack: 'brokerStack',  // <--- ДОБАВЛЯЕМ (одинаковый ключ для стекования)
					spanGaps: false
				}
			];

			const config: ChartConfiguration<'line', number[], string> = {
				type: 'line',
				data: { labels, datasets },
				options: this.buildChartOptions(textColor, mutedTextColor, gridColor, tooltipBg)
			};
			this.chartInstance = new Chart(context, config);
		} else {
			const snapshots = this.combinedSnapshots;
			const labels = snapshots.map(s => s.date);
			const capitalData = snapshots.map(s => s.totalCapital);
			const investedData = snapshots.map(s => s.totalInvested);

			datasets = [
				{
					label: 'Общая стоимость портфеля',
					data: capitalData,
					borderColor: '#26a69a',
					backgroundColor: 'rgba(38, 166, 154, 0.12)',
					borderWidth: 2,
					pointRadius: 0,
					pointHoverRadius: 4,
					fill: true,
					tension: 0.15
				},
				{
					label: 'Сумма внесённых средств',
					data: investedData,
					borderColor: mutedTextColor,
					backgroundColor: 'transparent',
					borderWidth: 2,
					borderDash: [6, 4],
					pointRadius: 0,
					pointHoverRadius: 4,
					fill: false,
					tension: 0.15
				}
			];

			const config: ChartConfiguration<'line', number[], string> = {
				type: 'line',
				data: { labels, datasets },
				options: this.buildChartOptions(textColor, mutedTextColor, gridColor, tooltipBg)
			};
			this.chartInstance = new Chart(context, config);
		}
	}

	private buildChartOptions(
		textColor: string,
		mutedTextColor: string,
		gridColor: string,
		tooltipBg: string
	): ChartConfiguration<'line', number[], string>['options'] {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: {
				mode: 'index',
				intersect: false
			},
			scales: {
				x: {
					grid: { color: gridColor },
					ticks: {
						color: mutedTextColor,
						maxTicksLimit: 10,
						callback: (_value, index) => {
							const labels = this.chartInstance?.data?.labels;
							if (!labels || index >= labels.length) return '';
							return formatDateLabel(labels[index] as string);
						}
					}
				},
				y: {
					grid: { color: gridColor },
					stacked: true, // Включает правильное стековое отображение (наложение "плюсом")
					ticks: {
						color: mutedTextColor,
						callback: (value) => formatCurrency(Number(value))
					}
				}
			},
			plugins: {
				legend: {
					position: 'top',
					labels: {
						color: textColor,
						usePointStyle: true,
						boxWidth: 8,
						boxHeight: 8
					}
				},
				tooltip: {
					backgroundColor: tooltipBg,
					titleColor: textColor,
					bodyColor: textColor,
					borderColor: gridColor,
					borderWidth: 1,
					padding: 10,
					cornerRadius: 6,
					// Располагаем тултип наверху, чтобы не закрывать график.
					position: 'nearest',
					yAlign: 'top',
					xAlign: 'center',
					callbacks: {
						title: (items: TooltipItem<'line'>[]) => {
							const rawLabel = items[0]?.label;
							return rawLabel ? formatDateLabel(rawLabel) : '';
						},
						label: (item: TooltipItem<'line'>) => {
							const value = typeof item.parsed.y === 'number' ? item.parsed.y : 0;
							return `${item.dataset.label}: ${formatCurrency(value)}`;
						}
					}
				}
			}
		};
	}

	public destroy(): void {
		if (this.chartInstance) {
			this.chartInstance.destroy();
			this.chartInstance = null;
		}
	}

	public refreshTheme(): void {
		this.render();
	}

	private clearContainer(): void {
		while (this.container.firstChild) {
			this.container.removeChild(this.container.firstChild);
		}
	}

	private renderEmptyState(): void {
		const placeholder = document.createElement('div');
		placeholder.textContent = 'Недостаточно данных для построения графика.';
		placeholder.style.cssText = `color: ${resolveThemeColor('--text-muted', '#999999')}; padding: 24px; text-align: center;`;
		this.container.appendChild(placeholder);
	}
}