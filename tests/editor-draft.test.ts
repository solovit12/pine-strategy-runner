import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEditorDraft, readPaperDraft, writeEditorDraft, writePaperDraft, type EditorDraft, type PaperDraft } from '../apps/web/src/lib/editor-draft';

const editor: EditorDraft = {
  source: '//@version=6\nstrategy("Mine")', symbol: 'ETHUSDT', timeframe: '15m', startDate: '2026-09-01', endDate: '2026-10-01',
  initialCapital: 5000, defaultOrderSizeValue: 2, defaultOrderSizeType: 'percent_of_equity', pyramiding: 3,
  commissionValueInput: '0.05', longLeverage: '5×', shortLeverage: 'Auto', slippagePercent: 0.1, processOrdersOnClose: true,
  strategyName: 'Mine', strategyId: 'strategy-1',
};
const paper: PaperDraft = {
  strategyId: null, kind: 'pine', pythonRef: '', paramText: {}, timeframe: '5m',
  tracks: { Hyperliquid: ['BTC', 'xyz:NVDA'], Lighter: ['ETH'] }, capital: '2500', orderSize: '20',
  fees: { hyperliquidMakerFeePercent: '0.015', hyperliquidTakerFeePercent: '0.045', lighterMakerFeePercent: '0', lighterTakerFeePercent: '0' },
};

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, items };
}

afterEach(() => vi.unstubAllGlobals());

describe('Strategy page draft', () => {
  it('keeps the editor and Paper settings across a reload', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    writeEditorDraft(editor);
    writePaperDraft(paper);
    expect(readEditorDraft()).toEqual(editor);
    expect(readPaperDraft()).toEqual(paper);
  });

  it('ignores a damaged or outdated draft instead of breaking the page', () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    storage.items.set('psr.editorDraft.v1', '{not json');
    storage.items.set('psr.paperDraft.v1', JSON.stringify({ ...paper, timeframe: '2h' }));
    expect(readEditorDraft()).toBeNull();
    expect(readPaperDraft()).toBeNull();
  });

  it('works without browser storage (blocked or private window)', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } } });
    expect(() => writeEditorDraft(editor)).not.toThrow();
    expect(readEditorDraft()).toBeNull();
  });
});
