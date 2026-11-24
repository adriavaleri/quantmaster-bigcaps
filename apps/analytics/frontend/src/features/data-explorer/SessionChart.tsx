// lightweight-charts v5 API
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, RotateCcw, Search, Settings, Star, Trash2 } from 'lucide-react';
import {
    createChart,
    ColorType,
    CrosshairMode,
    LineStyle,
    CandlestickSeries,
    HistogramSeries,
    LineSeries,
    type IChartApi,
    type IChartApiBase,
    type IPrimitivePaneRenderer,
    type IPrimitivePaneView,
    type IPriceLine,
    type ISeriesPrimitive,
    type ISeriesApi,
    type MouseEventParams,
    type CandlestickData,
    type HistogramData,
    type LineWidth,
    type Time,
    type SeriesAttachedParameter,
    type SeriesType,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { Popover, PopoverContent, PopoverTrigger } from '../../shared/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '../../shared/components/ui/dialog';
import { INDICATOR_DEFINITIONS } from './indicatorDefinitions';

export interface BarCandle {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    volumeDelta?: number;
    vwap?: number;
    transactions?: number;
    askVolume?: number;
    bidVolume?: number;
    neutralVolume?: number;
    unresolvedVolume?: number;
    cumulativeSessionDelta?: number;
    synthetic?: boolean;
}

export interface SessionChartExecution {
    id: string;
    timestampMs: number;
    side: 'buy' | 'sell';
    quantity: number;
    price: number;
}

export type SessionChartPendingOrderType = 'limit' | 'stop' | 'stop-limit';
export type SessionChartPendingOrderStatus = 'working' | 'partially_filled' | 'held';

export interface SessionChartPendingOrder {
    id: string;
    type: SessionChartPendingOrderType;
    status: SessionChartPendingOrderStatus;
    side: 'buy' | 'sell';
    quantity: number;
    remainingQuantity: number;
    limitPrice?: number | null;
    stopPrice?: number | null;
    bracketCapacity?: number | null;
    triggered?: boolean;
}

interface SessionChartProps {
    candles: BarCandle[];
    replayBar?: BarCandle | null;
    replayAutoScroll?: boolean;
    replayLocked?: boolean;
    replayRightOffset?: number;
    ticker: string;
    date: string;
    timeframe: '30s' | '15s' | '10s' | '5s' | '3s' | '1s' | '1m' | '2m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '4h' | '1D';
    initialVisibleBars?: number;
    availableTimeframes?: ChartTimeframe[];
    availableVolumeModes?: VolumeMode[];
    volumeMode: VolumeMode;
    defaultCoreIndicators?: {
        volume?: boolean;
        vwap?: boolean;
    };
    defaultSelectedIndicators?: string[];
    defaultIndicatorLineVisibility?: Record<string, boolean>;
    executions?: SessionChartExecution[];
    pendingOrders?: SessionChartPendingOrder[];
    currentPrice?: number | null;
    tickSize?: number;
    onCancelOrder?: (orderId: string) => void;
    onModifyOrder?: (orderId: string, price: number, reference: 'limit' | 'stop') => void;
    onExecuteOrderAsMarket?: (orderId: string) => void;
    onTimeframeChange?: (timeframe: ChartTimeframe) => void;
    onVolumeModeChange?: (mode: VolumeMode) => void;
}

type ChartTimeframe = SessionChartProps['timeframe'];
export type VolumeMode = 'volume' | 'delta' | 'dollar';
type IndicatorKey = 'volume' | 'vwap';

const CHART_DISPLAY_PRICE_FORMAT = {
    type: 'price' as const,
    precision: 2,
    // The chart is display-only. Order dragging snaps independently to the
    // runtime tick size, so a feed with fine decimals must not make the chart
    // price scale rebuild around an ultra-fine minMove.
    minMove: 0.01,
};
type IndicatorSettingsTab = 'inputs' | 'style';

interface IndicatorStyleSettings {
    color: string;
    lineWidth: LineWidth;
}

interface IndicatorParameterSettings {
    period: number;
    factor?: number;
}

interface IndicatorDefaults {
    volume?: {
        volumeMode: VolumeMode;
        volumeUpColor: string;
        volumeDownColor: string;
        visible: boolean;
    };
    vwap?: {
        vwapColor: string;
        vwapLineWidth: LineWidth;
        visible: boolean;
    };
    indicatorStyles?: Record<string, IndicatorStyleSettings>;
    indicatorParameters?: Record<string, IndicatorParameterSettings>;
}

interface SessionBand {
    startTime: number;
    endTime: number;
    fallbackStartTime: number;
    fallbackEndTime: number;
    label: 'PM' | 'RTH' | 'AH';
    color: string;
}

interface SessionBandRect {
    leftPx: number;
    widthPx: number;
    label: 'PM' | 'RTH' | 'AH';
    color: string;
}

type DrawingTool = 'line' | 'horizontal';

interface DrawingPoint {
    time: Time;
    price: number;
}

interface NormalLineDrawing {
    start: DrawingPoint;
    end: DrawingPoint;
}

type NormalLineHitTarget = 'line' | 'start' | 'end';

interface NormalLineHit {
    index: number;
    target: NormalLineHitTarget;
}

interface HorizontalLineDrawing {
    line: IPriceLine;
    price: number;
}

type SelectedDrawing =
    | { kind: 'horizontal'; index: number }
    | { kind: 'line'; index: number }
    | null;

type DrawingHit =
    | { kind: 'horizontal'; index: number; target: 'line' }
    | { kind: 'line'; index: number; target: NormalLineHitTarget };

function NormalLineToolIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
            <path d="M5 19 19 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="5" cy="19" r="2" fill="#0D1117" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="19" cy="5" r="2" fill="#0D1117" stroke="currentColor" strokeWidth="1.3" />
        </svg>
    );
}

function HorizontalLineToolIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
            <path d="M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="12" cy="12" r="2.5" fill="#0D1117" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="4" cy="12" r="1.2" fill="currentColor" />
            <circle cx="20" cy="12" r="1.2" fill="currentColor" />
        </svg>
    );
}

function distanceToSegment(pointX: number, pointY: number, startX: number, startY: number, endX: number, endY: number): number {
    const dx = endX - startX;
    const dy = endY - startY;
    if (dx === 0 && dy === 0) return Math.hypot(pointX - startX, pointY - startY);
    const projection = Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / (dx * dx + dy * dy)));
    const closestX = startX + projection * dx;
    const closestY = startY + projection * dy;
    return Math.hypot(pointX - closestX, pointY - closestY);
}

function sameDrawingPoint(first: DrawingPoint | null, second: DrawingPoint | null): boolean {
    return first !== null && second !== null && first.time === second.time && first.price === second.price;
}

class NormalLineRenderer implements IPrimitivePaneRenderer {
    constructor(private readonly primitive: NormalLinePrimitive) {}

    draw(target: CanvasRenderingTarget2D): void {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            const chart = this.primitive.chart;
            const series = this.primitive.series;
            if (!chart || !series) return;

            const timeScale = chart.timeScale();
            context.save();
            context.lineCap = 'round';

            const drawLine = (drawing: NormalLineDrawing, selected: boolean, preview: boolean) => {
                const startX = timeScale.timeToCoordinate(drawing.start.time);
                const endX = timeScale.timeToCoordinate(drawing.end.time);
                const startY = series.priceToCoordinate(drawing.start.price);
                const endY = series.priceToCoordinate(drawing.end.price);
                if (startX === null || endX === null || startY === null || endY === null) return;

                context.strokeStyle = preview ? '#6AAEFF' : selected ? '#F4F7FF' : '#2196F3';
                context.fillStyle = '#2196F3';
                context.lineWidth = 1;
                context.setLineDash([]);
                context.beginPath();
                context.moveTo(startX, startY);
                context.lineTo(endX, endY);
                context.stroke();

                if (selected || preview) {
                    for (const [x, y] of [[startX, startY], [endX, endY]]) {
                        if (x < -8 || x > mediaSize.width + 8 || y < -8 || y > mediaSize.height + 8) continue;
                        context.beginPath();
                        context.arc(x, y, preview ? 4 : 5, 0, Math.PI * 2);
                        context.fill();
                    }
                }
            };

            for (const [index, drawing] of this.primitive.drawings.entries()) {
                drawLine(drawing, this.primitive.selectedIndex === index, false);
            }
            if (this.primitive.preview) drawLine(this.primitive.preview, false, true);
            context.restore();
        });
    }
}

class NormalLinePaneView implements IPrimitivePaneView {
    constructor(private readonly rendererInstance: NormalLineRenderer) {}

    zOrder(): 'top' {
        return 'top';
    }

    renderer(): IPrimitivePaneRenderer {
        return this.rendererInstance;
    }
}

class NormalLinePrimitive implements ISeriesPrimitive<Time> {
    public chart: IChartApiBase<Time> | null = null;
    public series: ISeriesApi<SeriesType, Time> | null = null;
    public drawings: NormalLineDrawing[] = [];
    public preview: NormalLineDrawing | null = null;
    public selectedIndex: number | null = null;
    private requestUpdate: (() => void) | null = null;
    private scheduledFrame: number | null = null;
    private readonly rendererInstance = new NormalLineRenderer(this);
    private readonly paneView = new NormalLinePaneView(this.rendererInstance);

    private scheduleUpdate(): void {
        if (this.scheduledFrame !== null) return;
        if (typeof window === 'undefined') {
            this.requestUpdate?.();
            return;
        }
        this.scheduledFrame = window.requestAnimationFrame(() => {
            this.scheduledFrame = null;
            this.requestUpdate?.();
        });
    }

    attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, SeriesType>): void {
        this.chart = chart;
        this.series = series;
        this.requestUpdate = requestUpdate;
    }

    detached(): void {
        if (this.scheduledFrame !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(this.scheduledFrame);
        }
        this.scheduledFrame = null;
        this.chart = null;
        this.series = null;
        this.requestUpdate = null;
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return [this.paneView];
    }

    addDrawing(drawing: NormalLineDrawing): void {
        this.preview = null;
        this.drawings = [...this.drawings, drawing];
        this.scheduleUpdate();
    }

    setPreview(preview: NormalLineDrawing | null): void {
        if (preview && this.preview && sameDrawingPoint(preview.start, this.preview.start) && sameDrawingPoint(preview.end, this.preview.end)) return;
        this.preview = preview;
        this.scheduleUpdate();
    }

    setSelectedIndex(index: number | null): void {
        if (this.selectedIndex === index) return;
        this.selectedIndex = index;
        this.scheduleUpdate();
    }

    getHitAt(x: number, y: number): NormalLineHit | null {
        if (!this.chart || !this.series) return null;
        const timeScale = this.chart.timeScale();
        let closest: { hit: NormalLineHit; distance: number } | null = null;

        for (let index = this.drawings.length - 1; index >= 0; index -= 1) {
            const drawing = this.drawings[index];
            const startX = timeScale.timeToCoordinate(drawing.start.time);
            const endX = timeScale.timeToCoordinate(drawing.end.time);
            const startY = this.series.priceToCoordinate(drawing.start.price);
            const endY = this.series.priceToCoordinate(drawing.end.price);
            if (startX === null || endX === null || startY === null || endY === null) continue;

            const startDistance = Math.hypot(x - startX, y - startY);
            const endDistance = Math.hypot(x - endX, y - endY);
            if (startDistance <= 11 && (!closest || startDistance < closest.distance)) {
                closest = { hit: { index, target: 'start' }, distance: startDistance };
                continue;
            }
            if (endDistance <= 11 && (!closest || endDistance < closest.distance)) {
                closest = { hit: { index, target: 'end' }, distance: endDistance };
                continue;
            }

            const lineDistance = distanceToSegment(x, y, startX, startY, endX, endY);
            if (lineDistance <= 8 && (!closest || lineDistance < closest.distance)) {
                closest = { hit: { index, target: 'line' }, distance: lineDistance };
            }
        }

        return closest?.hit ?? null;
    }

    updateDrawing(index: number, next: Partial<NormalLineDrawing>): void {
        const drawing = this.drawings[index];
        if (!drawing) return;
        this.drawings[index] = { ...drawing, ...next };
        this.scheduleUpdate();
    }

    removeDrawing(index: number): void {
        if (!this.drawings[index]) return;
        this.drawings.splice(index, 1);
        if (this.selectedIndex !== null) {
            this.selectedIndex = this.selectedIndex === index
                ? null
                : this.selectedIndex > index ? this.selectedIndex - 1 : this.selectedIndex;
        }
        this.scheduleUpdate();
    }

    clear(): void {
        this.drawings = [];
        this.preview = null;
        this.selectedIndex = null;
        this.scheduleUpdate();
    }
}

type PendingOrderReference = 'limit' | 'stop';
type PendingOrderOverlayHit = {
    orderId: string;
    reference: PendingOrderReference;
    price: number;
    action: 'close' | 'drag';
};
// Keep the order tag flush with the price-scale edge. The actual price is
// rendered by lightweight-charts as the axis label, so the pane overlay only
// needs to show the compact order tag and its close control.
const PENDING_ORDER_AXIS_RESERVE = 0;

class PendingOrderOverlayPrimitive implements ISeriesPrimitive<Time> {
    public chart: IChartApiBase<Time> | null = null;
    public series: ISeriesApi<SeriesType, Time> | null = null;
    private orders: SessionChartPendingOrder[] = [];
    private previewPrices = new Map<string, number>();
    private requestUpdate: (() => void) | null = null;
    private readonly rendererInstance = {
        draw: (target: CanvasRenderingTarget2D) => {
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                if (!this.series) return;
                const references = this.references();
                context.save();
                context.font = '700 10px Arial, sans-serif';
                context.textBaseline = 'middle';

                for (const reference of references) {
                    const price = this.previewPrices.get(this.previewKey(reference.order.id, reference.reference)) ?? reference.price;
                    const y = this.series.priceToCoordinate(price);
                    if (y === null || y < -20 || y > mediaSize.height + 20) continue;

                    const label = this.label(reference.order, reference.order.type === 'stop-limit' ? 'SL' : reference.reference === 'stop' ? 'S' : 'L');
                    const labelWidth = this.labelWidth(label);
                    const labelX = Math.max(4, mediaSize.width - labelWidth - PENDING_ORDER_AXIS_RESERVE);
                    const labelY = Math.round(y - 9);
                    const color = reference.order.status === 'held'
                        ? '#F5B642'
                        : reference.order.side === 'buy' ? '#2BD790' : '#F18492';

                    context.save();
                    context.globalAlpha = reference.order.status === 'held' ? 0.82 : 0.96;
                    context.strokeStyle = color;
                    context.lineWidth = 1;
                    context.setLineDash(reference.order.status === 'held' ? [2, 3] : [5, 4]);
                    context.beginPath();
                    context.moveTo(0, y);
                    context.lineTo(labelX - 4, y);
                    context.stroke();
                    context.setLineDash([]);

                    context.fillStyle = reference.order.status === 'held'
                        ? 'rgba(245, 182, 66, 0.88)'
                        : reference.order.side === 'buy' ? 'rgba(43, 215, 144, 0.88)' : 'rgba(241, 132, 146, 0.88)';
                    context.fillRect(labelX, labelY, labelWidth, 18);
                    context.strokeStyle = color;
                    context.strokeRect(labelX + 0.5, labelY + 0.5, labelWidth - 1, 17);
                    context.fillStyle = '#071018';
                    context.fillText(label, labelX + 5, y);
                    context.strokeStyle = '#071018';
                    context.lineWidth = 1.2;
                    context.beginPath();
                    context.moveTo(labelX + labelWidth - 12, y - 3);
                    context.lineTo(labelX + labelWidth - 6, y + 3);
                    context.moveTo(labelX + labelWidth - 6, y - 3);
                    context.lineTo(labelX + labelWidth - 12, y + 3);
                    context.stroke();
                    context.restore();
                }
                context.restore();
            });
        },
    } satisfies IPrimitivePaneRenderer;
    private readonly paneView = {
        zOrder: () => 'top' as const,
        renderer: () => this.rendererInstance,
    } satisfies IPrimitivePaneView;

    attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, SeriesType>): void {
        this.chart = chart;
        this.series = series;
        this.requestUpdate = requestUpdate;
        this.requestUpdate();
    }

    detached(): void {
        this.chart = null;
        this.series = null;
        this.requestUpdate = null;
        this.previewPrices.clear();
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return [this.paneView];
    }

    setOrders(orders: SessionChartPendingOrder[]): void {
        this.orders = orders.filter((order) => (
            order.status === 'working' || order.status === 'partially_filled' || order.status === 'held'
        ));
        const activeKeys = new Set(this.references().map((reference) => this.previewKey(reference.order.id, reference.reference)));
        for (const key of this.previewPrices.keys()) {
            if (!activeKeys.has(key)) this.previewPrices.delete(key);
        }
        this.requestUpdate?.();
    }

    setPreview(orderId: string, reference: PendingOrderReference, price: number | null): void {
        const key = this.previewKey(orderId, reference);
        if (price === null) this.previewPrices.delete(key);
        else this.previewPrices.set(key, price);
        this.requestUpdate?.();
    }

    getHitAt(x: number, y: number): PendingOrderOverlayHit | null {
        if (!this.chart || !this.series) return null;
        const width = this.chart.paneSize(0).width;
        let closest: { hit: PendingOrderOverlayHit; distance: number } | null = null;
        for (const reference of this.references().reverse()) {
            const price = this.previewPrices.get(this.previewKey(reference.order.id, reference.reference)) ?? reference.price;
            const lineY = this.series.priceToCoordinate(price);
            if (lineY === null) continue;
            const distance = Math.abs(y - lineY);
            if (distance > 10) continue;
            const label = this.label(reference.order, reference.order.type === 'stop-limit' ? 'SL' : reference.reference === 'stop' ? 'S' : 'L');
            const labelWidth = this.labelWidth(label);
            const labelX = Math.max(4, width - labelWidth - PENDING_ORDER_AXIS_RESERVE);
            const inLabel = x >= labelX && x <= labelX + labelWidth;
            const isClose = inLabel && x >= labelX + labelWidth - 20;
            const hit: PendingOrderOverlayHit = {
                orderId: reference.order.id,
                reference: reference.reference,
                price,
                action: isClose ? 'close' : 'drag',
            };
            if (!closest || distance < closest.distance) closest = { hit, distance };
        }
        return closest?.hit ?? null;
    }

    private references(): Array<{ order: SessionChartPendingOrder; reference: PendingOrderReference; price: number }> {
        const result: Array<{ order: SessionChartPendingOrder; reference: PendingOrderReference; price: number }> = [];
        for (const order of this.orders) {
            if (order.type === 'limit' && order.limitPrice != null) result.push({ order, reference: 'limit', price: order.limitPrice });
            if (order.type === 'stop' && order.stopPrice != null) result.push({ order, reference: 'stop', price: order.stopPrice });
            if (order.type === 'stop-limit') {
                const sharedPrice = order.stopPrice ?? order.limitPrice;
                if (sharedPrice != null) result.push({ order, reference: 'stop', price: sharedPrice });
            }
        }
        return result;
    }

    private label(order: SessionChartPendingOrder, code: 'L' | 'S' | 'SL'): string {
        const quantity = order.status === 'held' && order.bracketCapacity != null
            ? order.bracketCapacity
            : order.remainingQuantity;
        return `${order.status === 'held' ? 'H ' : ''}${code} ${Math.round(quantity).toLocaleString()}`;
    }

    private labelWidth(label: string): number {
        return Math.max(42, Math.ceil(label.length * 6.2) + 18);
    }

    private previewKey(orderId: string, reference: PendingOrderReference): string {
        return `${orderId}:${reference}`;
    }
}

type TradePriceMarker = {
    time: Time;
    price: number;
    direction: 'up' | 'down';
    color: string;
};

/** Same marker primitive used by the normal backtester trade chart. */
class TradePriceMarkersPrimitive implements ISeriesPrimitive<Time> {
    private chart: IChartApi | null = null;
    private requestUpdate: (() => void) | null = null;
    private markers: TradePriceMarker[] = [];
    private readonly view = { zOrder: () => 'top' as const, renderer: () => this };

    constructor(private readonly series: ISeriesApi<'Candlestick'>) {}

    attached({ chart, requestUpdate }: { chart: IChartApi; requestUpdate: () => void }): void {
        this.chart = chart;
        this.requestUpdate = requestUpdate;
    }

    detached(): void {
        this.chart = null;
        this.requestUpdate = null;
    }

    setMarkers(markers: TradePriceMarker[]): void {
        this.markers = markers;
        this.requestUpdate?.();
    }

    updateAllViews(): void {
        this.requestUpdate?.();
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return [this.view];
    }

    draw(target: CanvasRenderingTarget2D): void {
        const chart = this.chart;
        if (!chart || this.markers.length === 0) return;
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            context.save();
            for (const marker of this.markers) {
                const x = chart.timeScale().timeToCoordinate(marker.time);
                const y = this.series.priceToCoordinate(marker.price);
                if (x === null || y === null || x < -20 || x > mediaSize.width + 20 || y < -20 || y > mediaSize.height + 20) continue;

                const isUp = marker.direction === 'up';
                context.fillStyle = marker.color;
                context.strokeStyle = '#02070D';
                context.lineWidth = 1.5;
                context.beginPath();
                if (isUp) {
                    context.moveTo(x, y);
                    context.lineTo(x - 7, y + 10);
                    context.lineTo(x + 7, y + 10);
                } else {
                    context.moveTo(x, y);
                    context.lineTo(x - 7, y - 10);
                    context.lineTo(x + 7, y - 10);
                }
                context.closePath();
                context.fill();
                context.stroke();
            }
            context.restore();
        });
    }
}

const NY_TZ = 'America/New_York';
const NY_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});
const NY_SECONDS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});
const NY_CLOCK_SECONDS_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    second: '2-digit',
    hour12: false,
});
const NY_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});
const CHART_STYLE_STORAGE_KEY = 'quantmaster.analytics.chartStyle.v3';
const CHART_TIMEFRAME_FAVORITES_STORAGE_KEY = 'quantmaster.analytics.chartTimeframeFavorites.v1';
const INDICATOR_DEFAULTS_STORAGE_KEY = 'quantmaster.analytics.indicatorDefaults.v1';
const CHART_CONFIGURATION_STORAGE_KEY = 'quantmaster.analytics.chartConfiguration.v1';
const CHART_INDICATOR_FAVORITES_STORAGE_KEY = 'quantmaster.analytics.indicatorFavorites.v1';
const CHART_TIMEFRAMES: ChartTimeframe[] = ['1s', '3s', '5s', '10s', '15s', '30s', '1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1D'];
const DEFAULT_TIMEFRAME_FAVORITES: ChartTimeframe[] = ['1m', '5m', '30m'];

interface ChartStyleSettings {
    backgroundColor: string;
    gridColor: string;
    gridOpacity: number;
    pmBackgroundColor: string;
    pmBackgroundOpacity: number;
    ahBackgroundColor: string;
    ahBackgroundOpacity: number;
    upColor: string;
    downColor: string;
    wickUpColor: string;
    wickDownColor: string;
    borderUpColor: string;
    borderDownColor: string;
    volumeUpColor: string;
    volumeDownColor: string;
    vwapColor: string;
    vwapLineWidth: LineWidth;
    indicatorStyles: Record<string, IndicatorStyleSettings>;
    barSpacing: number;
    priceLineWidth: LineWidth;
    wickVisible: boolean;
    borderVisible: boolean;
}

interface SavedChartConfiguration {
    styleSettings: ChartStyleSettings;
    volumeMode: VolumeMode;
    indicatorVisibility: {
        volume: boolean;
        vwap: boolean;
    };
    indicatorPresence: {
        volume: boolean;
        vwap: boolean;
    };
    selectedIndicators: string[];
    indicatorParameters: Record<string, IndicatorParameterSettings>;
    indicatorLineVisibility: Record<string, boolean>;
}

type StrategyIndicatorId = keyof typeof INDICATOR_DEFINITIONS;
type ChartIndicatorId = string;
interface ChartIndicatorCatalogItem {
    id: ChartIndicatorId;
    label: string;
    valueType: string;
}

const CHART_INDICATOR_CATALOG: ChartIndicatorCatalogItem[] = [
    { id: 'volume', label: 'Volume', valueType: 'volume' },
    { id: 'volume_delta', label: 'Volume delta', valueType: 'volume' },
    { id: 'dollar_volume', label: '$ Volume', valueType: 'volume' },
    ...([
        'session_vwap',
        'ema',
        'sma',
        'ssma',
        'atr',
        'supertrend',
        'fractal_high',
        'fractal_low',
        'donchian_upper',
        'donchian_lower',
        'donchian_basis',
        'bb_upper',
        'bb_lower',
        'bb_basis',
    ] as StrategyIndicatorId[]).map((id) => ({
        id,
        label: INDICATOR_DEFINITIONS[id].label,
        valueType: INDICATOR_DEFINITIONS[id].valueType,
    })),
];
const CHART_OVERLAY_INDICATOR_IDS = CHART_INDICATOR_CATALOG
    .filter((indicator) => !isVolumeIndicatorId(indicator.id) && indicator.id !== 'session_vwap')
    .map((indicator) => indicator.id);
const DEFAULT_CHART_INDICATORS: string[] = ['ema::20', 'ema::30', 'ema::50'];
const DEFAULT_CHART_INDICATOR_PARAMETERS: Record<string, IndicatorParameterSettings> = {
    'ema::20': { period: 20 },
    'ema::30': { period: 30 },
    'ema::50': { period: 50 },
};
const INDICATOR_LINE_COLORS = ['#166534', '#F23645', '#DC2626', '#16A34A', '#AB47BC', '#4CAF50', '#B91C1C', '#86EFAC'];

function baseIndicatorId(instanceId: string): string {
    return instanceId.split('::')[0];
}

function chartIndicatorDefinition(instanceId: string): ChartIndicatorCatalogItem | undefined {
    return CHART_INDICATOR_CATALOG.find((indicator) => indicator.id === baseIndicatorId(instanceId));
}

function isKnownChartIndicatorInstance(instanceId: string): boolean {
    return CHART_INDICATOR_CATALOG.some((indicator) => indicator.id === baseIndicatorId(instanceId));
}

function normalizeSelectedIndicatorInstances(value: unknown): string[] {
    if (!Array.isArray(value)) return DEFAULT_CHART_INDICATORS;

    return value.flatMap((rawId) => {
        if (typeof rawId !== 'string') return [];
        if (rawId === 'ema_20') return ['ema::20'];
        if (rawId === 'ema_30') return ['ema::30'];
        if (rawId === 'ema_50') return ['ema::50'];
        return isKnownChartIndicatorInstance(rawId) && !isCoreChartIndicatorId(rawId) ? [rawId] : [];
    });
}

function nextIndicatorInstanceId(indicatorId: string, selectedIndicators: string[]): string {
    if (!selectedIndicators.some((id) => baseIndicatorId(id) === indicatorId)) return indicatorId;

    let suffix = 2;
    while (selectedIndicators.includes(`${indicatorId}::${suffix}`)) suffix += 1;
    return `${indicatorId}::${suffix}`;
}

function indicatorDisplayLabel(instanceId: string, parameters: Record<string, IndicatorParameterSettings>): string {
    const definition = chartIndicatorDefinition(instanceId);
    if (!definition) return instanceId;
    const baseId = baseIndicatorId(instanceId);
    if (baseId === 'ema' || baseId === 'sma' || baseId === 'ssma' || baseId === 'atr') {
        return `${definition.label} ${getIndicatorParameters(instanceId, parameters).period}`;
    }
    return definition.label;
}

function defaultIndicatorStyle(id: string): IndicatorStyleSettings {
    const index = Math.max(0, CHART_OVERLAY_INDICATOR_IDS.indexOf(id));
    return {
        color: INDICATOR_LINE_COLORS[index % INDICATOR_LINE_COLORS.length],
        lineWidth: 2,
    };
}

function getIndicatorStyle(id: string, settings: ChartStyleSettings): IndicatorStyleSettings {
    return normalizeIndicatorStyle(settings.indicatorStyles[id], defaultIndicatorStyle(id));
}

const DEFAULT_CHART_STYLE_SETTINGS: ChartStyleSettings = {
    backgroundColor: '#000000',
    gridColor: '#2A2E39',
    gridOpacity: 62,
    pmBackgroundColor: '#166534',
    pmBackgroundOpacity: 10,
    ahBackgroundColor: '#8B93A6',
    ahBackgroundOpacity: 10,
    upColor: '#089981',
    downColor: '#F23645',
    wickUpColor: '#089981',
    wickDownColor: '#F23645',
    borderUpColor: '#089981',
    borderDownColor: '#F23645',
    volumeUpColor: '#4CAF50',
    volumeDownColor: '#F23645',
    vwapColor: '#FFFFFF',
    vwapLineWidth: 1,
    indicatorStyles: {
        'ema::20': { color: '#16A34A', lineWidth: 1 },
        'ema::30': { color: '#FFEB3B', lineWidth: 1 },
        'ema::50': { color: '#166534', lineWidth: 1 },
    },
    barSpacing: 7,
    priceLineWidth: 1,
    wickVisible: true,
    borderVisible: false,
};

function loadChartStyleSettings(): ChartStyleSettings {
    if (typeof window === 'undefined') return DEFAULT_CHART_STYLE_SETTINGS;

    try {
        const stored = window.localStorage.getItem(CHART_STYLE_STORAGE_KEY);
        if (!stored) return DEFAULT_CHART_STYLE_SETTINGS;
        return normalizeChartStyleSettings(JSON.parse(stored));
    } catch {
        return DEFAULT_CHART_STYLE_SETTINGS;
    }
}

function normalizeChartStyleSettings(value: unknown): ChartStyleSettings {
    const candidate = value && typeof value === 'object' ? value as Partial<ChartStyleSettings> : {};

    return {
        backgroundColor: parseHexColor(candidate.backgroundColor, DEFAULT_CHART_STYLE_SETTINGS.backgroundColor),
        gridColor: parseHexColor(candidate.gridColor, DEFAULT_CHART_STYLE_SETTINGS.gridColor),
        gridOpacity: clampInteger(candidate.gridOpacity, 0, 100, DEFAULT_CHART_STYLE_SETTINGS.gridOpacity),
        pmBackgroundColor: parseHexColor(candidate.pmBackgroundColor, DEFAULT_CHART_STYLE_SETTINGS.pmBackgroundColor),
        pmBackgroundOpacity: clampInteger(candidate.pmBackgroundOpacity, 0, 100, DEFAULT_CHART_STYLE_SETTINGS.pmBackgroundOpacity),
        ahBackgroundColor: parseHexColor(candidate.ahBackgroundColor, DEFAULT_CHART_STYLE_SETTINGS.ahBackgroundColor),
        ahBackgroundOpacity: clampInteger(candidate.ahBackgroundOpacity, 0, 100, DEFAULT_CHART_STYLE_SETTINGS.ahBackgroundOpacity),
        upColor: parseHexColor(candidate.upColor, DEFAULT_CHART_STYLE_SETTINGS.upColor),
        downColor: parseHexColor(candidate.downColor, DEFAULT_CHART_STYLE_SETTINGS.downColor),
        wickUpColor: parseHexColor(candidate.wickUpColor, DEFAULT_CHART_STYLE_SETTINGS.wickUpColor),
        wickDownColor: parseHexColor(candidate.wickDownColor, DEFAULT_CHART_STYLE_SETTINGS.wickDownColor),
        borderUpColor: parseHexColor(candidate.borderUpColor, DEFAULT_CHART_STYLE_SETTINGS.borderUpColor),
        borderDownColor: parseHexColor(candidate.borderDownColor, DEFAULT_CHART_STYLE_SETTINGS.borderDownColor),
        volumeUpColor: parseHexColor(candidate.volumeUpColor, DEFAULT_CHART_STYLE_SETTINGS.volumeUpColor),
        volumeDownColor: parseHexColor(candidate.volumeDownColor, DEFAULT_CHART_STYLE_SETTINGS.volumeDownColor),
        vwapColor: parseHexColor(candidate.vwapColor, DEFAULT_CHART_STYLE_SETTINGS.vwapColor),
        vwapLineWidth: clampInteger(candidate.vwapLineWidth, 1, 4, DEFAULT_CHART_STYLE_SETTINGS.vwapLineWidth) as LineWidth,
        indicatorStyles: normalizeIndicatorStyles(candidate.indicatorStyles),
        barSpacing: clampInteger(candidate.barSpacing, 4, 24, DEFAULT_CHART_STYLE_SETTINGS.barSpacing),
        priceLineWidth: clampInteger(candidate.priceLineWidth, 1, 4, DEFAULT_CHART_STYLE_SETTINGS.priceLineWidth) as LineWidth,
        wickVisible: parseBoolean(candidate.wickVisible, DEFAULT_CHART_STYLE_SETTINGS.wickVisible),
        borderVisible: parseBoolean(candidate.borderVisible, DEFAULT_CHART_STYLE_SETTINGS.borderVisible),
    };
}

function normalizeIndicatorStyles(value: unknown): Record<string, IndicatorStyleSettings> {
    if (!value || typeof value !== 'object') return {};

    return Object.fromEntries(
        Object.entries(value).map(([id, style]) => [id, normalizeIndicatorStyle(style)]),
    );
}

function normalizeIndicatorStyle(value: unknown, fallback: IndicatorStyleSettings = { color: '#166534', lineWidth: 2 }): IndicatorStyleSettings {
    const candidate = value && typeof value === 'object' ? value as Partial<IndicatorStyleSettings> : {};
    return {
        color: parseHexColor(candidate.color, fallback.color),
        lineWidth: clampInteger(candidate.lineWidth, 1, 4, fallback.lineWidth) as LineWidth,
    };
}

function defaultIndicatorParameters(id: string): IndicatorParameterSettings {
    const baseId = baseIndicatorId(id);
    const fixedPeriod = baseId.match(/(?:ema|sma|ssma)_(\d+)$/)?.[1];
    return {
        period: fixedPeriod ? Number(fixedPeriod) : baseId === 'atr' ? 14 : 20,
        ...(['supertrend'].includes(baseId) ? { factor: 3 } : {}),
        ...(['bb_upper', 'bb_lower', 'bb_basis'].includes(baseId) ? { factor: 2 } : {}),
    };
}

function normalizeIndicatorParameters(value: unknown): Record<string, IndicatorParameterSettings> {
    if (!value || typeof value !== 'object') return {};

    return Object.fromEntries(
        Object.entries(value).map(([id, parameters]) => {
            const fallback = defaultIndicatorParameters(id);
            const candidate = parameters && typeof parameters === 'object'
                ? parameters as Partial<IndicatorParameterSettings>
                : {};
            return [id, {
                period: clampInteger(candidate.period, 1, 500, fallback.period),
                ...(['supertrend', 'bb_upper', 'bb_lower', 'bb_basis'].includes(id)
                    ? { factor: clampInteger(candidate.factor, 1, 10, fallback.factor ?? 2) }
                    : {}),
            }];
        }),
    );
}

function getIndicatorParameters(id: string, parameters: Record<string, IndicatorParameterSettings>): IndicatorParameterSettings {
    const fallback = defaultIndicatorParameters(id);
    const baseId = baseIndicatorId(id);
    const current = parameters[id];
    return {
        period: clampInteger(current?.period, 1, 500, fallback.period),
        ...(['supertrend', 'bb_upper', 'bb_lower', 'bb_basis'].includes(baseId)
            ? { factor: clampInteger(current?.factor, 1, 10, fallback.factor ?? 2) }
            : {}),
    };
}

function loadSavedChartConfiguration(): SavedChartConfiguration | null {
    if (typeof window === 'undefined') return null;

    try {
        const stored = window.localStorage.getItem(CHART_CONFIGURATION_STORAGE_KEY);
        if (!stored) return null;
        const parsed = JSON.parse(stored) as Partial<SavedChartConfiguration>;
        const visibility = parsed.indicatorVisibility;
        const presence = parsed.indicatorPresence;
        const selectedIndicators = normalizeSelectedIndicatorInstances(parsed.selectedIndicators);
        const indicatorParameters = normalizeIndicatorParameters(parsed.indicatorParameters);
        for (const instanceId of selectedIndicators) {
            if (indicatorParameters[instanceId]) continue;
            if (instanceId === 'ema::20') indicatorParameters[instanceId] = { period: 20 };
            if (instanceId === 'ema::30') indicatorParameters[instanceId] = { period: 30 };
            if (instanceId === 'ema::50') indicatorParameters[instanceId] = { period: 50 };
        }
        return {
            styleSettings: normalizeChartStyleSettings(parsed.styleSettings),
            volumeMode: parsed.volumeMode === 'delta' || parsed.volumeMode === 'dollar' ? parsed.volumeMode : 'volume',
            indicatorVisibility: {
                volume: parseBoolean(visibility?.volume, true),
                vwap: parseBoolean(visibility?.vwap, true),
            },
            indicatorPresence: {
                volume: parseBoolean(presence?.volume, true),
                vwap: parseBoolean(presence?.vwap, true),
            },
            selectedIndicators,
            indicatorParameters,
            indicatorLineVisibility: parsed.indicatorLineVisibility && typeof parsed.indicatorLineVisibility === 'object'
                ? Object.fromEntries(
                    Object.entries(parsed.indicatorLineVisibility).filter(([id, visible]) => id in INDICATOR_DEFINITIONS && typeof visible === 'boolean'),
                ) as Record<string, boolean>
                : {},
        };
    } catch {
        return null;
    }
}

function parseHexColor(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, Math.round(next)));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function loadIndicatorDefaults(): IndicatorDefaults {
    if (typeof window === 'undefined') return {};

    try {
        const stored = window.localStorage.getItem(INDICATOR_DEFAULTS_STORAGE_KEY);
        if (!stored) return {};
        const parsed = JSON.parse(stored) as Partial<IndicatorDefaults>;
        const defaults: IndicatorDefaults = {};

        if (parsed.volume && typeof parsed.volume === 'object') {
            const volume = parsed.volume as Partial<NonNullable<IndicatorDefaults['volume']>>;
            defaults.volume = {
                volumeMode: volume.volumeMode === 'delta' || volume.volumeMode === 'dollar' ? volume.volumeMode : 'volume',
                volumeUpColor: parseHexColor(volume.volumeUpColor, DEFAULT_CHART_STYLE_SETTINGS.volumeUpColor),
                volumeDownColor: parseHexColor(volume.volumeDownColor, DEFAULT_CHART_STYLE_SETTINGS.volumeDownColor),
                visible: parseBoolean(volume.visible, true),
            };
        }

        if (parsed.vwap && typeof parsed.vwap === 'object') {
            const vwap = parsed.vwap as Partial<NonNullable<IndicatorDefaults['vwap']>>;
            defaults.vwap = {
                vwapColor: parseHexColor(vwap.vwapColor, DEFAULT_CHART_STYLE_SETTINGS.vwapColor),
                vwapLineWidth: clampInteger(vwap.vwapLineWidth, 1, 4, DEFAULT_CHART_STYLE_SETTINGS.vwapLineWidth) as LineWidth,
                visible: parseBoolean(vwap.visible, true),
            };
        }

        if (parsed.indicatorStyles && typeof parsed.indicatorStyles === 'object') {
            defaults.indicatorStyles = normalizeIndicatorStyles(parsed.indicatorStyles);
        }

        if (parsed.indicatorParameters && typeof parsed.indicatorParameters === 'object') {
            defaults.indicatorParameters = normalizeIndicatorParameters(parsed.indicatorParameters);
        }

        return defaults;
    } catch {
        return {};
    }
}

function loadIndicatorFavorites(): string[] {
    if (typeof window === 'undefined') return [];

    try {
        const stored = window.localStorage.getItem(CHART_INDICATOR_FAVORITES_STORAGE_KEY);
        const parsed = stored ? JSON.parse(stored) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((id): id is string => typeof id === 'string' && CHART_INDICATOR_CATALOG.some((indicator) => indicator.id === id));
    } catch {
        return [];
    }
}

function updateChartPreservingViewport(chart: IChartApi | null, update: () => void): void {
    const visibleRange = chart?.timeScale().getVisibleLogicalRange();
    update();
    if (!chart || !visibleRange) return;

    const restoreRange = { ...visibleRange };
    chart.timeScale().setVisibleLogicalRange(restoreRange);
    if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => chart.timeScale().setVisibleLogicalRange(restoreRange));
    }
}

function loadTimeframeFavorites(): ChartTimeframe[] {
    if (typeof window === 'undefined') return DEFAULT_TIMEFRAME_FAVORITES;

    try {
        const stored = window.localStorage.getItem(CHART_TIMEFRAME_FAVORITES_STORAGE_KEY);
        if (!stored) return DEFAULT_TIMEFRAME_FAVORITES;
        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return DEFAULT_TIMEFRAME_FAVORITES;
        const favorites = parsed.filter((value): value is ChartTimeframe => CHART_TIMEFRAMES.includes(value));
        return favorites.length > 0 ? favorites : DEFAULT_TIMEFRAME_FAVORITES;
    } catch {
        return DEFAULT_TIMEFRAME_FAVORITES;
    }
}

function hexToRgba(hex: string, alpha: number): string {
    const clean = parseHexColor(hex, '#000000').slice(1);
    const red = parseInt(clean.slice(0, 2), 16);
    const green = parseInt(clean.slice(2, 4), 16);
    const blue = parseInt(clean.slice(4, 6), 16);
    return `rgba(${red},${green},${blue},${alpha})`;
}

function toUnixSec(raw: string, fallbackDate?: string): number {
    if (!raw) return 0;

    const cleaned = raw.trim().replace(/^"+|"+$/g, '');
    const timeOnly = cleaned.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (timeOnly && fallbackDate) {
        return toUnixSec(`${fallbackDate.slice(0, 10)} ${timeOnly[1]}:${timeOnly[2]}:${timeOnly[3] ?? '00'}`);
    }

    const duckdbEpoch = cleaned.match(/Timestamp(?:Us|Ms|Ns|S)?\((\d+)\)/i);
    if (duckdbEpoch) {
        const n = Number(duckdbEpoch[1]);
        if (!isNaN(n)) {
            if (/TimestampNs/i.test(cleaned)) return Math.floor(n / 1_000_000_000);
            if (/TimestampMs/i.test(cleaned)) return Math.floor(n / 1_000);
            if (/TimestampS/i.test(cleaned)) return Math.floor(n);
            return Math.floor(n / 1_000_000);
        }
    }

    const embeddedIso = cleaned.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?/);
    const base = embeddedIso ? embeddedIso[0] : cleaned;
    const nyLocal = base.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (nyLocal && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(cleaned)) {
        return nyLocalToUnixSec(
            Number(nyLocal[1]),
            Number(nyLocal[2]),
            Number(nyLocal[3]),
            Number(nyLocal[4]),
            Number(nyLocal[5]),
            Number(nyLocal[6]),
        );
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(base)) {
        const [year, month, day] = base.split('-').map((part) => Number(part));
        if ([year, month, day].every((part) => Number.isFinite(part))) {
            // Daily candles represent a market session date, not UTC midnight.
            // Anchor them at midday New York time so chart labels stay on the
            // same session date when formatted back in NY timezone.
            return nyLocalToUnixSec(year, month, day, 12, 0, 0);
        }
    }
    const iso = base.replace(' ', 'T');
    const withTz = (iso.includes('+') || iso.endsWith('Z')) ? iso : `${iso}Z`;
    const d = new Date(withTz);
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);

    const n = Number(cleaned);
    if (!isNaN(n)) return Math.floor(n / 1_000_000);
    return 0;
}

function nyLocalToUnixSec(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    const offset = getTimeZoneOffsetMs(utcGuess, NY_TZ);
    return Math.floor((utcGuess - offset) / 1000);
}

function getTimeZoneOffsetMs(utcMillis: number, timeZone: string): number {
    const formatter = timeZone === NY_TZ ? NY_OFFSET_FORMATTER : new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(new Date(utcMillis));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const zonedAsUtc = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second),
    );
    return zonedAsUtc - utcMillis;
}

function compactCandlesByTime<T extends BarCandle & { t: number }>(candles: T[]): T[] {
    const byTime = new Map<number, T>();
    for (const candle of candles) {
        if (!Number.isFinite(candle.t) || candle.t <= 0) continue;
        const existing = byTime.get(candle.t);
        if (!existing) {
            byTime.set(candle.t, { ...candle });
            continue;
        }
        byTime.set(candle.t, {
            ...candle,
            open: existing.open,
            high: Math.max(existing.high, candle.high),
            low: Math.min(existing.low, candle.low),
            close: candle.close,
            volume: Number(existing.volume || 0) + Number(candle.volume || 0),
            volumeDelta: Number(existing.volumeDelta || 0) + Number(candle.volumeDelta || 0),
        });
    }
    return Array.from(byTime.values());
}

function normalizeCandlesForChart(candles: BarCandle[], sessionDate: string): Array<BarCandle & { t: number }> {
    if (candles.length === 0) return [];

    const fallbackDate = sessionDate.slice(0, 10);
    const allTimeOnly = candles.every((candle) => isTimeOnly(candle.time));

    if (!allTimeOnly) {
        return compactCandlesByTime(candles.map((candle) => ({ ...candle, t: toUnixSec(candle.time, fallbackDate) })));
    }

    if (candles.length > 960) {
        return normalizeLegacyTimeOnlyCandles(candles, fallbackDate);
    }

    return compactCandlesByTime(candles.map((candle) => {
        const cleanTime = normalizeTimeOnly(candle.time);
        return {
            ...candle,
            time: `${fallbackDate} ${cleanTime}`,
            t: toUnixSec(`${fallbackDate} ${cleanTime}`),
        };
    })).filter((candle) => {
        const parts = getNyParts(candle.t);
        return parts.date === fallbackDate && parts.minutes >= 4 * 60 && parts.minutes < 20 * 60;
    });
}

function calculateReplayVwap(
    candle: BarCandle & { t: number },
    plotted: Iterable<BarCandle & { t: number }>,
): number {
    const sessionDate = getNyParts(candle.t).date;
    let cumulativeVolume = 0;
    let cumulativeValue = 0;

    for (const previous of plotted) {
        if (previous.synthetic || previous.t === candle.t || getNyParts(previous.t).date !== sessionDate) continue;
        const volume = Math.max(0, Number(previous.volume || 0));
        cumulativeVolume += volume;
        cumulativeValue += ((previous.high + previous.low + previous.close) / 3) * volume;
    }

    const volume = Math.max(0, Number(candle.volume || 0));
    cumulativeVolume += volume;
    cumulativeValue += ((candle.high + candle.low + candle.close) / 3) * volume;
    return cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : candle.close;
}

function isTimeOnly(raw: string): boolean {
    return /^\d{2}:\d{2}(?::\d{2})?$/.test(raw.trim().replace(/^"+|"+$/g, ''));
}

function normalizeTimeOnly(raw: string): string {
    const clean = raw.trim().replace(/^"+|"+$/g, '');
    return clean.length === 5 ? `${clean}:00` : clean.slice(0, 8);
}

function normalizeLegacyTimeOnlyCandles(candles: BarCandle[], sessionDate: string): Array<BarCandle & { t: number }> {
    const previousDate = previousCalendarDate(sessionDate);
    const byClock = new Map<string, BarCandle[]>();

    for (const candle of candles) {
        const cleanTime = normalizeTimeOnly(candle.time);
        const entries = byClock.get(cleanTime) ?? [];
        entries.push(candle);
        byClock.set(cleanTime, entries);
    }

    const normalized: Array<BarCandle & { t: number }> = [];

    for (const [cleanTime, entries] of byClock.entries()) {
        if (entries.length > 1) {
            const previous = entries[0];
            const current = entries[entries.length - 1];
            normalized.push(withDatedTime(previous, previousDate, cleanTime));
            normalized.push(withDatedTime(current, sessionDate, cleanTime));
        } else {
            const only = entries[0];
            const inferredDate = inferSingletonLegacyDate(cleanTime, only, byClock, previousDate, sessionDate);
            if (inferredDate) normalized.push(withDatedTime(only, inferredDate, cleanTime));
        }
    }

    return compactCandlesByTime(normalized).sort((a, b) => a.t - b.t);
}

function withDatedTime(candle: BarCandle, date: string, cleanTime: string): BarCandle & { t: number } {
    const datedTime = `${date} ${cleanTime}`;
    return {
        ...candle,
        time: datedTime,
        t: toUnixSec(datedTime),
    };
}

function inferSingletonLegacyDate(
    cleanTime: string,
    candle: BarCandle,
    byClock: Map<string, BarCandle[]>,
    previousDate: string,
    sessionDate: string,
): string | null {
    const clock = clockMinutesFromTime(cleanTime);
    const previousNeighbor = nearestDuplicateEntry(byClock, clock, 0, 45);
    const currentNeighbor = nearestDuplicateEntry(byClock, clock, -1, 45);
    const previousDistance = previousNeighbor ? Math.abs(candle.close - previousNeighbor.close) : Number.POSITIVE_INFINITY;
    const currentDistance = currentNeighbor ? Math.abs(candle.close - currentNeighbor.close) : Number.POSITIVE_INFINITY;

    if (!Number.isFinite(previousDistance) && !Number.isFinite(currentDistance)) return null;
    if (Math.abs(previousDistance - currentDistance) < 0.02) return null;
    return previousDistance <= currentDistance ? previousDate : sessionDate;
}

function nearestDuplicateEntry(byClock: Map<string, BarCandle[]>, clock: number, entryIndex: 0 | -1, windowMinutes: number): BarCandle | null {
    let best: { distance: number; candle: BarCandle } | null = null;
    for (const [time, entries] of byClock.entries()) {
        if (entries.length <= 1) continue;
        const distance = Math.abs(clockMinutesFromTime(time) - clock);
        if (distance > windowMinutes) continue;
        const candle = entryIndex === 0 ? entries[0] : entries[entries.length - 1];
        if (!best || distance < best.distance) best = { distance, candle };
    }
    return best?.candle ?? null;
}

function clockMinutesFromTime(time: string): number {
    const [hours, minutes] = time.split(':').map((part) => Number(part));
    return hours * 60 + minutes;
}

function previousCalendarDate(date: string): string {
    const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    if (isNaN(parsed.getTime())) return date.slice(0, 10);
    parsed.setUTCDate(parsed.getUTCDate() - 1);
    return parsed.toISOString().slice(0, 10);
}

function nextCalendarDate(date: string): string {
    const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    if (isNaN(parsed.getTime())) return date.slice(0, 10);
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed.toISOString().slice(0, 10);
}

function fillMissingCandles<T extends BarCandle & { t: number }>(
    candles: T[],
    timeframe: SessionChartProps['timeframe'],
): Array<T | (BarCandle & { t: number; synthetic: true })> {
    const expectedSec = timeframeToSeconds(timeframe);
    if (!expectedSec || candles.length < 2) return candles;

    const maxFillSec = Math.max(2 * 60 * 60, expectedSec * 3);
    const filled: Array<T | (BarCandle & { t: number; synthetic: true })> = [];

    for (const candle of candles) {
        const previous = filled[filled.length - 1];
        if (previous) {
            const gap = candle.t - previous.t;
            if (gap > expectedSec && gap <= maxFillSec && sameNySession(previous.t, candle.t)) {
                for (let t = previous.t + expectedSec; t < candle.t; t += expectedSec) {
                    filled.push({
                        time: formatNyLocalTime(t),
                        open: previous.close,
                        high: previous.close,
                        low: previous.close,
                        close: previous.close,
                        volume: 0,
                        volumeDelta: 0,
                        t,
                        synthetic: true,
                    });
                }
            }
        }
        filled.push(candle);
    }

    return filled;
}

function timeframeToSeconds(timeframe: SessionChartProps['timeframe']): number | null {
    switch (timeframe) {
        case '30s': return 30;
        case '15s': return 15;
        case '10s': return 10;
        case '5s': return 5;
        case '3s': return 3;
        case '1s': return 1;
        case '1m': return 60;
        case '2m': return 120;
        case '3m': return 180;
        case '5m': return 300;
        case '10m': return 600;
        case '15m': return 900;
        case '30m': return 1800;
        case '1h': return 3600;
        case '4h': return 14400;
        default: return null;
    }
}

function sameNySession(a: number, b: number): boolean {
    const first = getNyParts(a);
    const second = getNyParts(b);
    return first.date === second.date && classifySession(first.minutes) === classifySession(second.minutes);
}

function formatNyLocalTime(unix: number): string {
    const parts = NY_SECONDS_FORMATTER.formatToParts(new Date(unix * 1000));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}


export default function SessionChart({ candles, replayBar, replayAutoScroll = false, replayLocked = false, replayRightOffset = 12, ticker, date, timeframe, initialVisibleBars, availableTimeframes = CHART_TIMEFRAMES, availableVolumeModes, volumeMode, defaultCoreIndicators, defaultSelectedIndicators, defaultIndicatorLineVisibility, executions = [], pendingOrders = [], currentPrice, tickSize, onCancelOrder, onModifyOrder, onExecuteOrderAsMarket, onTimeframeChange, onVolumeModeChange }: SessionChartProps) {
    const supportedVolumeModes = availableVolumeModes ?? ['volume', 'delta', 'dollar'];
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const executionMarkersRef = useRef<TradePriceMarkersPrimitive | null>(null);
    const pendingOrderOverlayRef = useRef<PendingOrderOverlayPrimitive | null>(null);
    const pendingOrderPriceLabelsRef = useRef<Map<string, IPriceLine>>(new Map());
    const pendingOrderDragRef = useRef<{ orderId: string; reference: 'limit' | 'stop'; price: number; pointerId: number } | null>(null);
    const [invalidDragPrompt, setInvalidDragPrompt] = useState<{
        orderId: string;
        reference: 'limit' | 'stop';
        originalPrice: number;
        attemptedPrice: number;
        currentPrice: number;
        side: 'buy' | 'sell';
        type: SessionChartPendingOrderType;
    } | null>(null);
    const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
    const normalLinePrimitiveRef = useRef<NormalLinePrimitive | null>(null);
    const horizontalLinesRef = useRef<HorizontalLineDrawing[]>([]);
    const selectedDrawingRef = useRef<SelectedDrawing>(null);
    const pendingLineStartRef = useRef<DrawingPoint | null>(null);
    const drawingToolRef = useRef<DrawingTool | null>(null);
    const indicatorSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
    const indicatorLastTimeRef = useRef<Map<string, number>>(new Map());
    const plottedCandlesRef = useRef<Map<number, BarCandle & { t: number }>>(new Map());
    const hoveredTimeRef = useRef<number | null>(null);
    const [hoveredCandle, setHoveredCandle] = useState<(BarCandle & { t: number }) | null>(null);
    const coreIndicatorDefaults = {
        volume: defaultCoreIndicators?.volume ?? true,
        vwap: defaultCoreIndicators?.vwap ?? true,
    };
    const [indicatorVisibility, setIndicatorVisibility] = useState(() => defaultCoreIndicators
        ? coreIndicatorDefaults
        : loadSavedChartConfiguration()?.indicatorVisibility ?? coreIndicatorDefaults);
    const [indicatorPresence, setIndicatorPresence] = useState(() => defaultCoreIndicators
        ? coreIndicatorDefaults
        : loadSavedChartConfiguration()?.indicatorPresence ?? coreIndicatorDefaults);
    const [openIndicator, setOpenIndicator] = useState<string | null>(null);
    const [indicatorDefaults, setIndicatorDefaults] = useState<IndicatorDefaults>(() => loadIndicatorDefaults());
    const [styleSettings, setStyleSettings] = useState<ChartStyleSettings>(() => loadChartStyleSettings());
    const [savedChartConfiguration, setSavedChartConfiguration] = useState<SavedChartConfiguration | null>(() => loadSavedChartConfiguration());
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [indicatorsOpen, setIndicatorsOpen] = useState(false);
    const [indicatorsCollapsed, setIndicatorsCollapsed] = useState(true);
    const [drawingTool, setDrawingTool] = useState<DrawingTool | null>(null);
    const [selectedIndicators, setSelectedIndicators] = useState<string[]>(() => defaultSelectedIndicators
        ?? loadSavedChartConfiguration()?.selectedIndicators
        ?? DEFAULT_CHART_INDICATORS);
    const [indicatorLineVisibility, setIndicatorLineVisibility] = useState<Record<string, boolean>>(
        () => defaultIndicatorLineVisibility
            ?? loadSavedChartConfiguration()?.indicatorLineVisibility
            ?? {},
    );
    const [indicatorParameters, setIndicatorParameters] = useState<Record<string, IndicatorParameterSettings>>(
        () => loadSavedChartConfiguration()?.indicatorParameters ?? DEFAULT_CHART_INDICATOR_PARAMETERS,
    );
    const [timeframeFavorites, setTimeframeFavorites] = useState<ChartTimeframe[]>(() => loadTimeframeFavorites());
    const timeframeRef = useRef(timeframe);
    timeframeRef.current = timeframe;
    const chartDataContextRef = useRef<{ ticker: string; date: string; timeframe: ChartTimeframe } | null>(null);
    const visibleRangeRef = useRef<{ from: Time; to: Time } | null>(null);
    const replayLockRef = useRef(replayLocked);
    const lastReplayLogicalRangeRef = useRef<{ from: number; to: number } | null>(null);
    const lastReplayUpdatedBarTimeRef = useRef<number | null>(null);
    const replayContextKeyRef = useRef<string | null>(null);
    replayLockRef.current = replayLocked;
    // During replay the candle array is cloned on every trade so React can
    // publish the active candle. Session bands only depend on candle times,
    // therefore their expensive full-series scan is needed only when a new
    // candle is added (or when the chart context/style changes).
    const candleStructureDependency = replayBar ? candles.length : candles;
    const sessionBands = useMemo(
        () => timeframe !== '1D' ? buildSessionBands(candles, date, styleSettings) : [],
        [candleStructureDependency, date, timeframe, styleSettings.ahBackgroundColor, styleSettings.ahBackgroundOpacity, styleSettings.pmBackgroundColor, styleSettings.pmBackgroundOpacity],
    );
    const sessionBandsRef = useRef<SessionBand[]>([]);
    sessionBandsRef.current = sessionBands;
    const [bandRects, setBandRects] = useState<SessionBandRect[]>([]);
    useEffect(() => {
        // Start each newly opened chart with the indicator readout list
        // collapsed. This is shared by Manual Replay and Data Explorer.
        setIndicatorsCollapsed(true);
    }, [date, ticker, timeframe]);
    const visibleFavoriteTimeframes = useMemo(
        () => availableTimeframes.length === 1
            ? availableTimeframes
            : availableTimeframes.filter((option) => timeframeFavorites.includes(option)),
        [availableTimeframes, timeframeFavorites],
    );

    drawingToolRef.current = drawingTool;
    const activeVolumeIndicator = useMemo(() => {
        const latest = candles[candles.length - 1];
        const displayCandle = hoveredCandle ?? latest;
        if (!displayCandle) return null;
        return {
            label: volumeIndicatorLabel(volumeMode),
            value: volumeValue(displayCandle, volumeMode),
            color: volumeColor(displayCandle, volumeMode, styleSettings),
            vwap: typeof displayCandle.vwap === 'number' && Number.isFinite(displayCandle.vwap) ? displayCandle.vwap : null,
        };
    }, [candles, hoveredCandle, volumeMode, styleSettings.volumeDownColor, styleSettings.volumeUpColor]);

    // Normalize the chart data once for each actual data/timeframe change. In
    // replay, `candles` is intentionally cloned for every trade, but the
    // current bucket is already sent through the incremental `update()` path
    // below. Rebuilding the complete array here on every trade can block the
    // WebView when a session contains many candles/trades.
    const plottedCandles = useMemo(() => {
        const sorted = normalizeCandlesForChart(candles, date)
            .filter((candle) => candle.t > 0)
            .sort((a, b) => a.t - b.t);
        return fillMissingCandles(sorted, timeframe);
    }, [candleStructureDependency, date, timeframe]);
    const executionMarkers = useMemo<TradePriceMarker[]>(() => {
        if (plottedCandles.length === 0) return [];
        const candleTimes = plottedCandles.map((candle) => candle.t);
        const resolveCandleTime = (timestampMs: number): Time => {
            const timestampSec = timestampMs > 100_000_000_000 ? timestampMs / 1000 : timestampMs;
            let low = 0;
            let high = candleTimes.length - 1;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (candleTimes[middle] <= timestampSec) low = middle;
                else high = middle - 1;
            }
            return candleTimes[Math.max(0, low)] as Time;
        };

        return executions
            .filter((execution) => Number.isFinite(execution.timestampMs)
                && Number.isFinite(execution.quantity)
                && execution.quantity > 0
                && Number.isFinite(execution.price)
                && execution.price > 0)
            .map((execution) => ({
                time: resolveCandleTime(execution.timestampMs),
                price: execution.price,
                direction: execution.side === 'buy' ? 'up' : 'down',
                color: execution.side === 'buy' ? '#13E8E5' : '#F5E642',
            }));
    }, [executions, plottedCandles]);
    const priceLabelColor = useMemo(() => {
        const latest = replayBar ?? plottedCandles[plottedCandles.length - 1];
        if (!latest) return styleSettings.upColor;
        if (latest.synthetic) return '#E2E8F0';
        return latest.close >= latest.open ? styleSettings.upColor : styleSettings.downColor;
    }, [plottedCandles, replayBar, styleSettings.downColor, styleSettings.upColor]);

    // Indicator calculations are intentionally independent from hover and
    // visual style state. They run only when the candles, timeframe, date, or
    // selected indicator set changes.
    const calculatedIndicatorSeries = useMemo(() => {
        const series = new Map<string, Array<{ time: Time; value: number }>>();
        for (const id of selectedIndicators.filter((currentId) => !isCoreChartIndicatorId(currentId))) {
            series.set(id, calculateIndicatorSeries(id, plottedCandles, date, getIndicatorParameters(id, indicatorParameters)));
        }
        return series;
    }, [date, indicatorParameters, plottedCandles, selectedIndicators]);

    const indicatorValueByTime = useMemo(() => {
        const values = new Map<string, Map<number, number>>();
        for (const [id, series] of calculatedIndicatorSeries) {
            values.set(id, new Map(series.map((point) => [Number(point.time), point.value])));
        }
        return values;
    }, [calculatedIndicatorSeries]);

    const selectedIndicatorValues = useMemo(() => {
        const values = new Map<string, number | null>();
        if (selectedIndicators.length === 0 || plottedCandles.length === 0) return values;

        const targetTime = hoveredCandle?.t ?? plottedCandles[plottedCandles.length - 1]?.t;
        if (!targetTime) return values;

        for (const id of selectedIndicators.filter((currentId) => !isCoreChartIndicatorId(currentId))) {
            values.set(id, indicatorValueByTime.get(id)?.get(targetTime) ?? null);
        }
        return values;
    }, [hoveredCandle, indicatorValueByTime, plottedCandles, selectedIndicators]);

    useEffect(() => {
        setIndicatorLineVisibility((current) => {
            const next: Record<string, boolean> = {};
            for (const id of selectedIndicators) next[id] = current[id] ?? true;
            return next;
        });
    }, [selectedIndicators]);

    const syncBandRects = useCallback(() => {
        const chart = chartRef.current;
        const container = containerRef.current;
        const currentSessionBands = sessionBandsRef.current;
        if (!chart || !container || timeframeRef.current === '1D' || currentSessionBands.length === 0) {
            setBandRects([]);
            return;
        }

        const width = container.clientWidth;
        const timeScale = chart.timeScale();
        const nextRects = currentSessionBands
            .map((band) => {
                const startX = timeScale.timeToCoordinate(band.startTime as Time)
                    ?? timeScale.timeToCoordinate(band.fallbackStartTime as Time);
                const endX = timeScale.timeToCoordinate(band.endTime as Time)
                    ?? timeScale.timeToCoordinate(band.fallbackEndTime as Time);

                if (startX === null || endX === null) return null;

                const leftPx = Math.max(0, Math.min(startX, endX));
                const rightPx = Math.min(width, Math.max(startX, endX));
                const rectWidth = rightPx - leftPx;

                if (rectWidth <= 1) return null;

                return {
                    leftPx,
                    widthPx: rectWidth,
                    label: band.label,
                    color: band.color,
                };
            })
            .filter((rect): rect is SessionBandRect => rect !== null);

        setBandRects(nextRects);
    }, []);

    const captureVisibleRange = useCallback(() => {
        const visibleRange = chartRef.current?.timeScale().getVisibleRange();
        if (visibleRange) visibleRangeRef.current = { ...visibleRange };
    }, []);

    const fitChart = useCallback(() => {
        chartRef.current?.timeScale().fitContent();
        captureVisibleRange();
    }, [captureVisibleRange]);

    const zoomChart = (direction: 'in' | 'out') => {
        const chart = chartRef.current;
        if (!chart) return;
        const timeScale = chart.timeScale();
        const range = timeScale.getVisibleLogicalRange();
        if (!range) return;
        const center = (range.from + range.to) / 2;
        const span = range.to - range.from;
        const nextSpan = Math.max(8, span * (direction === 'in' ? 0.68 : 1.42));
        timeScale.setVisibleLogicalRange({
            from: center - nextSpan / 2,
            to: center + nextSpan / 2,
        });
    };

    const setSelectedDrawing = useCallback((next: SelectedDrawing) => {
        selectedDrawingRef.current = next;
        normalLinePrimitiveRef.current?.setSelectedIndex(next?.kind === 'line' ? next.index : null);
        for (const [index, drawing] of horizontalLinesRef.current.entries()) {
            drawing.line.applyOptions({
                color: next?.kind === 'horizontal' && next.index === index ? '#F4F7FF' : '#2196F3',
                lineWidth: 1,
            });
        }
    }, []);

    const clearDrawings = useCallback(() => {
        const candleSeries = candleRef.current;
        if (candleSeries) {
            for (const drawing of horizontalLinesRef.current) candleSeries.removePriceLine(drawing.line);
        }
        horizontalLinesRef.current = [];
        selectedDrawingRef.current = null;
        normalLinePrimitiveRef.current?.clear();
        pendingLineStartRef.current = null;
        setDrawingTool(null);
    }, []);

    const pointFromChartEvent = useCallback((param: MouseEventParams): DrawingPoint | null => {
        const chart = chartRef.current;
        const candleSeries = candleRef.current;
        const point = param.point;
        if (!chart || !candleSeries || !point) return null;

        const time = param.time ?? chart.timeScale().coordinateToTime(point.x);
        const price = candleSeries.coordinateToPrice(point.y);
        if (time === null || time === undefined || price === null || !Number.isFinite(price)) return null;
        return { time, price };
    }, []);

    const pointFromCoordinates = useCallback((x: number, y: number): DrawingPoint | null => {
        const chart = chartRef.current;
        const candleSeries = candleRef.current;
        if (!chart || !candleSeries) return null;
        const time = chart.timeScale().coordinateToTime(x);
        const price = candleSeries.coordinateToPrice(y);
        if (time === null || price === null || !Number.isFinite(price)) return null;
        return { time, price };
    }, []);

    const drawingHitAt = useCallback((x: number, y: number): DrawingHit | null => {
        const candleSeries = candleRef.current;
        if (!candleSeries) return normalLinePrimitiveRef.current?.getHitAt(x, y)
            ? { kind: 'line', ...normalLinePrimitiveRef.current.getHitAt(x, y)! }
            : null;

        let closestHorizontal: { index: number; distance: number } | null = null;
        for (let index = horizontalLinesRef.current.length - 1; index >= 0; index -= 1) {
            const drawing = horizontalLinesRef.current[index];
            const lineY = candleSeries.priceToCoordinate(drawing.price);
            if (lineY === null) continue;
            const distance = Math.abs(y - lineY);
            if (distance <= 9 && (!closestHorizontal || distance < closestHorizontal.distance)) {
                closestHorizontal = { index, distance };
            }
        }
        if (closestHorizontal) return { kind: 'horizontal', index: closestHorizontal.index, target: 'line' };

        const lineHit = normalLinePrimitiveRef.current?.getHitAt(x, y);
        return lineHit ? { kind: 'line', ...lineHit } : null;
    }, []);

    const deleteSelectedDrawing = useCallback(() => {
        const selected = selectedDrawingRef.current;
        if (!selected) return;

        if (selected.kind === 'horizontal') {
            const candleSeries = candleRef.current;
            const drawing = horizontalLinesRef.current[selected.index];
            if (candleSeries && drawing) candleSeries.removePriceLine(drawing.line);
            horizontalLinesRef.current.splice(selected.index, 1);
        } else {
            normalLinePrimitiveRef.current?.removeDrawing(selected.index);
        }
        setSelectedDrawing(null);
    }, [setSelectedDrawing]);

    const handleDrawingClick = useCallback((param: MouseEventParams) => {
        const tool = drawingToolRef.current;
        if (!tool) return;

        const point = pointFromChartEvent(param);
        if (!point) return;

        if (tool === 'horizontal') {
            const candleSeries = candleRef.current;
            if (!candleSeries) return;
            const line = candleSeries.createPriceLine({
                price: point.price,
                color: '#2196F3',
                lineWidth: 1,
                lineStyle: LineStyle.Solid,
                axisLabelVisible: true,
            });
            const index = horizontalLinesRef.current.length;
            horizontalLinesRef.current.push({ line, price: point.price });
            setSelectedDrawing({ kind: 'horizontal', index });
            pendingLineStartRef.current = null;
            setDrawingTool(null);
            return;
        }

        const start = pendingLineStartRef.current;
        if (!start) {
            pendingLineStartRef.current = point;
            normalLinePrimitiveRef.current?.setPreview({ start: point, end: point });
            return;
        }

        const primitive = normalLinePrimitiveRef.current;
        if (!primitive) return;
        const index = primitive.drawings.length;
        primitive.addDrawing({ start, end: point });
        setSelectedDrawing({ kind: 'line', index });
        pendingLineStartRef.current = null;
        setDrawingTool(null);
    }, [pointFromChartEvent, setSelectedDrawing]);

    const drawingContextRef = useRef<{ ticker: string; date: string } | null>(null);
    useEffect(() => {
        const previousContext = drawingContextRef.current;
        if (previousContext && (previousContext.ticker !== ticker || previousContext.date !== date)) {
            clearDrawings();
        }
        drawingContextRef.current = { ticker, date };
    }, [clearDrawings, date, ticker]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (!selectedDrawingRef.current) return;
                event.preventDefault();
                deleteSelectedDrawing();
            } else if (event.key === 'Escape') {
                pendingLineStartRef.current = null;
                normalLinePrimitiveRef.current?.setPreview(null);
                setDrawingTool(null);
                setSelectedDrawing(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [deleteSelectedDrawing, setSelectedDrawing]);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: styleSettings.backgroundColor },
                textColor: '#B2B5BE',
                fontFamily: '"Trebuchet MS", "Lucida Grande", sans-serif',
                fontSize: 12,
            },
            grid: {
                vertLines: { color: hexToRgba(styleSettings.gridColor, styleSettings.gridOpacity / 100) },
                horzLines: { color: hexToRgba(styleSettings.gridColor, styleSettings.gridOpacity / 100) },
            },
            crosshair: {
                mode: CrosshairMode.Normal,
                vertLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2A2E39' },
                horzLine: { visible: true, color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2A2E39' },
            },
            localization: {
                timeFormatter: (time: Time) => formatChartTime(time, timeframe),
            },
            rightPriceScale: {
                borderColor: '#1F2430',
                textColor: '#B2B5BE',
                entireTextOnly: false,
            },
                timeScale: {
                    borderColor: '#1F2430',
                    timeVisible: true,
                    secondsVisible: timeframe.endsWith('s'),
                tickMarkFormatter: (time: Time) => formatChartTime(time, timeframe),
                rightOffset: replayRightOffset,
                barSpacing: styleSettings.barSpacing,
                minBarSpacing: 2,
                fixLeftEdge: true,
                fixRightEdge: true,
                shiftVisibleRangeOnNewBar: false,
            },
            handleScale: {
                axisPressedMouseMove: true,
                mouseWheel: true,
                pinch: true,
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: false,
            },
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
        });

        const candleSeries = chart.addSeries(CandlestickSeries, {
            upColor: styleSettings.upColor,
            downColor: styleSettings.downColor,
            borderUpColor: styleSettings.borderUpColor,
            borderDownColor: styleSettings.borderDownColor,
            wickUpColor: styleSettings.wickUpColor,
            wickDownColor: styleSettings.wickDownColor,
            priceScaleId: 'right',
            priceLineColor: styleSettings.upColor,
            priceLineWidth: styleSettings.priceLineWidth,
            lastValueVisible: true,
            priceLineVisible: false,
            priceFormat: CHART_DISPLAY_PRICE_FORMAT,
            wickVisible: styleSettings.wickVisible,
            borderVisible: styleSettings.borderVisible,
        });

        const volSeries = chart.addSeries(HistogramSeries, {
            color: 'rgba(38,166,154,0.28)',
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
            lastValueVisible: false,
            priceLineVisible: false,
        });

        const vwapSeries = chart.addSeries(LineSeries, {
            color: '#DC2626',
            lineWidth: 2,
            priceScaleId: 'right',
            priceFormat: CHART_DISPLAY_PRICE_FORMAT,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
        });
        chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.78, bottom: 0 },
            borderVisible: false,
        });
        chart.priceScale('right').applyOptions({
            scaleMargins: { top: 0.04, bottom: 0.24 },
        });

        chartRef.current = chart;
        candleRef.current = candleSeries;
        const executionMarkers = new TradePriceMarkersPrimitive(candleSeries);
        candleSeries.attachPrimitive(executionMarkers);
        executionMarkersRef.current = executionMarkers;
        volRef.current = volSeries;
        vwapRef.current = vwapSeries;
        const normalLinePrimitive = new NormalLinePrimitive();
        candleSeries.attachPrimitive(normalLinePrimitive);
        normalLinePrimitiveRef.current = normalLinePrimitive;
        const pendingOrderOverlay = new PendingOrderOverlayPrimitive();
        candleSeries.attachPrimitive(pendingOrderOverlay);
        pendingOrderOverlayRef.current = pendingOrderOverlay;

        const handleCrosshairMove = (param: MouseEventParams) => {
            const time = typeof param.time === 'number' ? param.time : null;
            if (time !== hoveredTimeRef.current) {
                hoveredTimeRef.current = time;
                setHoveredCandle(time === null ? null : plottedCandlesRef.current.get(time) ?? null);
            }
            const pendingStart = pendingLineStartRef.current;
            if (drawingToolRef.current === 'line' && pendingStart) {
                const point = pointFromChartEvent(param);
                if (point) normalLinePrimitiveRef.current?.setPreview({ start: pendingStart, end: point });
            }
        };
        chart.subscribeCrosshairMove(handleCrosshairMove);
        chart.subscribeClick(handleDrawingClick);

        const resizeChart = () => {
            const element = containerRef.current;
            if (!element || element.clientWidth <= 0 || element.clientHeight <= 0) return;
            chart.applyOptions({
                width: element.clientWidth,
                height: element.clientHeight,
            });
            syncBandRects();
        };
        const ro = new ResizeObserver(resizeChart);
        ro.observe(containerRef.current);
        // The replay view can receive its final flex dimensions just after the
        // chart effect mounts. ResizeObserver normally catches this, but the
        // first frame makes the shared chart reliable in the Tauri WebView too.
        const initialResizeFrame = window.requestAnimationFrame(resizeChart);

        return () => {
            window.cancelAnimationFrame(initialResizeFrame);
            ro.disconnect();
            chart.unsubscribeCrosshairMove(handleCrosshairMove);
            chart.unsubscribeClick(handleDrawingClick);
            for (const drawing of horizontalLinesRef.current) candleSeries.removePriceLine(drawing.line);
            horizontalLinesRef.current = [];
            for (const line of pendingOrderPriceLabelsRef.current.values()) candleSeries.removePriceLine(line);
            pendingOrderPriceLabelsRef.current.clear();
            candleSeries.detachPrimitive(executionMarkers);
            executionMarkersRef.current = null;
            candleSeries.detachPrimitive(pendingOrderOverlay);
            pendingOrderOverlayRef.current = null;
            normalLinePrimitive.clear();
            candleSeries.detachPrimitive(normalLinePrimitive);
            normalLinePrimitiveRef.current = null;
            pendingLineStartRef.current = null;
            chart.remove();
            chartRef.current = null;
            candleRef.current = null;
            volRef.current = null;
            vwapRef.current = null;
            indicatorSeriesRef.current.clear();
        };
    }, []);

    useEffect(() => {
        executionMarkersRef.current?.setMarkers(executionMarkers);
    }, [executionMarkers]);

    useEffect(() => {
        const candleSeries = candleRef.current;
        pendingOrderOverlayRef.current?.setOrders(pendingOrders);
        if (!candleSeries) return;

        for (const line of pendingOrderPriceLabelsRef.current.values()) candleSeries.removePriceLine(line);
        pendingOrderPriceLabelsRef.current.clear();

        const addPriceLabel = (order: SessionChartPendingOrder, price: number, reference: 'limit' | 'stop') => {
            if (!Number.isFinite(price) || price <= 0) return;
            const color = order.status === 'held'
                ? '#F5B642'
                : order.side === 'buy' ? '#2BD790' : '#F18492';
            const line = candleSeries.createPriceLine({
                price,
                color,
                lineWidth: 1,
                lineStyle: LineStyle.Solid,
                lineVisible: false,
                axisLabelVisible: true,
                axisLabelColor: color,
            });
            pendingOrderPriceLabelsRef.current.set(`${order.id}:${reference}`, line);
        };

        for (const order of pendingOrders) {
            if (order.status !== 'working' && order.status !== 'partially_filled' && order.status !== 'held') continue;
            if (order.type === 'limit') addPriceLabel(order, order.limitPrice ?? Number.NaN, 'limit');
            if (order.type === 'stop') addPriceLabel(order, order.stopPrice ?? Number.NaN, 'stop');
            if (order.type === 'stop-limit') {
                addPriceLabel(order, order.stopPrice ?? order.limitPrice ?? Number.NaN, 'stop');
            }
        }
    }, [pendingOrders]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const chartPoint = (event: PointerEvent) => {
            const series = candleRef.current;
            const rect = container.getBoundingClientRect();
            if (!series || rect.width <= 0 || rect.height <= 0) return null;
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const price = series.coordinateToPrice(y);
            return Number.isFinite(price) ? { x, y, price: Number(price) } : null;
        };
        const snapPrice = (price: number) => {
            if (!Number.isFinite(tickSize) || !tickSize || tickSize <= 0) return price;
            return Number((Math.round(price / tickSize) * tickSize).toFixed(8));
        };
        const handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            const point = chartPoint(event);
            if (!point) return;
            const hit = pendingOrderOverlayRef.current?.getHitAt(point.x, point.y);
            if (!hit) return;
            event.preventDefault();
            event.stopPropagation();
            if (hit.action === 'close') {
                onCancelOrder?.(hit.orderId);
                return;
            }
            if (!onModifyOrder) return;
            pendingOrderDragRef.current = {
                orderId: hit.orderId,
                reference: hit.reference,
                price: hit.price,
                pointerId: event.pointerId,
            };
            pendingOrderOverlayRef.current?.setPreview(hit.orderId, hit.reference, hit.price);
            container.setPointerCapture?.(event.pointerId);
        };
        const handlePointerMove = (event: PointerEvent) => {
            const point = chartPoint(event);
            const drag = pendingOrderDragRef.current;
            if (drag && drag.pointerId === event.pointerId && point) {
                const nextPrice = snapPrice(point.price);
                pendingOrderOverlayRef.current?.setPreview(drag.orderId, drag.reference, nextPrice);
                pendingOrderPriceLabelsRef.current.get(`${drag.orderId}:${drag.reference}`)?.applyOptions({
                    price: nextPrice,
                });
                container.style.cursor = 'ns-resize';
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (!point) return;
            const hit = pendingOrderOverlayRef.current?.getHitAt(point.x, point.y);
            container.style.cursor = hit ? hit.action === 'close' ? 'pointer' : 'ns-resize' : '';
        };
        const finishDrag = (event: PointerEvent) => {
            const drag = pendingOrderDragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const point = chartPoint(event);
            const nextPrice = point ? snapPrice(point.price) : drag.price;
            pendingOrderDragRef.current = null;
            pendingOrderOverlayRef.current?.setPreview(drag.orderId, drag.reference, null);
            if (!point) {
                pendingOrderPriceLabelsRef.current.get(`${drag.orderId}:${drag.reference}`)?.applyOptions({
                    price: drag.price,
                });
            }
            if (point && Number.isFinite(nextPrice) && Math.abs(nextPrice - drag.price) > 1e-9) {
                const order = pendingOrders.find((candidate) => candidate.id === drag.orderId);
                const market = Number(currentPrice);
                const hasCurrentPrice = Number.isFinite(market);
                const invalidLimit = order?.side === 'buy' ? nextPrice >= market : nextPrice <= market;
                const invalidStop = order?.side === 'buy' ? nextPrice <= market : nextPrice >= market;
                const invalid = Boolean(order && hasCurrentPrice && (drag.reference === 'limit' ? invalidLimit : invalidStop));
                if (invalid && order) {
                    setInvalidDragPrompt({
                        orderId: drag.orderId,
                        reference: drag.reference,
                        originalPrice: drag.price,
                        attemptedPrice: nextPrice,
                        currentPrice: market,
                        side: order.side,
                        type: order.type,
                    });
                } else {
                    onModifyOrder?.(drag.orderId, nextPrice, drag.reference);
                }
            }
            if (container.hasPointerCapture?.(event.pointerId)) container.releasePointerCapture(event.pointerId);
            container.style.cursor = '';
            event.preventDefault();
            event.stopPropagation();
        };

        container.addEventListener('pointerdown', handlePointerDown, true);
        container.addEventListener('pointermove', handlePointerMove, true);
        container.addEventListener('pointerup', finishDrag, true);
        container.addEventListener('pointercancel', finishDrag, true);
        return () => {
            container.removeEventListener('pointerdown', handlePointerDown, true);
            container.removeEventListener('pointermove', handlePointerMove, true);
            container.removeEventListener('pointerup', finishDrag, true);
            container.removeEventListener('pointercancel', finishDrag, true);
            container.style.cursor = '';
            pendingOrderDragRef.current = null;
        };
    }, [currentPrice, onCancelOrder, onModifyOrder, pendingOrders, tickSize]);

    useEffect(() => {
        chartRef.current?.applyOptions({ timeScale: { rightOffset: replayRightOffset } });
    }, [replayRightOffset]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        replayLockRef.current = replayLocked;
        lastReplayLogicalRangeRef.current = replayLocked
            ? chart.timeScale().getVisibleLogicalRange()
            : null;
    }, [replayLocked]);

    useEffect(() => {
        const contextKey = `${ticker}|${date}|${timeframe}`;
        if (replayContextKeyRef.current === null) {
            replayContextKeyRef.current = contextKey;
            return;
        }
        if (replayContextKeyRef.current === contextKey) return;

        // A new timeframe/session rebuilds the series and therefore produces
        // a different logical range. Do not compare that programmatic range
        // with the previous chart context; otherwise the replay lock can
        // mistake a timeframe change for a backward pan and block zooming.
        replayContextKeyRef.current = contextKey;
        lastReplayLogicalRangeRef.current = null;
    }, [date, timeframe, ticker]);

    const enforceReplayForwardNavigation = useCallback(() => {
        const chart = chartRef.current;
        const nextRange = chart?.timeScale().getVisibleLogicalRange();
        if (!nextRange) return;

        const previousRange = lastReplayLogicalRangeRef.current;
        const movedBackward = previousRange
            && nextRange.from < previousRange.from
            && nextRange.to < previousRange.to;

        if (replayLockRef.current && movedBackward) {
            chart?.timeScale().setVisibleLogicalRange(previousRange);
            return;
        }

        lastReplayLogicalRangeRef.current = { ...nextRange };
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !chartRef.current) return;

        type DrawingDrag = {
            hit: DrawingHit;
            startX: number;
            startY: number;
            startDrawing?: NormalLineDrawing;
        };
        let drag: DrawingDrag | null = null;

        const localPoint = (event: PointerEvent) => {
            const rect = container.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        const handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            const { x, y } = localPoint(event);
            const hit = drawingHitAt(x, y);
            if (!hit) {
                setSelectedDrawing(null);
                return;
            }

            setSelectedDrawing({ kind: hit.kind, index: hit.index });
            drag = {
                hit,
                startX: x,
                startY: y,
                startDrawing: hit.kind === 'line'
                    ? normalLinePrimitiveRef.current?.drawings[hit.index]
                        ? { ...normalLinePrimitiveRef.current.drawings[hit.index] }
                        : undefined
                    : undefined,
            };
            event.preventDefault();
            event.stopPropagation();
            container.setPointerCapture(event.pointerId);
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (!drag) return;
            const { x, y } = localPoint(event);
            const dx = x - drag.startX;
            const dy = y - drag.startY;

            if (drag.hit.kind === 'horizontal') {
                const drawing = horizontalLinesRef.current[drag.hit.index];
                const candleSeries = candleRef.current;
                const price = candleSeries?.coordinateToPrice(y);
                if (drawing && price !== null && price !== undefined && Number.isFinite(price)) {
                    drawing.price = price;
                    drawing.line.applyOptions({ price });
                }
            } else {
                const primitive = normalLinePrimitiveRef.current;
                const startDrawing = drag.startDrawing;
                if (!primitive || !startDrawing) return;

                if (drag.hit.target === 'line') {
                    const chart = chartRef.current;
                    if (!chart) return;
                    const timeScale = chart.timeScale();
                    const series = candleRef.current;
                    if (!series) return;
                    const startX = timeScale.timeToCoordinate(startDrawing.start.time);
                    const endX = timeScale.timeToCoordinate(startDrawing.end.time);
                    const startY = series.priceToCoordinate(startDrawing.start.price);
                    const endY = series.priceToCoordinate(startDrawing.end.price);
                    if (startX === null || endX === null || startY === null || endY === null) return;
                    primitive.updateDrawing(drag.hit.index, {
                        start: pointFromCoordinates(startX + dx, startY + dy) ?? startDrawing.start,
                        end: pointFromCoordinates(endX + dx, endY + dy) ?? startDrawing.end,
                    });
                } else {
                    const point = pointFromCoordinates(x, y);
                    if (!point) return;
                    primitive.updateDrawing(drag.hit.index, {
                        [drag.hit.target]: point,
                    });
                }
            }

            event.preventDefault();
            event.stopPropagation();
        };

        const finishDrag = (event: PointerEvent) => {
            if (!drag) return;
            if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
            drag = null;
        };

        const handleContextMenu = (event: MouseEvent) => {
            const rect = container.getBoundingClientRect();
            const hit = drawingHitAt(event.clientX - rect.left, event.clientY - rect.top);
            if (!hit) return;
            event.preventDefault();
            setSelectedDrawing({ kind: hit.kind, index: hit.index });
        };

        container.addEventListener('pointerdown', handlePointerDown, true);
        container.addEventListener('pointermove', handlePointerMove, true);
        container.addEventListener('pointerup', finishDrag, true);
        container.addEventListener('pointercancel', finishDrag, true);
        container.addEventListener('contextmenu', handleContextMenu);

        return () => {
            container.removeEventListener('pointerdown', handlePointerDown, true);
            container.removeEventListener('pointermove', handlePointerMove, true);
            container.removeEventListener('pointerup', finishDrag, true);
            container.removeEventListener('pointercancel', finishDrag, true);
            container.removeEventListener('contextmenu', handleContextMenu);
            drag = null;
        };
    }, [drawingHitAt, pointFromCoordinates, setSelectedDrawing]);

    useEffect(() => {
        chartRef.current?.applyOptions({
            localization: {
                timeFormatter: (time: Time) => formatChartTime(time, timeframe),
            },
            timeScale: {
                secondsVisible: timeframe.endsWith('s'),
                tickMarkFormatter: (time: Time) => formatChartTime(time, timeframe),
            },
        });
    }, [timeframe]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        chart.timeScale().subscribeVisibleLogicalRangeChange(syncBandRects);
        chart.timeScale().subscribeVisibleLogicalRangeChange(enforceReplayForwardNavigation);
        chart.timeScale().subscribeVisibleTimeRangeChange(captureVisibleRange);
        chart.timeScale().subscribeSizeChange(syncBandRects);
        syncBandRects();

        return () => {
            chart.timeScale().unsubscribeVisibleLogicalRangeChange(syncBandRects);
            chart.timeScale().unsubscribeVisibleLogicalRangeChange(enforceReplayForwardNavigation);
            chart.timeScale().unsubscribeVisibleTimeRangeChange(captureVisibleRange);
            chart.timeScale().unsubscribeSizeChange(syncBandRects);
        };
    }, [captureVisibleRange, enforceReplayForwardNavigation, syncBandRects]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(CHART_STYLE_STORAGE_KEY, JSON.stringify(styleSettings));
    }, [styleSettings]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(CHART_TIMEFRAME_FAVORITES_STORAGE_KEY, JSON.stringify(timeframeFavorites));
    }, [timeframeFavorites]);

    useEffect(() => {
        updateChartPreservingViewport(chartRef.current, () => {
            candleRef.current?.applyOptions({
                upColor: styleSettings.upColor,
                downColor: styleSettings.downColor,
                borderUpColor: styleSettings.borderUpColor,
                borderDownColor: styleSettings.borderDownColor,
                wickUpColor: styleSettings.wickUpColor,
                wickDownColor: styleSettings.wickDownColor,
                priceLineColor: priceLabelColor,
                priceLineWidth: styleSettings.priceLineWidth,
                priceLineVisible: false,
                lastValueVisible: true,
                wickVisible: styleSettings.wickVisible,
                borderVisible: styleSettings.borderVisible,
            });
        });
    }, [
        styleSettings.borderDownColor,
        styleSettings.borderUpColor,
        styleSettings.borderVisible,
        styleSettings.downColor,
        styleSettings.priceLineWidth,
        styleSettings.upColor,
        styleSettings.wickDownColor,
        styleSettings.wickUpColor,
        styleSettings.wickVisible,
        priceLabelColor,
    ]);

    useEffect(() => {
        updateChartPreservingViewport(chartRef.current, () => {
            chartRef.current?.applyOptions({
                layout: {
                    background: { type: ColorType.Solid, color: styleSettings.backgroundColor },
                },
                grid: {
                    vertLines: { color: hexToRgba(styleSettings.gridColor, styleSettings.gridOpacity / 100) },
                    horzLines: { color: hexToRgba(styleSettings.gridColor, styleSettings.gridOpacity / 100) },
                },
            });
        });
    }, [styleSettings.backgroundColor, styleSettings.gridColor, styleSettings.gridOpacity]);

    useEffect(() => {
        chartRef.current?.applyOptions({
            timeScale: {
                barSpacing: styleSettings.barSpacing,
            },
        });
    }, [styleSettings.barSpacing]);

    useEffect(() => {
        volRef.current?.applyOptions({ visible: indicatorPresence.volume && indicatorVisibility.volume });
        vwapRef.current?.applyOptions({ visible: indicatorPresence.vwap && indicatorVisibility.vwap });
    }, [indicatorPresence, indicatorVisibility]);

    useEffect(() => {
        updateChartPreservingViewport(chartRef.current, () => {
            vwapRef.current?.applyOptions({
                color: styleSettings.vwapColor,
                lineWidth: styleSettings.vwapLineWidth,
            });
        });
    }, [styleSettings.vwapColor, styleSettings.vwapLineWidth]);

    useEffect(() => {
        if (!candleRef.current || !volRef.current || !vwapRef.current) return;

        const previousContext = chartDataContextRef.current;
        const sameSessionContext = previousContext !== null
            && previousContext.ticker === ticker
            && previousContext.date === date;
        const sameChartContext = previousContext !== null
            && previousContext.ticker === ticker
            && previousContext.date === date
            && previousContext.timeframe === timeframe;

        // A replay append is applied by the update() effect below. Keeping it
        // out of this setData path is what preserves the current viewport,
        // zoom and drawings while one new bar arrives. If the timeframe has
        // changed, the old replay bar may still be present for one render;
        // rebuild the complete series in that case, even when replay is
        // locked.
        if (replayBar && sameChartContext) return;

        const preserveVisibleRange = previousContext !== null
            && sameSessionContext;
        const currentVisibleRange = chartRef.current?.timeScale().getVisibleRange();
        const visibleRange = preserveVisibleRange
            ? visibleRangeRef.current ?? currentVisibleRange
            : null;

        if (!sameSessionContext) visibleRangeRef.current = null;

        if (candles.length === 0) {
            if (preserveVisibleRange && currentVisibleRange) {
                visibleRangeRef.current = { ...currentVisibleRange };
            }
            plottedCandlesRef.current.clear();
            candleRef.current.setData([]);
            volRef.current.setData([]);
            vwapRef.current.setData([]);
            chartDataContextRef.current = { ticker, date, timeframe };
            return;
        }

        if (plottedCandles.length === 0) {
            plottedCandlesRef.current.clear();
            candleRef.current.setData([]);
            volRef.current.setData([]);
            vwapRef.current.setData([]);
            chartDataContextRef.current = { ticker, date, timeframe };
            return;
        }

        const plotted = plottedCandles;
        plottedCandlesRef.current = new Map(plotted.map((candle) => [candle.t, candle]));
        setHoveredCandle(null);

        const candleData: CandlestickData[] = plotted.map(c => ({
            time: c.t as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            color: c.synthetic ? 'rgba(226,232,240,0.78)' : undefined,
            borderColor: c.synthetic ? 'rgba(226,232,240,0.92)' : undefined,
            wickColor: c.synthetic ? 'rgba(226,232,240,0.92)' : undefined,
        }));

        const volData: HistogramData[] = plotted.map(c => ({
            time: c.t as Time,
            value: volumeValue(c, volumeMode),
            color: c.synthetic
                ? 'rgba(226,232,240,0.10)'
                : hexToRgba(volumeColor(c, volumeMode, styleSettings), 0.45),
        }));
        const vwapData = plotted
            .filter((c) => !c.synthetic && Number.isFinite(c.vwap))
            .map((c) => ({ time: c.t as Time, value: c.vwap as number }));

        candleRef.current.setData(candleData);
        volRef.current.setData(indicatorPresence.volume ? volData : []);
        vwapRef.current.setData(indicatorPresence.vwap ? vwapData : []);
        const timeScale = chartRef.current?.timeScale();
        if (timeScale) {
            // A timeframe change must keep the user's current time window and
            // zoom. Replay auto-scroll is allowed to move the chart only on
            // subsequent replay updates, not while rebuilding this context.
            if (visibleRange && (!replayAutoScroll || !sameChartContext)) {
                timeScale.setVisibleRange(visibleRange);
                visibleRangeRef.current = { ...visibleRange };
            } else if (initialVisibleBars && initialVisibleBars > 0 && plotted.length > initialVisibleBars) {
                const to = plotted.length - 1 + replayRightOffset;
                timeScale.setVisibleLogicalRange({
                    from: to - initialVisibleBars,
                    to,
                });
                captureVisibleRange();
            } else {
                // The initial chart position uses exactly the same Fit action
                // as the toolbar button instead of a separate default range.
                fitChart();
            }
            requestAnimationFrame(syncBandRects);
            window.setTimeout(syncBandRects, 0);
        }
        chartDataContextRef.current = { ticker, date, timeframe };
    }, [candles.length, captureVisibleRange, date, fitChart, initialVisibleBars, plottedCandles, replayBar, replayRightOffset, ticker, timeframe, volumeMode, syncBandRects, indicatorPresence.volume, indicatorPresence.vwap]);

    useEffect(() => {
        if (!volRef.current) return;

        const plotted = Array.from(plottedCandlesRef.current.values());
        if (plotted.length === 0) {
            volRef.current.setData([]);
            return;
        }

        updateChartPreservingViewport(chartRef.current, () => {
            volRef.current?.setData(plotted.map((candle) => ({
                time: candle.t as Time,
                value: volumeValue(candle, volumeMode),
                color: candle.synthetic
                    ? 'rgba(226,232,240,0.10)'
                    : hexToRgba(volumeColor(candle, volumeMode, styleSettings), 0.45),
            })));
        });
    }, [styleSettings.volumeDownColor, styleSettings.volumeUpColor, volumeMode]);

    // Manual Backtesting can append one prepared bar at a time without
    // replacing the chart's existing series. Analytics never passes replayBar,
    // so its normal setData path and visual behaviour remain unchanged.
    useEffect(() => {
        if (!replayBar) {
            lastReplayUpdatedBarTimeRef.current = null;
            return;
        }
        if (!candleRef.current || !volRef.current || !vwapRef.current) return;
        const normalized = normalizeCandlesForChart([replayBar], date)
            .find((candle) => candle.t > 0);
        if (!normalized) return;
        const isNewReplayBar = lastReplayUpdatedBarTimeRef.current !== normalized.t;
        lastReplayUpdatedBarTimeRef.current = normalized.t;
        // lightweight-charts only accepts update() calls at the current last
        // timestamp or after it. During a Tick -> Bar handoff the carried
        // candle can already exist in the chart while the new props briefly
        // contain an older reconstructed candle. Ignore that stale update;
        // the next chronological bar will still be appended normally.
        const plottedTimes = Array.from(plottedCandlesRef.current.keys());
        const lastPlottedTime = plottedTimes[plottedTimes.length - 1] ?? null;
        if (lastPlottedTime != null && normalized.t < lastPlottedTime) return;
        // When a tick-replay candle is carried into bar replay, the first
        // bar update contains both the now-closed previous candle and the
        // new active bucket. Update the previous candle first so its partial
        // state is committed before the new candle is appended.
        if (isNewReplayBar) {
            // This reconciliation is only needed when the replay enters a
            // new bucket (not on every trade). Keeping it here avoids
            // normalizing the complete candle list for every tick.
            const visibleReplayCandles = normalizeCandlesForChart(candles, date)
                .filter((candle) => candle.t < normalized.t);
            const previousReplayCandle = visibleReplayCandles[visibleReplayCandles.length - 1];
            if (previousReplayCandle && (lastPlottedTime == null || previousReplayCandle.t >= lastPlottedTime)) {
                candleRef.current.update({
                    time: previousReplayCandle.t as Time,
                    open: previousReplayCandle.open,
                    high: previousReplayCandle.high,
                    low: previousReplayCandle.low,
                    close: previousReplayCandle.close,
                });
                volRef.current.update({
                    time: previousReplayCandle.t as Time,
                    value: volumeValue(previousReplayCandle, volumeMode),
                    color: hexToRgba(volumeColor(previousReplayCandle, volumeMode, styleSettings), 0.45),
                });
                const previousVwap = Number.isFinite(previousReplayCandle.vwap)
                    ? previousReplayCandle.vwap as number
                    : calculateReplayVwap(previousReplayCandle, plottedCandlesRef.current.values());
                vwapRef.current.update({ time: previousReplayCandle.t as Time, value: previousVwap });
                plottedCandlesRef.current.set(previousReplayCandle.t, previousReplayCandle);
            }
        }
        const replayVwap = Number.isFinite(normalized.vwap)
            ? normalized.vwap as number
            : calculateReplayVwap(normalized, plottedCandlesRef.current.values());

        candleRef.current.update({
            time: normalized.t as Time,
            open: normalized.open,
            high: normalized.high,
            low: normalized.low,
            close: normalized.close,
        });
        volRef.current.update({
            time: normalized.t as Time,
            value: volumeValue(normalized, volumeMode),
            color: hexToRgba(volumeColor(normalized, volumeMode, styleSettings), 0.45),
        });
        vwapRef.current.update({ time: normalized.t as Time, value: replayVwap });
        plottedCandlesRef.current.set(normalized.t, normalized);
        // Intrabar updates must not move the viewport. Only the first trade
        // in a new timeframe bucket advances the chart to the right.
        if (replayAutoScroll && isNewReplayBar) {
            const timeScale = chartRef.current?.timeScale();
            timeScale?.scrollToRealTime();
            // `scrollToRealTime()` can be deferred by lightweight-charts while
            // the new logical item is being inserted. Force the final logical
            // position on the next frame as well, so the newest replay candle
            // is visible both while playing and when stepping manually.
            requestAnimationFrame(() => {
                timeScale?.scrollToPosition(0, false);
                syncBandRects();
            });
        }
    }, [date, replayAutoScroll, replayBar, styleSettings.volumeDownColor, styleSettings.volumeUpColor, syncBandRects, volumeMode]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        const chartOverlayIndicators = selectedIndicators.filter((id) => !isCoreChartIndicatorId(id));
        const desired = new Set(chartOverlayIndicators);
        for (const [id, series] of indicatorSeriesRef.current) {
            if (!desired.has(id)) {
                chart.removeSeries(series);
                indicatorSeriesRef.current.delete(id);
                indicatorLastTimeRef.current.delete(id);
            }
        }

        for (const id of chartOverlayIndicators) {
            if (indicatorSeriesRef.current.has(id)) continue;
            const definition = chartIndicatorDefinition(id);
            const indicatorStyle = getIndicatorStyle(id, styleSettings);
            const series = chart.addSeries(LineSeries, {
                color: indicatorStyle.color,
                lineWidth: indicatorStyle.lineWidth,
                priceScaleId: definition?.valueType === 'volume' ? 'volume' : 'right',
                lastValueVisible: false,
                priceLineVisible: false,
                crosshairMarkerVisible: false,
            });
            indicatorSeriesRef.current.set(id, series);
        }

        if (plottedCandles.length === 0) {
            for (const series of indicatorSeriesRef.current.values()) series.setData([]);
            indicatorLastTimeRef.current.clear();
            return;
        }

        for (const [id, series] of indicatorSeriesRef.current) {
            const nextSeries = calculatedIndicatorSeries.get(id) ?? [];
            if (!replayBar) {
                series.setData(nextSeries);
                indicatorLastTimeRef.current.set(id, Number(nextSeries[nextSeries.length - 1]?.time ?? 0));
                continue;
            }

            // Replay indicators must advance with the same non-blocking
            // append as the candle/volume/VWAP series. Include the previous
            // point so an update of an existing timestamp remains valid.
            const lastTime = indicatorLastTimeRef.current.get(id) ?? 0;
            for (const point of nextSeries) {
                if (Number(point.time) >= lastTime) series.update(point);
            }
            indicatorLastTimeRef.current.set(id, Number(nextSeries[nextSeries.length - 1]?.time ?? lastTime));
        }
    }, [calculatedIndicatorSeries, plottedCandles.length, replayBar, selectedIndicators]);

    useEffect(() => {
        for (const [id, series] of indicatorSeriesRef.current) {
            const indicatorStyle = getIndicatorStyle(id, styleSettings);
            series.applyOptions({ color: indicatorStyle.color, lineWidth: indicatorStyle.lineWidth });
        }
    }, [selectedIndicators, styleSettings.indicatorStyles]);

    useEffect(() => {
        for (const [id, series] of indicatorSeriesRef.current) {
            series.applyOptions({ visible: indicatorLineVisibility[id] ?? true });
        }
    }, [indicatorLineVisibility]);

    useEffect(() => {
        syncBandRects();
    }, [syncBandRects, candles, date, timeframe, sessionBands, styleSettings.barSpacing]);

    const updateStyleSetting = <K extends keyof ChartStyleSettings>(key: K, value: ChartStyleSettings[K]) => {
        setStyleSettings((current) => ({ ...current, [key]: value }));
    };

    const updateIndicatorStyle = (indicator: string, key: keyof IndicatorStyleSettings, value: string | LineWidth) => {
        setStyleSettings((current) => ({
            ...current,
            indicatorStyles: {
                ...current.indicatorStyles,
                [indicator]: {
                    ...getIndicatorStyle(indicator, current),
                    [key]: value,
                },
            },
        }));
    };

    const updateIndicatorParameter = (indicator: string, key: keyof IndicatorParameterSettings, value: number) => {
        setIndicatorParameters((current) => ({
            ...current,
            [indicator]: {
                ...getIndicatorParameters(indicator, current),
                [key]: value,
            },
        }));
    };

    const toggleTimeframeFavorite = (option: ChartTimeframe) => {
        setTimeframeFavorites((current) => {
            if (current.includes(option)) {
                const next = current.filter((item) => item !== option);
                return next.length > 0 ? next : current;
            }
            return CHART_TIMEFRAMES.filter((item) => current.includes(item) || item === option);
        });
    };

    const saveIndicatorDefault = (indicator: string) => {
        const next: IndicatorDefaults = indicator === 'volume'
            ? {
                ...indicatorDefaults,
                volume: {
                    volumeMode,
                    volumeUpColor: styleSettings.volumeUpColor,
                    volumeDownColor: styleSettings.volumeDownColor,
                    visible: indicatorVisibility.volume,
                },
            }
            : indicator === 'vwap'
                ? {
                    ...indicatorDefaults,
                    vwap: {
                        vwapColor: styleSettings.vwapColor,
                        vwapLineWidth: styleSettings.vwapLineWidth,
                        visible: indicatorVisibility.vwap,
                    },
                }
                : {
                    ...indicatorDefaults,
                    indicatorStyles: {
                        ...indicatorDefaults.indicatorStyles,
                        [indicator]: getIndicatorStyle(indicator, styleSettings),
                    },
                    indicatorParameters: {
                        ...indicatorDefaults.indicatorParameters,
                        [indicator]: getIndicatorParameters(indicator, indicatorParameters),
                    },
                };
        setIndicatorDefaults(next);
        window.localStorage.setItem(INDICATOR_DEFAULTS_STORAGE_KEY, JSON.stringify(next));
    };

    const resetIndicatorToDefault = (indicator: string) => {
        if (indicator === 'volume') {
            const saved = indicatorDefaults.volume;
            onVolumeModeChange?.(saved?.volumeMode ?? 'volume');
            updateStyleSetting('volumeUpColor', saved?.volumeUpColor ?? DEFAULT_CHART_STYLE_SETTINGS.volumeUpColor);
            updateStyleSetting('volumeDownColor', saved?.volumeDownColor ?? DEFAULT_CHART_STYLE_SETTINGS.volumeDownColor);
            setIndicatorVisibility((current) => ({ ...current, volume: saved?.visible ?? true }));
            return;
        }

        if (indicator === 'vwap') {
            const saved = indicatorDefaults.vwap;
            updateStyleSetting('vwapColor', saved?.vwapColor ?? DEFAULT_CHART_STYLE_SETTINGS.vwapColor);
            updateStyleSetting('vwapLineWidth', saved?.vwapLineWidth ?? DEFAULT_CHART_STYLE_SETTINGS.vwapLineWidth);
            setIndicatorVisibility((current) => ({ ...current, vwap: saved?.visible ?? true }));
            return;
        }

        const saved = indicatorDefaults.indicatorStyles?.[indicator] ?? defaultIndicatorStyle(indicator);
        updateIndicatorStyle(indicator, 'color', saved.color);
        updateIndicatorStyle(indicator, 'lineWidth', saved.lineWidth);
        const savedParameters = indicatorDefaults.indicatorParameters?.[indicator] ?? defaultIndicatorParameters(indicator);
        updateIndicatorParameter(indicator, 'period', savedParameters.period);
        if (['supertrend', 'bb_upper', 'bb_lower', 'bb_basis'].includes(baseIndicatorId(indicator))) {
            updateIndicatorParameter(indicator, 'factor', savedParameters.factor ?? 2);
        }
    };

    const saveChartConfiguration = () => {
        const next: SavedChartConfiguration = {
            styleSettings,
            volumeMode,
            indicatorVisibility,
            indicatorPresence,
            selectedIndicators,
            indicatorParameters,
            indicatorLineVisibility,
        };
        setSavedChartConfiguration(next);
        window.localStorage.setItem(CHART_CONFIGURATION_STORAGE_KEY, JSON.stringify(next));
    };

    const resetChartConfiguration = () => {
        const saved = savedChartConfiguration ?? {
            styleSettings: DEFAULT_CHART_STYLE_SETTINGS,
            volumeMode: 'volume' as VolumeMode,
            indicatorVisibility: { volume: true, vwap: true },
            indicatorPresence: { volume: true, vwap: true },
            selectedIndicators: DEFAULT_CHART_INDICATORS,
            indicatorParameters: DEFAULT_CHART_INDICATOR_PARAMETERS,
            indicatorLineVisibility: {},
        };
        setStyleSettings(normalizeChartStyleSettings(saved.styleSettings));
        onVolumeModeChange?.(saved.volumeMode);
        setIndicatorVisibility(saved.indicatorVisibility);
        setIndicatorPresence(saved.indicatorPresence);
        setSelectedIndicators(saved.selectedIndicators);
        setIndicatorParameters(saved.indicatorParameters);
        setIndicatorLineVisibility(saved.indicatorLineVisibility);
    };

    const restoreInvalidDrag = () => {
        if (!invalidDragPrompt) return;
        pendingOrderOverlayRef.current?.setPreview(invalidDragPrompt.orderId, invalidDragPrompt.reference, invalidDragPrompt.originalPrice);
        pendingOrderPriceLabelsRef.current.get(`${invalidDragPrompt.orderId}:${invalidDragPrompt.reference}`)?.applyOptions({
            price: invalidDragPrompt.originalPrice,
        });
        setInvalidDragPrompt(null);
    };

    const acceptInvalidDragAsMarket = () => {
        if (!invalidDragPrompt) return;
        pendingOrderOverlayRef.current?.setPreview(invalidDragPrompt.orderId, invalidDragPrompt.reference, null);
        pendingOrderPriceLabelsRef.current.get(`${invalidDragPrompt.orderId}:${invalidDragPrompt.reference}`)?.applyOptions({
            price: invalidDragPrompt.originalPrice,
        });
        setInvalidDragPrompt(null);
        onExecuteOrderAsMarket?.(invalidDragPrompt.orderId);
    };

    return (
        <div className="relative flex h-full flex-col bg-[#000000]">
            <div className="flex h-10 shrink-0 items-center gap-3 border-b border-[#1F2430] bg-[#000000] px-3">
                <span className="min-w-[56px] text-[14px] font-semibold tracking-normal text-[#D1D4DC]">{ticker}</span>
                <div className="flex h-full items-center gap-0.5 border-l border-[#1F2430] pl-3">
                    {visibleFavoriteTimeframes.map((option) => (
                        <button
                            key={option}
                            type="button"
                            onClick={() => onTimeframeChange?.(option)}
                            className={[
                                'h-7 rounded px-2.5 text-[12px] font-semibold transition-colors',
                                timeframe === option
                                    ? 'bg-[#166534] text-white'
                                    : 'text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]',
                            ].join(' ')}
                        >
                            {formatTimeframeLabel(option)}
                        </button>
                    ))}
                    {availableTimeframes.length > 1 && <Popover>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className="inline-flex h-7 items-center gap-1 rounded px-2 text-[12px] font-semibold text-[#B2B5BE] transition-colors hover:bg-[#131722] hover:text-[#D1D4DC]"
                            >
                                <ChevronDown className="h-3.5 w-3.5 text-[#787B86]" />
                            </button>
                        </PopoverTrigger>
                        <PopoverContent
                            align="start"
                            sideOffset={6}
                            className="w-40 border-[#2A2E39] bg-[#0B0B0D] p-1 text-[#D1D4DC] shadow-[0_16px_44px_rgba(0,0,0,0.65)]"
                        >
                            <div className="grid gap-0.5">
                                {availableTimeframes.map((option) => {
                                    const favorite = timeframeFavorites.includes(option);
                                    return (
                                        <div key={option} className="grid grid-cols-[1fr_30px] gap-0.5">
                                            <button
                                                type="button"
                                                onClick={() => onTimeframeChange?.(option)}
                                                className={[
                                                    'flex h-8 items-center rounded px-2.5 text-left text-[12px] font-semibold transition-colors',
                                                    timeframe === option
                                                        ? 'bg-[#166534] text-white'
                                                        : 'text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]',
                                                ].join(' ')}
                                            >
                                                {formatTimeframeLabel(option)}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => toggleTimeframeFavorite(option)}
                                                className={[
                                                    'flex h-8 items-center justify-center rounded transition-colors',
                                                    favorite
                                                        ? 'text-[#F8C14A] hover:bg-[#131722]'
                                                        : 'text-[#4F5965] hover:bg-[#131722] hover:text-[#B2B5BE]',
                                                ].join(' ')}
                                                title={favorite ? 'Remove favorite' : 'Add favorite'}
                                            >
                                                <Star className="h-3.5 w-3.5" fill={favorite ? 'currentColor' : 'none'} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </PopoverContent>
                    </Popover>}
                </div>
                <Dialog open={indicatorsOpen} onOpenChange={setIndicatorsOpen}>
                    <button
                        type="button"
                        onClick={() => setIndicatorsOpen(true)}
                        className="inline-flex h-7 items-center gap-1.5 rounded border border-[#2A2E39] bg-[#0B0B0D] px-2 text-[11px] font-semibold text-[#B2B5BE] transition-colors hover:border-[#363C4E] hover:text-[#D1D4DC]"
                    >
                        <span className="text-[13px] leading-none text-[#B2B5BE]">ƒx</span>
                        Indicators
                    </button>
                    <DialogContent
                        className="w-[calc(100%_-_2rem)] border-[#1F2430] bg-[#0B0B0D] p-0 text-[#D1D4DC] shadow-[0_20px_60px_rgba(0,0,0,0.75)] sm:max-w-[520px]"
                    >
                        <DialogTitle className="sr-only">Indicators</DialogTitle>
                        <IndicatorPickerContent
                            selectedIndicators={selectedIndicators}
                            onSelectedIndicatorsChange={setSelectedIndicators}
                            volumeMode={volumeMode}
                            availableVolumeModes={supportedVolumeModes}
                            volumePresent={indicatorPresence.volume}
                            vwapPresent={indicatorPresence.vwap}
                            onVolumeModeSelect={(mode) => {
                                setIndicatorPresence((current) => ({ ...current, volume: true }));
                                onVolumeModeChange?.(mode);
                            }}
                            onToggleCoreIndicator={(indicator) => setIndicatorPresence((current) => ({ ...current, [indicator]: !current[indicator] }))}
                        />
                    </DialogContent>
                </Dialog>
                <div className="flex h-7 items-center gap-0.5 border-l border-[#1F2430] pl-2">
                    <button
                        type="button"
                        onClick={() => {
                            pendingLineStartRef.current = null;
                            normalLinePrimitiveRef.current?.setPreview(null);
                            setDrawingTool((current) => current === 'line' ? null : 'line');
                        }}
                        className={[
                            'flex h-7 w-7 items-center justify-center rounded border transition-colors',
                            drawingTool === 'line' ? 'border-[#3D8BE3] bg-[#1769C2] text-white shadow-[inset_0_0_0_1px_#3D8BE3]' : 'border-[#2A2E39] text-[#AEB6C4] hover:bg-[#151A22] hover:text-white',
                        ].join(' ')}
                        title="Draw line: click two points"
                        aria-label="Draw line"
                        aria-pressed={drawingTool === 'line'}
                    >
                        <NormalLineToolIcon />
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            pendingLineStartRef.current = null;
                            normalLinePrimitiveRef.current?.setPreview(null);
                            setDrawingTool((current) => current === 'horizontal' ? null : 'horizontal');
                        }}
                        className={[
                            'flex h-7 w-7 items-center justify-center rounded border transition-colors',
                            drawingTool === 'horizontal' ? 'border-[#3D8BE3] bg-[#1769C2] text-white shadow-[inset_0_0_0_1px_#3D8BE3]' : 'border-[#2A2E39] text-[#AEB6C4] hover:bg-[#151A22] hover:text-white',
                        ].join(' ')}
                        title="Draw horizontal line: click a price"
                        aria-label="Draw horizontal line"
                        aria-pressed={drawingTool === 'horizontal'}
                    >
                        <HorizontalLineToolIcon />
                    </button>
                </div>
                <div className="ml-auto flex items-center gap-1">
                    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                        <button
                            type="button"
                            onClick={() => setSettingsOpen(true)}
                            className="inline-flex h-7 items-center gap-1.5 rounded border border-[#2A2E39] bg-[#0B0B0D] px-2 text-[11px] font-semibold text-[#B2B5BE] transition-colors hover:border-[#363C4E] hover:text-[#D1D4DC]"
                        >
                            <Settings className="h-3.5 w-3.5" />
                            Settings
                        </button>
                        <DialogContent
                            className="w-[calc(100%_-_2rem)] border-[#1F2430] bg-[#0B0B0D] p-0 text-[#D1D4DC] shadow-[0_20px_60px_rgba(0,0,0,0.75)] sm:max-w-[630px]"
                        >
                            <DialogTitle className="sr-only">Chart settings</DialogTitle>
                            <ChartSettingsPanel
                                settings={styleSettings}
                                onChange={updateStyleSetting}
                                onReset={resetChartConfiguration}
                                onSaveConfiguration={saveChartConfiguration}
                                onAccept={() => setSettingsOpen(false)}
                            />
                        </DialogContent>
                    </Dialog>
                    <button
                        type="button"
                        onClick={() => zoomChart('in')}
                        className="rounded border border-[#2A2E39] bg-[#0B0B0D] px-2 py-1 text-[11px] font-semibold text-[#B2B5BE] hover:border-[#363C4E] hover:text-[#D1D4DC]"
                    >
                        Zoom +
                    </button>
                    <button
                        type="button"
                        onClick={() => zoomChart('out')}
                        className="rounded border border-[#2A2E39] bg-[#0B0B0D] px-2 py-1 text-[11px] font-semibold text-[#B2B5BE] hover:border-[#363C4E] hover:text-[#D1D4DC]"
                    >
                        Zoom -
                    </button>
                    <button
                        type="button"
                        onClick={fitChart}
                        className="rounded border border-[#2A2E39] bg-[#0B0B0D] px-2 py-1 text-[11px] font-semibold text-[#B2B5BE] hover:border-[#363C4E] hover:text-[#D1D4DC]"
                    >
                        Fit
                    </button>
                </div>
            </div>
            <div className="relative min-h-0 w-full flex-1 bg-[#000000]">
                <div className="pointer-events-none absolute inset-0 z-20">
                    {bandRects.map((band, index) => (
                        <div
                            key={`${band.label}-${index}-${band.leftPx}`}
                            className="absolute inset-y-0"
                            style={{
                                left: `${band.leftPx}px`,
                                width: `${band.widthPx}px`,
                                background: band.color,
                            }}
                        />
                    ))}
                </div>
                <div className="pointer-events-none absolute bottom-[20%] left-0 right-0 z-20 border-t border-[#1F2430]" />
                {activeVolumeIndicator && (indicatorPresence.volume || indicatorPresence.vwap || selectedIndicators.some((id) => !isCoreChartIndicatorId(id))) && (
                    <div className="pointer-events-none absolute left-3 top-2 z-30 flex flex-col items-start font-mono text-[10px] leading-none tabular-nums">
                        {!indicatorsCollapsed && <div className="pointer-events-auto flex flex-col gap-0.5">
                            {indicatorPresence.volume && (
                        <div className={['group pointer-events-auto flex items-center gap-1.5', indicatorVisibility.volume ? 'text-[#A0AEC0]' : 'text-[#4B5563]'].join(' ')}>
                            <button
                                type="button"
                                className="pointer-events-auto inline-flex h-3.5 w-3.5 items-center justify-center text-[#787B86] hover:text-[#D1D4DC]"
                                onClick={() => setIndicatorVisibility((current) => ({ ...current, volume: !current.volume }))}
                                aria-label={indicatorVisibility.volume ? 'Hide volume' : 'Show volume'}
                                aria-pressed={indicatorVisibility.volume}
                            >
                                {indicatorVisibility.volume
                                    ? <Eye className="h-3.5 w-3.5" strokeWidth={1.7} />
                                    : <EyeOff className="h-3.5 w-3.5" strokeWidth={1.7} />}
                            </button>
                            <Dialog open={openIndicator === 'volume'} onOpenChange={(open) => setOpenIndicator(open ? 'volume' : null)}>
                                    <button
                                        type="button"
                                        className="pointer-events-auto inline-flex items-center gap-1.5 text-[10px] font-medium hover:text-[#E1E7EF]"
                                        aria-label="Configure volume indicator"
                                        onClick={() => setOpenIndicator('volume')}
                                    >
                                        <span>{activeVolumeIndicator.label}</span>
                                        {indicatorVisibility.volume && (
                                            <span style={{ color: activeVolumeIndicator.color }}>
                                                {formatIndicatorValue(activeVolumeIndicator.value)}
                                            </span>
                                        )}
                                        <Settings className="hidden h-3.5 w-3.5 text-[#787B86] group-hover:block hover:text-[#D1D4DC]" strokeWidth={1.7} />
                                    </button>
                                <DialogContent
                                    className="w-[calc(100%_-_2rem)] border-[#1F2430] bg-[#0B0B0D] p-0 text-[#D1D4DC] shadow-[0_20px_60px_rgba(0,0,0,0.75)] sm:max-w-[630px]"
                                >
                                    <DialogTitle className="sr-only">Configure volume indicator</DialogTitle>
                                    <IndicatorSettingsPanel
                                        indicator="volume"
                                        volumeMode={volumeMode}
                                        availableVolumeModes={supportedVolumeModes}
                                        onVolumeModeChange={onVolumeModeChange}
                                        settings={styleSettings}
                                        onChange={updateStyleSetting}
                                        onSaveDefault={() => saveIndicatorDefault('volume')}
                                        onResetDefault={() => resetIndicatorToDefault('volume')}
                                        onAccept={() => setOpenIndicator(null)}
                                    />
                                </DialogContent>
                            </Dialog>
                            <button
                                type="button"
                                className="pointer-events-auto hidden h-3.5 w-3.5 items-center justify-center text-[#787B86] hover:text-[#D1D4DC] group-hover:inline-flex"
                                onClick={() => setIndicatorPresence((current) => ({ ...current, volume: false }))}
                                aria-label="Remove volume indicator"
                            >
                                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                            </button>
                        </div>
                            )}
                            {indicatorPresence.vwap && candles.some((candle) => typeof candle.vwap === 'number' && Number.isFinite(candle.vwap)) && (
                            <div className={['group pointer-events-auto flex items-center gap-1.5', indicatorVisibility.vwap ? 'text-[#A0AEC0]' : 'text-[#4B5563]'].join(' ')}>
                                <button
                                    type="button"
                                    className="pointer-events-auto inline-flex h-3.5 w-3.5 items-center justify-center text-[#787B86] hover:text-[#D1D4DC]"
                                    onClick={() => setIndicatorVisibility((current) => ({ ...current, vwap: !current.vwap }))}
                                    aria-label={indicatorVisibility.vwap ? 'Hide VWAP' : 'Show VWAP'}
                                    aria-pressed={indicatorVisibility.vwap}
                                >
                                    {indicatorVisibility.vwap
                                        ? <Eye className="h-3.5 w-3.5" strokeWidth={1.7} />
                                        : <EyeOff className="h-3.5 w-3.5" strokeWidth={1.7} />}
                                </button>
                                <Dialog open={openIndicator === 'vwap'} onOpenChange={(open) => setOpenIndicator(open ? 'vwap' : null)}>
                                        <button
                                            type="button"
                                            className="pointer-events-auto inline-flex items-center gap-1.5 text-[10px] font-medium hover:text-[#E1E7EF]"
                                            aria-label="Configure VWAP indicator"
                                            onClick={() => setOpenIndicator('vwap')}
                                        >
                                            <span>VWAP</span>
                                            {indicatorVisibility.vwap && (
                                                <span style={{ color: styleSettings.vwapColor }}>
                                                    {activeVolumeIndicator.vwap === null ? '—' : formatPriceIndicator(activeVolumeIndicator.vwap)}
                                                </span>
                                            )}
                                            <Settings className="hidden h-3.5 w-3.5 text-[#787B86] group-hover:block hover:text-[#D1D4DC]" strokeWidth={1.7} />
                                        </button>
                                    <DialogContent
                                        className="w-[calc(100%_-_2rem)] border-[#1F2430] bg-[#0B0B0D] p-0 text-[#D1D4DC] shadow-[0_20px_60px_rgba(0,0,0,0.75)] sm:max-w-[630px]"
                                    >
                                        <DialogTitle className="sr-only">Configure VWAP indicator</DialogTitle>
                                        <IndicatorSettingsPanel
                                            indicator="vwap"
                                            volumeMode={volumeMode}
                                            availableVolumeModes={supportedVolumeModes}
                                            onVolumeModeChange={onVolumeModeChange}
                                            settings={styleSettings}
                                            onChange={updateStyleSetting}
                                            onSaveDefault={() => saveIndicatorDefault('vwap')}
                                            onResetDefault={() => resetIndicatorToDefault('vwap')}
                                            onAccept={() => setOpenIndicator(null)}
                                        />
                                        </DialogContent>
                                    </Dialog>
                                <button
                                    type="button"
                                    className="pointer-events-auto hidden h-3.5 w-3.5 items-center justify-center text-[#787B86] hover:text-[#D1D4DC] group-hover:inline-flex"
                                    onClick={() => setIndicatorPresence((current) => ({ ...current, vwap: false }))}
                                    aria-label="Remove VWAP indicator"
                                >
                                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                                </button>
                            </div>
                            )}
                            {selectedIndicators.filter((id) => !isCoreChartIndicatorId(id)).map((id) => {
                            const visible = indicatorLineVisibility[id] ?? true;
                            const value = selectedIndicatorValues.get(id);
                            const label = indicatorDisplayLabel(id, indicatorParameters);
                            const indicatorStyle = getIndicatorStyle(id, styleSettings);
                            return (
                                <div
                                    key={id}
                                    className={['group pointer-events-auto flex items-center gap-1.5', visible ? 'text-[#A0AEC0]' : 'text-[#4B5563]'].join(' ')}
                                >
                                    <button
                                        type="button"
                                        className="pointer-events-auto inline-flex h-3.5 w-3.5 items-center justify-center text-[#787B86] hover:text-[#D1D4DC]"
                                        onClick={() => setIndicatorLineVisibility((current) => ({ ...current, [id]: !visible }))}
                                        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
                                        aria-pressed={visible}
                                    >
                                        {visible
                                            ? <Eye className="h-3.5 w-3.5" strokeWidth={1.7} />
                                            : <EyeOff className="h-3.5 w-3.5" strokeWidth={1.7} />}
                                    </button>
                                    <Dialog open={openIndicator === id} onOpenChange={(open) => setOpenIndicator(open ? id : null)}>
                                        <button
                                            type="button"
                                            className="pointer-events-auto inline-flex items-center gap-1.5 text-[10px] font-medium hover:text-[#E1E7EF]"
                                            aria-label={`Configure ${label} indicator`}
                                            onClick={() => setOpenIndicator(id)}
                                        >
                                            <span className="max-w-[150px] truncate text-[10px]" title={label}>{label}</span>
                                            {visible && value !== null && value !== undefined && (
                                                <span style={{ color: indicatorStyle.color }}>
                                                    {formatChartIndicatorValue(id, value)}
                                                </span>
                                            )}
                                            <Settings className="hidden h-3.5 w-3.5 text-[#787B86] group-hover:block hover:text-[#D1D4DC]" strokeWidth={1.7} />
                                        </button>
                                        <DialogContent
                                            className="w-[calc(100%_-_2rem)] border-[#1F2430] bg-[#0B0B0D] p-0 text-[#D1D4DC] shadow-[0_20px_60px_rgba(0,0,0,0.75)] sm:max-w-[630px]"
                                        >
                                            <DialogTitle className="sr-only">Configure {label} indicator</DialogTitle>
                                            <IndicatorSettingsPanel
                                                indicator={id}
                                                volumeMode={volumeMode}
                                                availableVolumeModes={supportedVolumeModes}
                                                onVolumeModeChange={onVolumeModeChange}
                                                settings={styleSettings}
                                                indicatorParameters={indicatorParameters}
                                                onChange={updateStyleSetting}
                                                onIndicatorStyleChange={updateIndicatorStyle}
                                                onIndicatorParameterChange={updateIndicatorParameter}
                                                onSaveDefault={() => saveIndicatorDefault(id)}
                                                onResetDefault={() => resetIndicatorToDefault(id)}
                                                onAccept={() => setOpenIndicator(null)}
                                            />
                                        </DialogContent>
                                    </Dialog>
                                    <button
                                        type="button"
                                        className="pointer-events-auto hidden h-3.5 w-3.5 items-center justify-center text-[#787B86] hover:text-[#D1D4DC] group-hover:inline-flex"
                                        onClick={() => setSelectedIndicators((current) => current.filter((currentId) => currentId !== id))}
                                        aria-label={`Remove ${label}`}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                                    </button>
                                </div>
                            );
                            })}
                        </div>}
                        <button
                            type="button"
                            className="pointer-events-auto mt-2 inline-flex h-6 min-w-8 items-center justify-center gap-1 rounded border border-[#343A46] bg-[#080A0D] px-1.5 text-[#AEB6C4] shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition-colors hover:border-[#4C5668] hover:bg-[#151A22] hover:text-white"
                            onClick={() => setIndicatorsCollapsed((current) => !current)}
                            aria-label={indicatorsCollapsed ? 'Show indicator list' : 'Hide indicator list'}
                            aria-expanded={!indicatorsCollapsed}
                        >
                            {indicatorsCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                            {indicatorsCollapsed && <span className="text-[10px]">{(indicatorPresence.volume ? 1 : 0) + (indicatorPresence.vwap ? 1 : 0) + selectedIndicators.filter((id) => !isCoreChartIndicatorId(id)).length}</span>}
                        </button>
                    </div>
                )}
                <div ref={containerRef} className="relative z-10 flex-1 w-full h-full min-h-0" />
                {invalidDragPrompt && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="presentation">
                        <div
                            className="w-full max-w-[360px] rounded-md border border-[#F5B642]/60 bg-[#0B1420] p-4 text-[#DCEBF5] shadow-[0_16px_44px_rgba(0,0,0,0.7)]"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="invalid-order-price-title"
                        >
                            <div id="invalid-order-price-title" className="text-[12px] font-bold uppercase tracking-[0.08em] text-[#F5B642]">Invalid order price</div>
                            <p className="mt-2 text-[11px] leading-relaxed text-[#B8C9D7]">
                                {invalidDragPrompt.side === 'buy' ? 'A BUY' : 'A SELL/SHORT'} {invalidDragPrompt.type === 'stop-limit' ? 'STOP LIMIT' : invalidDragPrompt.type.toUpperCase()} must be {invalidDragPrompt.side === 'buy' ? 'below' : 'above'} the current trade price ({formatPriceIndicator(invalidDragPrompt.currentPrice)}).
                            </p>
                            <p className="mt-2 text-[11px] leading-relaxed text-[#B8C9D7]">
                                Accept will convert this order to Market and use the best {invalidDragPrompt.side === 'buy' ? 'ASK' : 'BID'} available. Cancel will restore {formatPriceIndicator(invalidDragPrompt.originalPrice)}.
                            </p>
                            <div className="mt-4 flex justify-end gap-2">
                                <button type="button" className="rounded border border-[#34495C] bg-[#101D2A] px-3 py-1.5 text-[10px] font-bold uppercase text-[#B8C9D7] hover:border-[#6B8498] hover:text-white" onClick={restoreInvalidDrag}>Cancel</button>
                                <button type="button" className="rounded border border-[#2BD790]/70 bg-[#16845B] px-3 py-1.5 text-[10px] font-bold uppercase text-white hover:bg-[#1BA66F]" onClick={acceptInvalidDragAsMarket}>Accept / Market</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function IndicatorSettingsPanel({
    indicator,
    volumeMode,
    availableVolumeModes,
    onVolumeModeChange,
    settings,
    indicatorParameters,
    onChange,
    onIndicatorStyleChange,
    onIndicatorParameterChange,
    onSaveDefault,
    onResetDefault,
    onAccept,
}: {
    indicator: string;
    volumeMode: VolumeMode;
    availableVolumeModes: VolumeMode[];
    onVolumeModeChange?: (mode: VolumeMode) => void;
    settings: ChartStyleSettings;
    indicatorParameters?: Record<string, IndicatorParameterSettings>;
    onChange: <K extends keyof ChartStyleSettings>(key: K, value: ChartStyleSettings[K]) => void;
    onIndicatorStyleChange?: (indicator: string, key: keyof IndicatorStyleSettings, value: string | LineWidth) => void;
    onIndicatorParameterChange?: (indicator: string, key: keyof IndicatorParameterSettings, value: number) => void;
    onSaveDefault: () => void;
    onResetDefault: () => void;
    onAccept: () => void;
}) {
    const isDynamicIndicator = indicator !== 'volume' && indicator !== 'vwap';
    const baseId = baseIndicatorId(indicator);
    const definition = chartIndicatorDefinition(indicator);
    const hasInputParameters = indicator === 'volume' || (isDynamicIndicator && definition && INDICATOR_DEFINITIONS[baseId as keyof typeof INDICATOR_DEFINITIONS]?.configurable === true);
    const [activeTab, setActiveTab] = useState<IndicatorSettingsTab>(() => hasInputParameters ? 'inputs' : 'style');
    const [defaultMenuOpen, setDefaultMenuOpen] = useState(false);
    const title = indicator === 'volume'
        ? volumeIndicatorLabel(volumeMode)
        : indicator === 'vwap'
            ? 'VWAP'
            : indicatorDisplayLabel(indicator, indicatorParameters ?? {});
    const dynamicStyle = isDynamicIndicator ? getIndicatorStyle(indicator, settings) : null;
    const tabs: Array<[IndicatorSettingsTab, string]> = hasInputParameters
        ? [['inputs', 'Data inputs'], ['style', 'Style']]
        : [['style', 'Style']];
    const dynamicParameters = isDynamicIndicator
        ? getIndicatorParameters(indicator, indicatorParameters ?? {})
        : null;

    return (
        <div className="overflow-hidden rounded-md bg-[#0B0B0D] font-sans">
            <div className="border-b border-[#1F2430] px-5 py-4">
                <span className="text-[18px] font-semibold tracking-tight text-[#D1D4DC]">{title}</span>
            </div>
            <div className="flex border-b border-[#1F2430] px-5">
                {tabs.map(([tab, label]) => (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={[
                            'relative px-3 py-3 text-[13px] font-semibold transition-colors',
                            activeTab === tab ? 'text-[#D1D4DC]' : 'text-[#787B86] hover:text-[#B2B5BE]',
                        ].join(' ')}
                    >
                        {label}
                        {activeTab === tab && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-[#22C55E]" />}
                    </button>
                ))}
            </div>

            <div className="space-y-5 p-5">
                {activeTab === 'inputs' && indicator === 'volume' && (
                    <label className="block">
                        <span className="mb-2 block text-[12px] font-semibold text-[#8A97AA]">Display</span>
                        {availableVolumeModes.length === 1 ? (
                            <div className="flex h-10 items-center rounded border border-[#2A2E39] bg-[#111317] px-3 text-[13px] font-medium text-[#D1D4DC]">Volume</div>
                        ) : (
                            <select
                                value={volumeMode}
                                onChange={(event) => onVolumeModeChange?.(event.target.value as VolumeMode)}
                                className="h-10 w-full rounded border border-[#2A2E39] bg-[#111317] px-3 text-[13px] font-medium text-[#D1D4DC] outline-none focus:border-[#22C55E]"
                            >
                                {availableVolumeModes.map((mode) => <option key={mode} value={mode}>{volumeIndicatorLabel(mode)}</option>)}
                            </select>
                        )}
                    </label>
                )}
                {activeTab === 'inputs' && isDynamicIndicator && dynamicParameters && (
                    <div className="space-y-4">
                        <label className="block">
                            <span className="mb-2 block text-[12px] font-semibold text-[#8A97AA]">Period</span>
                            <input
                                type="number"
                                min={1}
                                max={500}
                                step={1}
                                value={dynamicParameters.period}
                                onChange={(event) => onIndicatorParameterChange?.(indicator, 'period', clampInteger(event.target.value, 1, 500, dynamicParameters.period))}
                                className="h-10 w-full rounded border border-[#2A2E39] bg-[#111317] px-3 text-[13px] font-medium text-[#D1D4DC] outline-none focus:border-[#22C55E]"
                            />
                        </label>
                        {['supertrend', 'bb_upper', 'bb_lower', 'bb_basis'].includes(indicator) && (
                            <label className="block">
                                <span className="mb-2 block text-[12px] font-semibold text-[#8A97AA]">Factor</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={10}
                                    step={1}
                                    value={dynamicParameters.factor ?? 3}
                                    onChange={(event) => onIndicatorParameterChange?.(indicator, 'factor', clampInteger(event.target.value, 1, 10, dynamicParameters.factor ?? 3))}
                                className="h-10 w-full rounded border border-[#2A2E39] bg-[#111317] px-3 text-[13px] font-medium text-[#D1D4DC] outline-none focus:border-[#22C55E]"
                                />
                            </label>
                        )}
                    </div>
                )}
                {activeTab === 'style' && indicator === 'volume' && (
                    <div className="space-y-4">
                        <IndicatorColorPalette label="Positive" value={settings.volumeUpColor} onChange={(value) => onChange('volumeUpColor', value)} />
                        <IndicatorColorPalette label="Negative" value={settings.volumeDownColor} onChange={(value) => onChange('volumeDownColor', value)} />
                    </div>
                )}
                {activeTab === 'style' && indicator === 'vwap' && (
                    <>
                        <IndicatorColorPalette label="Color" value={settings.vwapColor} onChange={(value) => onChange('vwapColor', value)} />
                        <LineWidthControl
                            value={settings.vwapLineWidth}
                            onChange={(value) => onChange('vwapLineWidth', value as LineWidth)}
                        />
                    </>
                )}
                {activeTab === 'style' && isDynamicIndicator && dynamicStyle && (
                    <>
                        <IndicatorColorPalette
                            label="Color"
                            value={dynamicStyle.color}
                            onChange={(value) => onIndicatorStyleChange?.(indicator, 'color', value)}
                        />
                        <LineWidthControl
                            value={dynamicStyle.lineWidth}
                            onChange={(value) => onIndicatorStyleChange?.(indicator, 'lineWidth', value)}
                        />
                    </>
                )}

            </div>
            <div className="relative flex items-center justify-between gap-3 border-t border-[#1F2430] px-5 py-4">
                <button
                    type="button"
                    onClick={() => setDefaultMenuOpen((current) => !current)}
                    className="inline-flex h-10 items-center gap-2 rounded border border-[#2A2E39] bg-[#0B0B0D] px-3 text-[12px] font-medium text-[#B2B5BE] transition-colors hover:border-[#22C55E] hover:text-[#D1D4DC]"
                >
                    Default
                    {defaultMenuOpen
                        ? <ChevronUp className="h-3.5 w-3.5 text-[#9CA3AF]" />
                        : <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" />}
                </button>
                {defaultMenuOpen && (
                    <div className="absolute bottom-[calc(100%-2px)] left-5 z-10 min-w-[210px] overflow-hidden rounded-md border border-[#1F2430] bg-[#0B0B0D] p-1 shadow-[0_14px_34px_rgba(0,0,0,0.65)]">
                        <button
                            type="button"
                            onClick={() => {
                                onResetDefault();
                                setDefaultMenuOpen(false);
                            }}
                            className="block w-full rounded px-3 py-2.5 text-left text-[12px] font-medium text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]"
                        >
                            Reset configuration
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                onSaveDefault();
                                setDefaultMenuOpen(false);
                            }}
                            className="block w-full rounded px-3 py-2.5 text-left text-[12px] font-medium text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]"
                        >
                            Save as default
                        </button>
                    </div>
                )}
                <button
                    type="button"
                    onClick={onAccept}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-[#166534] px-6 text-[13px] font-semibold text-white shadow-[0_4px_14px_rgba(22,101,52,0.30)] transition-colors hover:bg-[#14532D]"
                >
                    Accept
                </button>
            </div>
        </div>
    );
}

const INDICATOR_COLOR_PALETTE = [
    '#FFFFFF', '#E0E0E0', '#BDBDBD', '#9E9E9E', '#757575', '#616161', '#424242', '#303030', '#111111', '#000000',
    '#F23645', '#B91C1C', '#FFEB3B', '#4CAF50', '#166534', '#16A34A', '#673AB7', '#9C27B0', '#E91E63',
    '#FFCDD2', '#FFE0B2', '#FFF9C4', '#C8E6C9', '#B2DFDB', '#B2EBF2', '#BBDEFB', '#D1C4E9', '#E1BEE7', '#F8BBD0',
    '#EF9A9A', '#FFCC80', '#FFF59D', '#A5D6A7', '#166534', '#4ADE80', '#86EFAC', '#B39DDB', '#CE93D8', '#F48FB1',
    '#EF5350', '#FFA726', '#FFEE58', '#66BB6A', '#26A69A', '#26C6DA', '#42A5F5', '#7E57C2', '#AB47BC', '#EC407A',
    '#E53935', '#FB8C00', '#FDD835', '#43A047', '#00897B', '#00ACC1', '#1E88E5', '#5E35B1', '#8E24AA', '#D81B60',
    '#C62828', '#EF6C00', '#F9A825', '#2E7D32', '#00695C', '#00838F', '#1565C0', '#4527A0', '#6A1B9A', '#AD1457',
    '#B71C1C', '#E65100', '#F57F17', '#1B5E20', '#004D40', '#006064', '#0D47A1', '#311B92', '#4A148C', '#880E4F',
];

function IndicatorColorPalette({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <div>
            <div className="mb-2.5 text-[12px] font-semibold text-[#8A97AA]">{label}</div>
            <div className="grid w-full grid-cols-10 justify-items-center gap-y-2.5">
                {INDICATOR_COLOR_PALETTE.map((color) => (
                    <button
                        key={`${label}-${color}`}
                        type="button"
                        onClick={() => onChange(color)}
                        className={[
                            'h-5 w-5 rounded-[4px] border transition-transform hover:scale-110',
                            value.toLowerCase() === color.toLowerCase() ? 'border-white ring-1 ring-[#22C55E]' : 'border-transparent',
                        ].join(' ')}
                        style={{ backgroundColor: color }}
                        aria-label={`Set ${label.toLowerCase()} color to ${color}`}
                    />
                ))}
            </div>
            <label className="relative mt-3 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded border border-[#2A2E39] bg-[#0B0B0D] text-[21px] font-light text-[#B2B5BE] transition-colors hover:border-[#22C55E] hover:text-[#D1D4DC]">
                <span aria-hidden="true">+</span>
                <input
                    type="color"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    aria-label={`Choose custom ${label.toLowerCase()} color`}
                />
            </label>
        </div>
    );
}

function LineWidthControl({ value, onChange }: { value: LineWidth; onChange: (value: LineWidth) => void }) {
    const options: LineWidth[] = [1, 2, 3, 4];

    return (
        <div>
            <div className="mb-2 text-[12px] font-semibold text-[#8A97AA]">Line width</div>
            <div className="grid grid-cols-4 overflow-hidden rounded border border-[#2A2E39]">
                {options.map((option) => (
                    <button
                        key={option}
                        type="button"
                        onClick={() => onChange(option)}
                        className={[
                            'flex h-12 items-center justify-center border-r border-[#2A2E39] last:border-r-0',
                            value === option ? 'bg-[#131722] text-[#D1D4DC]' : 'bg-[#0B0B0D] text-[#6B7280] hover:text-[#B2B5BE]',
                        ].join(' ')}
                        title={`${option}px`}
                    >
                        <span
                            className="w-8 border-white"
                            style={{ borderTopWidth: `${option}px`, borderTopStyle: 'solid' }}
                        />
                    </button>
                ))}
            </div>
        </div>
    );
}

function IndicatorPickerContent({
    selectedIndicators,
    onSelectedIndicatorsChange,
    volumeMode,
    availableVolumeModes,
    volumePresent,
    vwapPresent,
    onVolumeModeSelect,
    onToggleCoreIndicator,
}: {
    selectedIndicators: string[];
    onSelectedIndicatorsChange: (ids: string[]) => void;
    volumeMode: VolumeMode;
    availableVolumeModes: VolumeMode[];
    volumePresent: boolean;
    vwapPresent: boolean;
    onVolumeModeSelect: (mode: VolumeMode) => void;
    onToggleCoreIndicator: (indicator: IndicatorKey) => void;
}) {
    const [query, setQuery] = useState('');
    const [favoriteIndicators, setFavoriteIndicators] = useState<string[]>(() => loadIndicatorFavorites());
    const normalizedQuery = query.trim().toLowerCase();
    const visibleIndicators = CHART_INDICATOR_CATALOG.filter((indicator) => {
        const requiredVolumeMode = volumeModeForIndicator(indicator.id);
        const modeAvailable = requiredVolumeMode === null || availableVolumeModes.includes(requiredVolumeMode);
        return modeAvailable && (
            !normalizedQuery || indicator.label.toLowerCase().includes(normalizedQuery) || indicator.id.toLowerCase().includes(normalizedQuery)
        );
    });
    const visibleFavoriteIndicators = visibleIndicators.filter((indicator) => favoriteIndicators.includes(indicator.id));
    const visibleOtherIndicators = visibleIndicators.filter((indicator) => !favoriteIndicators.includes(indicator.id));

    useEffect(() => {
        window.localStorage.setItem(CHART_INDICATOR_FAVORITES_STORAGE_KEY, JSON.stringify(favoriteIndicators));
    }, [favoriteIndicators]);

    const toggleIndicator = (id: string) => {
        const selectedVolumeMode = volumeModeForIndicator(id);
        if (selectedVolumeMode) {
            if (volumePresent && selectedVolumeMode === volumeMode) {
                onToggleCoreIndicator('volume');
            } else {
                onVolumeModeSelect(selectedVolumeMode);
            }
            return;
        }

        if (id === 'session_vwap') {
            onToggleCoreIndicator('vwap');
            return;
        }

        onSelectedIndicatorsChange([...selectedIndicators, nextIndicatorInstanceId(id, selectedIndicators)]);
    };

    const toggleFavorite = (id: string) => {
        setFavoriteIndicators((current) => current.includes(id)
            ? current.filter((favoriteId) => favoriteId !== id)
            : [...current, id]);
    };

    const renderIndicator = (indicator: ChartIndicatorCatalogItem) => {
        const selected = volumeModeForIndicator(indicator.id) !== null
            ? volumePresent && volumeModeForIndicator(indicator.id) === volumeMode
            : indicator.id === 'session_vwap'
                ? vwapPresent
                : selectedIndicators.some((instanceId) => baseIndicatorId(instanceId) === indicator.id);
        const favorite = favoriteIndicators.includes(indicator.id);

        return (
            <div
                key={indicator.id}
                className={[
                    'group flex w-full items-center gap-1 rounded px-1 py-0.5 transition-colors',
                    selected ? 'bg-[#131722] text-[#D1D4DC]' : 'text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]',
                ].join(' ')}
            >
                <button
                    type="button"
                    onClick={() => toggleFavorite(indicator.id)}
                    className={[
                        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors',
                        favorite ? 'text-[#DC2626]' : 'text-[#68707E] hover:bg-[#202532] hover:text-[#D1D4DC]',
                    ].join(' ')}
                    title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                    aria-label={favorite ? `Remove ${indicator.label} from favorites` : `Add ${indicator.label} to favorites`}
                    aria-pressed={favorite}
                >
                    <Star className="h-4 w-4" fill={favorite ? 'currentColor' : 'none'} strokeWidth={1.7} />
                </button>
                <button
                    type="button"
                    onClick={() => toggleIndicator(indicator.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left"
                >
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{indicator.label}</span>
                    <span className="text-[10px] text-[#5F6673]">{indicator.id}</span>
                </button>
            </div>
        );
    };

    return (
        <div className="overflow-hidden rounded-md bg-[#0B0B0D] font-sans">
            <div className="border-b border-[#1F2430] px-5 py-4">
                <div className="text-[18px] font-semibold tracking-tight text-[#D1D4DC]">Indicators</div>
                <div className="mt-1 text-[11px] text-[#787B86]">Choose indicators to calculate and display on the chart</div>
            </div>
            <div className="border-b border-[#1F2430] px-5 py-3">
                <label className="flex h-9 items-center gap-2 rounded border border-[#2A2E39] bg-[#111317] px-2.5 text-[#787B86] focus-within:border-[#22C55E]">
                    <Search className="h-4 w-4" />
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search indicators"
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-[#D1D4DC] outline-none placeholder:text-[#5F6673]"
                    />
                </label>
            </div>
            <div className="max-h-[480px] overflow-y-auto p-2">
                {visibleFavoriteIndicators.length > 0 && (
                    <>
                        <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-[#68707E]">Favorites</div>
                        {visibleFavoriteIndicators.map(renderIndicator)}
                        {visibleOtherIndicators.length > 0 && <div className="mx-2 my-2 border-t border-[#1F2430]" />}
                    </>
                )}
                {visibleOtherIndicators.length > 0 && (
                    <>
                        <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-[#68707E]">Chart indicators</div>
                        {visibleOtherIndicators.map(renderIndicator)}
                    </>
                )}
                {/* {visibleOtherIndicators.map((indicator) => {
                    const selected = volumeModeForIndicator(indicator.id) !== null
                        ? volumePresent && volumeModeForIndicator(indicator.id) === volumeMode
                        : indicator.id === 'session_vwap'
                            ? vwapPresent
                            : selectedIndicators.includes(indicator.id);
                    return (
                        <button
                            key={indicator.id}
                            type="button"
                            onClick={() => toggleIndicator(indicator.id)}
                            className={[
                                'flex w-full items-center gap-2 rounded px-2.5 py-2 text-left transition-colors',
                                selected ? 'bg-[#131722] text-[#D1D4DC]' : 'text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]',
                            ].join(' ')}
                        >
                            <span className={[
                                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold',
                                selected ? 'border-[#166534] bg-[#166534] text-white' : 'border-[#3A414E] text-transparent',
                            ].join(' ')}>
                                ✓
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{indicator.label}</span>
                            <span className="text-[10px] text-[#5F6673]">{indicator.id}</span>
                        </button>
                    );
                })} */}
                {visibleIndicators.length === 0 && (
                    <div className="px-2.5 py-8 text-center text-[12px] text-[#787B86]">No indicators found</div>
                )}
            </div>
            <div className="flex items-center justify-between border-t border-[#1F2430] px-5 py-3 text-[11px] text-[#787B86]">
                <span>{selectedIndicators.filter((id) => !isCoreChartIndicatorId(id)).length + (volumePresent ? 1 : 0) + (vwapPresent ? 1 : 0)} selected</span>
                <span>Calculated on chart</span>
            </div>
        </div>
    );
}

function ChartSettingsPanel({
    settings,
    onChange,
    onReset,
    onSaveConfiguration,
    onAccept,
}: {
    settings: ChartStyleSettings;
    onChange: <K extends keyof ChartStyleSettings>(key: K, value: ChartStyleSettings[K]) => void;
    onReset: () => void;
    onSaveConfiguration: () => void;
    onAccept: () => void;
}) {
    const [configurationMenuOpen, setConfigurationMenuOpen] = useState(false);

    return (
        <div className="max-h-[calc(100vh-2rem)] space-y-5 overflow-y-auto p-5 font-sans">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <div className="text-[18px] font-semibold tracking-tight text-[#D1D4DC]">Chart settings</div>
                    <div className="mt-1 text-[11px] text-[#787B86]">Visual appearance and session backgrounds</div>
                </div>
                <button
                    type="button"
                    onClick={onReset}
                    className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#2A2E39] bg-[#0B0B0D] text-[#787B86] transition-colors hover:border-[#22C55E] hover:text-[#D1D4DC]"
                    title="Reset chart configuration"
                >
                    <RotateCcw className="h-3.5 w-3.5" />
                </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <IndicatorColorPalette label="Bullish candles" value={settings.upColor} onChange={(value) => onChange('upColor', value)} />
                <IndicatorColorPalette label="Bearish candles" value={settings.downColor} onChange={(value) => onChange('downColor', value)} />
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-[#1F2430] pt-4">
                <IndicatorColorPalette label="Chart background" value={settings.backgroundColor} onChange={(value) => onChange('backgroundColor', value)} />
                <IndicatorColorPalette label="Grid color" value={settings.gridColor} onChange={(value) => onChange('gridColor', value)} />
                <RangeControl
                    label="Grid opacity"
                    value={settings.gridOpacity}
                    min={0}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => onChange('gridOpacity', value)}
                />
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-[#1F2430] pt-4">
                <IndicatorColorPalette label="PM background" value={settings.pmBackgroundColor} onChange={(value) => onChange('pmBackgroundColor', value)} />
                <IndicatorColorPalette label="AH background" value={settings.ahBackgroundColor} onChange={(value) => onChange('ahBackgroundColor', value)} />
                <RangeControl
                    label="PM opacity"
                    value={settings.pmBackgroundOpacity}
                    min={0}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => onChange('pmBackgroundOpacity', value)}
                />
                <RangeControl
                    label="AH opacity"
                    value={settings.ahBackgroundOpacity}
                    min={0}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => onChange('ahBackgroundOpacity', value)}
                />
            </div>

            <div className="space-y-3 border-t border-[#1F2430] pt-4">
                <RangeControl
                    label="Candle width"
                    value={settings.barSpacing}
                    min={4}
                    max={24}
                    step={1}
                    suffix="px"
                    onChange={(value) => onChange('barSpacing', value)}
                />
            </div>

            <div className="relative flex items-center justify-between gap-3 border-t border-[#1F2430] pt-4">
                <button
                    type="button"
                    onClick={() => setConfigurationMenuOpen((current) => !current)}
                    className="inline-flex h-10 items-center gap-2 rounded border border-[#2A2E39] bg-[#0B0B0D] px-3 text-[12px] font-medium text-[#B2B5BE] transition-colors hover:border-[#22C55E] hover:text-[#D1D4DC]"
                >
                    Default
                    {configurationMenuOpen
                        ? <ChevronUp className="h-3.5 w-3.5 text-[#9CA3AF]" />
                        : <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" />}
                </button>
                {configurationMenuOpen && (
                    <div className="absolute bottom-[calc(100%-2px)] left-0 z-10 min-w-[230px] overflow-hidden rounded-md border border-[#1F2430] bg-[#0B0B0D] p-1 shadow-[0_14px_34px_rgba(0,0,0,0.65)]">
                        <button
                            type="button"
                            onClick={() => {
                                onReset();
                                setConfigurationMenuOpen(false);
                            }}
                            className="block w-full rounded px-3 py-2.5 text-left text-[12px] font-medium text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]"
                        >
                            Reset configuration
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                onSaveConfiguration();
                                setConfigurationMenuOpen(false);
                            }}
                            className="block w-full rounded px-3 py-2.5 text-left text-[12px] font-medium text-[#B2B5BE] hover:bg-[#131722] hover:text-[#D1D4DC]"
                        >
                            Save as default
                        </button>
                    </div>
                )}
                <button
                    type="button"
                    onClick={onAccept}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-[#166534] px-6 text-[13px] font-semibold text-white shadow-[0_4px_14px_rgba(22,101,52,0.30)] transition-colors hover:bg-[#14532D]"
                >
                    Accept
                </button>
            </div>
        </div>
    );
}

function RangeControl({
    label,
    value,
    min,
    max,
    step,
    suffix,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix: string;
    onChange: (value: number) => void;
}) {
    return (
        <label className="block">
            <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-[10px] font-bold text-[#8A97AA]">{label}</span>
                <span className="font-mono text-[10px] text-[#E1E7EF]">{value}{suffix}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="h-2 w-full accent-[#DC2626]"
            />
        </label>
    );
}

function buildSessionBands(candles: BarCandle[], fallbackDate?: string, styleSettings: ChartStyleSettings = DEFAULT_CHART_STYLE_SETTINGS): SessionBand[] {
    const byDate = new Map<string, Partial<Record<'PM' | 'AH', { first: number; last: number }>>>();

    for (const candle of normalizeCandlesForChart(candles, fallbackDate ?? '')) {
        if (!Number.isFinite(candle.t) || candle.t <= 0) continue;
        const parts = getNyParts(candle.t);
        const session = classifySession(parts.minutes);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(parts.date) || (session !== 'PM' && session !== 'AH')) continue;

        const sessions = byDate.get(parts.date) ?? {};
        const existing = sessions[session];
        if (!existing) {
            sessions[session] = { first: candle.t, last: candle.t };
        } else {
            existing.first = Math.min(existing.first, candle.t);
            existing.last = Math.max(existing.last, candle.t);
        }
        byDate.set(parts.date, sessions);
    }

    if (byDate.size === 0) return [];

    const dates = Array.from(byDate.keys()).sort();

    return dates
        .flatMap((date) => (['PM', 'AH'] as const).flatMap((label) => {
            const sessions = byDate.get(date) ?? {};
            const span = sessions[label];
            if (!span) return [];
            const followingDate = nextCalendarDate(date);
            const followingPm = followingDate ? byDate.get(followingDate)?.PM : undefined;
            const connectsOvernight = label === 'AH' && Boolean(followingPm);
            return [{
                label,
                startTime: sessionBoundaryUnix(date, label, 'start'),
                endTime: connectsOvernight
                    ? sessionBoundaryUnix(followingDate, 'PM', 'start')
                    : sessionBoundaryUnix(date, label, 'end'),
                fallbackStartTime: span.first,
                fallbackEndTime: connectsOvernight && followingPm ? followingPm.first : span.last,
                color: sessionColor(label, styleSettings),
            }];
        }))
        .sort((a, b) => a.startTime - b.startTime);
}

function sessionBoundaryUnix(date: string, label: 'PM' | 'RTH' | 'AH', side: 'start' | 'end'): number {
    const [year, month, day] = date.split('-').map((part) => Number(part));
    const minutes =
        label === 'PM'
            ? side === 'start' ? 4 * 60 : 9 * 60 + 30
            : label === 'RTH'
                ? side === 'start' ? 9 * 60 + 30 : 16 * 60
                : side === 'start' ? 16 * 60 : 20 * 60;
    return nyLocalToUnixSec(year, month, day, Math.floor(minutes / 60), minutes % 60, 0);
}

function classifySession(total: number): 'PM' | 'RTH' | 'AH' | null {
    if (total >= 240 && total < 570) return 'PM';
    if (total >= 570 && total < 960) return 'RTH';
    if (total >= 960 && total <= 1185) return 'AH';
    return null;
}

function sessionColor(label: 'PM' | 'RTH' | 'AH', styleSettings: ChartStyleSettings = DEFAULT_CHART_STYLE_SETTINGS): string {
    if (label === 'PM') return hexToRgba(styleSettings.pmBackgroundColor, styleSettings.pmBackgroundOpacity / 100);
    if (label === 'RTH') return 'rgba(0,0,0,0)';
    return hexToRgba(styleSettings.ahBackgroundColor, styleSettings.ahBackgroundOpacity / 100);
}

function formatTimeframeLabel(timeframe: ChartTimeframe): string {
    if (timeframe === '30s') return '30s';
    if (timeframe === '15s') return '15s';
    if (timeframe === '10s') return '10s';
    if (timeframe === '5s') return '5s';
    if (timeframe === '3s') return '3s';
    if (timeframe === '1s') return '1s';
    if (timeframe === '1m') return '1min';
    if (timeframe === '2m') return '2min';
    if (timeframe === '3m') return '3min';
    if (timeframe === '5m') return '5min';
    if (timeframe === '10m') return '10min';
    if (timeframe === '15m') return '15min';
    if (timeframe === '30m') return '30min';
    return timeframe;
}

function formatChartTime(time: Time, timeframe: ChartTimeframe): string {
    const unix = typeof time === 'number' ? time : 0;
    const parts = getNyParts(unix);

    if (timeframe === '1D') {
        const month = parts.date.slice(5, 7);
        const day = parts.date.slice(8, 10);
        return `${month}-${day}`;
    }

    const hours = String(Math.floor(parts.minutes / 60)).padStart(2, '0');
    const minutes = String(parts.minutes % 60).padStart(2, '0');
    if (timeframe.endsWith('s')) {
        const seconds = NY_CLOCK_SECONDS_FORMATTER.formatToParts(new Date(unix * 1000)).find((part) => part.type === 'second')?.value ?? '00';
        return `${hours}:${minutes}:${seconds}`;
    }
    return `${hours}:${minutes}`;
}

type PlottedChartCandle = BarCandle & { t: number };

function calculateIndicatorSeries(
    id: string,
    candles: Array<PlottedChartCandle | (PlottedChartCandle & { synthetic: true })>,
    _sessionDate: string,
    parameters: IndicatorParameterSettings = defaultIndicatorParameters(id),
): Array<{ time: Time; value: number }> {
    if (candles.length === 0) return [];

    const baseId = baseIndicatorId(id);
    const period = indicatorPeriod(baseId, parameters);

    // EMA overlays are the default chart indicators. Avoid building every
    // other indicator input (ATR, rolling extremes, session keys, etc.) when
    // only one EMA series is requested.
    if (baseId === 'ema' || baseId === 'ema_9' || baseId === 'ema_20' || baseId === 'ema_30' || baseId === 'ema_50' || baseId === 'ema_200') {
        const closes = candles.map((candle) => Number(candle.close || 0));
        const emaPeriod = baseId === 'ema_9' ? 9
            : baseId === 'ema_20' ? 20
                : baseId === 'ema_30' ? 30
                    : baseId === 'ema_50' ? 50
                        : baseId === 'ema_200' ? 200
                            : period;
        return emaSeries(closes, emaPeriod).flatMap((value, index) => value !== null && Number.isFinite(value)
            ? [{ time: candles[index].t as Time, value }]
            : []);
    }

    const closes = candles.map((candle) => Number(candle.close || 0));
    const highs = candles.map((candle) => Number(candle.high || 0));
    const lows = candles.map((candle) => Number(candle.low || 0));
    const opens = candles.map((candle) => Number(candle.open || 0));
    const volumes = candles.map((candle) => Number(candle.volume || 0));
    const ema = emaSeries(closes, period);
    const ema9 = emaSeries(closes, 9);
    const ema20 = emaSeries(closes, 20);
    const ema30 = emaSeries(closes, 30);
    const ema50 = emaSeries(closes, 50);
    const ema200 = emaSeries(closes, 200);
    const sma = rollingMean(closes, period);
    const averageVolume = rollingMean(volumes, period);
    const atr = atrSeries(highs, lows, closes, period);
    const donchianUpper = rollingExtreme(highs, period, 'max');
    const donchianLower = rollingExtreme(lows, period, 'min');
    const sessionKeys = candles.map((candle) => {
        const parts = getNyParts(candle.t);
        return `${parts.date}:${classifySession(parts.minutes) ?? 'other'}`;
    });

    let values: Array<number | null>;
    switch (baseId) {
        case 'bar_open': values = opens; break;
        case 'bar_high': values = highs; break;
        case 'bar_low': values = lows; break;
        case 'bar_close':
        case 'close_price': values = closes; break;
        case 'volume': values = volumes; break;
        case 'volume_delta': values = candles.map((candle) => Number(candle.volumeDelta || 0)); break;
        case 'dollar_volume': values = volumes.map((value, index) => value * closes[index]); break;
        case 'session_vwap': values = candles.map((candle) => finiteOrNull(candle.vwap)); break;
        case 'ema': values = ema; break;
        case 'ema_9': values = ema9; break;
        case 'ema_20': values = candles.map((candle, index) => finiteOrNull((candle as PlottedChartCandle & { ema_20?: number }).ema_20) ?? ema20[index]); break;
        case 'ema_30': values = ema30; break;
        case 'ema_50': values = candles.map((candle, index) => finiteOrNull((candle as PlottedChartCandle & { ema_50?: number }).ema_50) ?? ema50[index]); break;
        case 'ema_200': values = ema200; break;
        case 'sma': values = sma; break;
        case 'ssma': values = emaSeries(ema, period); break;
        case 'atr': values = atr; break;
        case 'average_volume': values = averageVolume; break;
        case 'relative_volume': values = volumes.map((value, index) => averageVolume[index] ? value / averageVolume[index] : null); break;
        case 'bb_basis': values = sma; break;
        case 'bb_upper': values = bollingerSeries(closes, period, parameters.factor ?? 2, 'upper'); break;
        case 'bb_lower': values = bollingerSeries(closes, period, parameters.factor ?? 2, 'lower'); break;
        case 'donchian_upper': values = donchianUpper; break;
        case 'donchian_lower': values = donchianLower; break;
        case 'donchian_basis': values = donchianUpper.map((high, index) => high !== null && donchianLower[index] !== null ? (high + (donchianLower[index] as number)) / 2 : null); break;
        case 'supertrend': values = supertrendSeries(highs, lows, closes, atr, parameters.factor ?? 3); break;
        case 'fractal_high': values = fractalSeries(highs, 'high'); break;
        case 'fractal_low': values = fractalSeries(lows, 'low'); break;
        case 'bar_range_pct': values = closes.map((_, index) => opens[index] ? ((highs[index] - lows[index]) / Math.abs(opens[index])) * 100 : null); break;
        case 'body_range_pct': values = closes.map((_, index) => opens[index] ? (Math.abs(closes[index] - opens[index]) / Math.abs(opens[index])) * 100 : null); break;
        case 'upper_wick_pct': values = closes.map((_, index) => opens[index] ? ((highs[index] - Math.max(opens[index], closes[index])) / Math.abs(opens[index])) * 100 : null); break;
        case 'lower_wick_pct': values = closes.map((_, index) => opens[index] ? ((Math.min(opens[index], closes[index]) - lows[index]) / Math.abs(opens[index])) * 100 : null); break;
        case 'close_position_in_bar_range': values = closes.map((_, index) => highs[index] !== lows[index] ? ((closes[index] - lows[index]) / (highs[index] - lows[index])) * 100 : null); break;
        case 'time_of_day': values = candles.map((candle) => getNyParts(candle.t).minutes); break;
        case 'consecutive_green_bars': values = consecutiveSeries(closes.map((close, index) => close > opens[index])); break;
        case 'consecutive_red_bars': values = consecutiveSeries(closes.map((close, index) => close < opens[index])); break;
        case 'consecutive_volume_up': values = consecutiveSeries(volumes.map((volume, index) => index > 0 && volume > volumes[index - 1])); break;
        case 'consecutive_volume_down': values = consecutiveSeries(volumes.map((volume, index) => index > 0 && volume < volumes[index - 1])); break;
        case 'consecutive_higher_highs': values = consecutiveSeries(highs.map((high, index) => index > 0 && high > highs[index - 1])); break;
        case 'consecutive_lower_highs': values = consecutiveSeries(highs.map((high, index) => index > 0 && high < highs[index - 1])); break;
        case 'consecutive_higher_lows': values = consecutiveSeries(lows.map((low, index) => index > 0 && low > lows[index - 1])); break;
        case 'consecutive_lower_lows': values = consecutiveSeries(lows.map((low, index) => index > 0 && low < lows[index - 1])); break;
        case 'session_cumulative_volume': values = cumulativeByKey(volumes, sessionKeys); break;
        case 'pm_cumulative_volume': values = cumulativeBySession(volumes, sessionKeys, 'PM'); break;
        case 'rth_cumulative_volume': values = cumulativeBySession(volumes, sessionKeys, 'RTH'); break;
        case 'ah_cumulative_volume': values = cumulativeBySession(volumes, sessionKeys, 'AH'); break;
        case 'session_cumulative_dollar_volume': values = cumulativeByKey(volumes.map((value, index) => value * closes[index]), sessionKeys); break;
        case 'pm_cumulative_dollar_volume': values = cumulativeBySession(volumes.map((value, index) => value * closes[index]), sessionKeys, 'PM'); break;
        case 'rth_cumulative_dollar_volume': values = cumulativeBySession(volumes.map((value, index) => value * closes[index]), sessionKeys, 'RTH'); break;
        case 'ah_cumulative_dollar_volume': values = cumulativeBySession(volumes.map((value, index) => value * closes[index]), sessionKeys, 'AH'); break;
        case 'session_high_price': values = runningExtremeByKey(highs, sessionKeys, 'max'); break;
        case 'session_low_price': values = runningExtremeByKey(lows, sessionKeys, 'min'); break;
        case 'pm_high': values = runningExtremeBySession(highs, sessionKeys, 'PM', 'max'); break;
        case 'pm_low': values = runningExtremeBySession(lows, sessionKeys, 'PM', 'min'); break;
        case 'rth_high': values = runningExtremeBySession(highs, sessionKeys, 'RTH', 'max'); break;
        case 'rth_low': values = runningExtremeBySession(lows, sessionKeys, 'RTH', 'min'); break;
        case 'ah_high': values = runningExtremeBySession(highs, sessionKeys, 'AH', 'max'); break;
        case 'ah_low': values = runningExtremeBySession(lows, sessionKeys, 'AH', 'min'); break;
        case 'open_price': values = firstValueBySession(opens, sessionKeys, 'RTH'); break;
        case 'pm_open_price': values = firstValueBySession(opens, sessionKeys, 'PM'); break;
        case 'ah_open': values = firstValueBySession(opens, sessionKeys, 'AH'); break;
        case 'session_open_price': values = firstValueByKey(opens, sessionKeys); break;
        case 'first_bar_open': values = firstValueByKey(opens, sessionKeys); break;
        case 'first_bar_high': values = firstValueByKey(highs, sessionKeys); break;
        case 'first_bar_low': values = firstValueByKey(lows, sessionKeys); break;
        case 'first_bar_close': values = firstValueByKey(closes, sessionKeys); break;
        case 'previous_bar_open': values = opens.map((_, index) => index > 0 ? opens[index - 1] : null); break;
        case 'previous_bar_high': values = highs.map((_, index) => index > 0 ? highs[index - 1] : null); break;
        case 'previous_bar_low': values = lows.map((_, index) => index > 0 ? lows[index - 1] : null); break;
        case 'previous_bar_close': values = closes.map((_, index) => index > 0 ? closes[index - 1] : null); break;
        case 'previous_bar_volume': values = volumes.map((_, index) => index > 0 ? volumes[index - 1] : null); break;
        default: values = fallbackIndicatorSeries(baseId, candles, closes, highs, lows, volumes, sessionKeys, atr); break;
    }

    return values.flatMap((value, index) => value !== null && Number.isFinite(value)
        ? [{ time: candles[index].t as Time, value }]
        : []);
}

function indicatorPeriod(id: string, parameters?: IndicatorParameterSettings): number {
    const explicit = id.match(/(?:ema|sma|ssma)_(\d+)$/)?.[1];
    if (explicit) return Math.max(1, Number(explicit));
    if (parameters?.period !== undefined) return clampInteger(parameters.period, 1, 500, 20);
    return 20;
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rollingMean(values: number[], period: number): Array<number | null> {
    return values.map((_, index) => index + 1 < period ? null : values.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0) / period);
}

function emaSeries(values: Array<number | null>, period: number): Array<number | null> {
    if (values.length === 0) return [];
    const alpha = 2 / (period + 1);
    let previous: number | null = null;
    return values.map((value, index) => {
        const numericValue = value ?? 0;
        previous = previous === null ? numericValue : (numericValue * alpha) + (previous * (1 - alpha));
        return index + 1 < period ? null : previous;
    });
}

function atrSeries(highs: number[], lows: number[], closes: number[], period: number): Array<number | null> {
    const trueRanges = highs.map((high, index) => index === 0 ? high - lows[index] : Math.max(high - lows[index], Math.abs(high - closes[index - 1]), Math.abs(lows[index] - closes[index - 1])));
    return rollingMean(trueRanges, period);
}

function bollingerSeries(values: number[], period: number, factor: number, side: 'upper' | 'lower'): Array<number | null> {
    return values.map((_, index) => {
        if (index + 1 < period) return null;
        const window = values.slice(index - period + 1, index + 1);
        const mean = window.reduce((sum, value) => sum + value, 0) / period;
        const deviation = Math.sqrt(window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / period);
        return side === 'upper' ? mean + deviation * factor : mean - deviation * factor;
    });
}

function rollingExtreme(values: number[], period: number, mode: 'max' | 'min'): Array<number | null> {
    return values.map((_, index) => {
        if (index + 1 < period) return null;
        const window = values.slice(index - period + 1, index + 1);
        return mode === 'max' ? Math.max(...window) : Math.min(...window);
    });
}

function supertrendSeries(highs: number[], lows: number[], closes: number[], atr: Array<number | null>, factor: number): Array<number | null> {
    return closes.map((close, index) => {
        const range = atr[index];
        if (range === null) return null;
        const midpoint = (highs[index] + lows[index]) / 2;
        return close >= midpoint ? midpoint - range * factor : midpoint + range * factor;
    });
}

function fractalSeries(values: number[], mode: 'high' | 'low'): Array<number | null> {
    return values.map((value, index) => {
        if (index < 2 || index + 2 >= values.length) return null;
        const window = values.slice(index - 2, index + 3);
        const extreme = mode === 'high' ? Math.max(...window) : Math.min(...window);
        return value === extreme ? value : null;
    });
}

function consecutiveSeries(flags: boolean[]): number[] {
    let count = 0;
    return flags.map((flag) => {
        count = flag ? count + 1 : 0;
        return count;
    });
}

function cumulativeByKey(values: number[], keys: string[]): number[] {
    const totals = new Map<string, number>();
    return values.map((value, index) => {
        const key = keys[index];
        const total = (totals.get(key) ?? 0) + value;
        totals.set(key, total);
        return total;
    });
}

function cumulativeBySession(values: number[], keys: string[], session: string): Array<number | null> {
    const totals = new Map<string, number>();
    return values.map((value, index) => {
        if (!keys[index].endsWith(`:${session}`)) return null;
        const total = (totals.get(keys[index]) ?? 0) + value;
        totals.set(keys[index], total);
        return total;
    });
}

function runningExtremeByKey(values: number[], keys: string[], mode: 'max' | 'min'): number[] {
    const extremes = new Map<string, number>();
    return values.map((value, index) => {
        const key = keys[index];
        const current = extremes.get(key);
        const next = current === undefined ? value : mode === 'max' ? Math.max(current, value) : Math.min(current, value);
        extremes.set(key, next);
        return next;
    });
}

function runningExtremeBySession(values: number[], keys: string[], session: string, mode: 'max' | 'min'): Array<number | null> {
    return runningExtremeByKey(values, keys, mode).map((value, index) => keys[index].endsWith(`:${session}`) ? value : null);
}

function firstValueByKey(values: number[], keys: string[]): number[] {
    const first = new Map<string, number>();
    return values.map((value, index) => {
        if (!first.has(keys[index])) first.set(keys[index], value);
        return first.get(keys[index]) as number;
    });
}

function firstValueBySession(values: number[], keys: string[], session: string): Array<number | null> {
    const first = new Map<string, number>();
    return values.map((value, index) => {
        if (!keys[index].endsWith(`:${session}`)) return null;
        if (!first.has(keys[index])) first.set(keys[index], value);
        return first.get(keys[index]) as number;
    });
}

function fallbackIndicatorSeries(
    id: string,
    candles: PlottedChartCandle[],
    closes: number[],
    highs: number[],
    lows: number[],
    volumes: number[],
    sessionKeys: string[],
    atr: Array<number | null>,
): Array<number | null> {
    if (id.includes('volume')) return cumulativeByKey(volumes, sessionKeys);
    if (id.includes('high')) return runningExtremeByKey(highs, sessionKeys, 'max');
    if (id.includes('low')) return runningExtremeByKey(lows, sessionKeys, 'min');
    if (id.includes('bars_since')) return barsSinceSeries(closes, id.includes('high') ? highs : lows, id.includes('high') ? 'max' : 'min');
    if (id.includes('time')) return candles.map((candle) => getNyParts(candle.t).minutes);
    if (id.endsWith('_pct') || id.includes('return') || id.includes('change')) return closes.map((close, index) => index === 0 || closes[index - 1] === 0 ? null : ((close / closes[index - 1]) - 1) * 100);
    if (id.includes('atr')) return atr;
    return closes;
}

function barsSinceSeries(closes: number[], reference: number[], mode: 'max' | 'min'): number[] {
    let extreme = mode === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    let bars = 0;
    return closes.map((_, index) => {
        const value = reference[index];
        const improved = mode === 'max' ? value >= extreme : value <= extreme;
        if (improved) {
            extreme = value;
            bars = 0;
        } else {
            bars += 1;
        }
        return bars;
    });
}

function volumeValue(candle: BarCandle, mode: VolumeMode): number {
    if (mode === 'delta') return Number(candle.volumeDelta || 0);
    if (mode === 'dollar') return Number(candle.close || 0) * Number(candle.volume || 0);
    return Number(candle.volume || 0);
}

function volumeIndicatorLabel(mode: VolumeMode): string {
    if (mode === 'delta') return 'Vol. Δ';
    if (mode === 'dollar') return '$ Vol.';
    return 'Vol.';
}

function volumeModeForIndicator(id: string): VolumeMode | null {
    const baseId = baseIndicatorId(id);
    if (baseId === 'volume') return 'volume';
    if (baseId === 'volume_delta') return 'delta';
    if (baseId === 'dollar_volume') return 'dollar';
    return null;
}

function isVolumeIndicatorId(id: string): boolean {
    return volumeModeForIndicator(id) !== null;
}

function isCoreChartIndicatorId(id: string): boolean {
    return isVolumeIndicatorId(id) || baseIndicatorId(id) === 'session_vwap';
}

function formatIndicatorValue(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const absolute = Math.abs(value);
    const suffix = absolute >= 1_000_000_000 ? 'B' : absolute >= 1_000_000 ? 'M' : absolute >= 1_000 ? 'K' : '';
    const divisor = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
    const formatted = (value / divisor).toLocaleString('de-DE', {
        maximumFractionDigits: suffix ? 2 : 0,
    });
    return `${formatted}${suffix}`;
}

function formatPriceIndicator(value: number): string {
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

function formatChartIndicatorValue(id: string, value: number): string {
    const definition = chartIndicatorDefinition(id);
    if (definition?.valueType === 'volume') return formatIndicatorValue(value);
    if (definition?.valueType === 'percent') return `${value.toLocaleString('de-DE', { maximumFractionDigits: 2 })}%`;
    if (definition?.valueType === 'time') {
        const minutes = Math.max(0, Math.round(value));
        return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
    if (definition?.valueType === 'number') return value.toLocaleString('de-DE', { maximumFractionDigits: 2 });
    return formatPriceIndicator(value);
}

function volumeColor(candle: BarCandle, mode: VolumeMode, settings: ChartStyleSettings): string {
    if (mode === 'delta') {
        const delta = Number(candle.volumeDelta || 0);
        if (delta > 0) return settings.volumeUpColor;
        if (delta < 0) return settings.volumeDownColor;
        return '#64748B';
    }
    return candle.close >= candle.open ? settings.volumeUpColor : settings.volumeDownColor;
}

function getNyParts(unix: number): { date: string; minutes: number } {
    const parts = NY_PARTS_FORMATTER.formatToParts(new Date(unix * 1000));
    const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

    return {
        date: `${year}-${month}-${day}`,
        minutes: (hour * 60) + minute,
    };
}
