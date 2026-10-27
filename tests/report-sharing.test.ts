import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server';
import {
  BACKTEST_RUN_COLUMNS, SHEET_FORMAT_VERSION, parseGoogleRobotKey, sheetFormatRequests, spreadsheetIdFrom, telegramChatId, telegramMessageUrl,
} from '../apps/api/src/report-sharing';
import { BACKTEST_RUNS_SHEET, type BacktestReport } from '../packages/shared/src/report-contracts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const robotEmail = 'svit-runner@project.iam.gserviceaccount.com';
const robotKey = JSON.stringify({ type: 'service_account', client_email: robotEmail,
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://evil.example/token' });
const spreadsheetId = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const botToken = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

const report: BacktestReport = {
  runId: 'run-1', backtestedAt: '2026-10-27T12:34:56.000Z', strategyName: '=VWAP Trend', strategyVersion: 3, strategyEdited: false,
  sourceUrl: 'https://www.tradingview.com/script/xXSfnBVz-VWAP-Trend-Strategy-Intraday-KedarArc-Quant/',
  dataSource: 'Binance Futures', symbol: 'BTCUSDT', timeframe: '15m', dateRange: { start: '2026-07-01', end: '2026-10-26' }, bars: 11_136,
  currency: 'USDT',
  metrics: { initialCapital: 10_000, endingEquity: 11_234.5, netProfit: 1_200, openProfit: 34.5, totalProfit: 1_234.5, totalProfitPercent: 12.345,
    totalTrades: 87, winRatePercent: 54.02, maxDrawdown: 812.3, maxDrawdownPercent: 7.41, profitFactor: 1.4234, averageTrade: 13.79,
    longTrades: 50, shortTrades: 37, commissionPaid: 87.1 },
  settings: { orderSizeValue: 10, orderSizeType: 'percent_of_equity', pyramiding: 1, commissionType: 'percent', commissionValue: 0.05,
    slippagePercent: 0.2, marginLongPercent: 5, marginShortPercent: 0, barDetailization: 'high', processOrdersOnClose: false },
  warnings: [],
};

/** Google (token + Sheets) and Telegram, in memory. */
function fakeServices(options: { robotHasAccess?: boolean; sheetsApiOff?: boolean; botIsAdmin?: boolean } = {}) {
  interface FakeSheet { sheetId: number; rows: (string | number)[][]; rules: number; bands: number[]; format: string | null; styled: number }
  const sheets = new Map<string, FakeSheet>([['Sheet1', { sheetId: 0, rows: [], rules: 0, bands: [], format: null, styled: 0 }]]);
  const byId = (sheetId: number) => [...sheets.values()].find((sheet) => sheet.sheetId === sheetId)!;
  const posts: { chatId: string; caption: string; bytes: number }[] = [];
  const calls: string[] = [];
  let tokens = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const range = (text: string) => {
    const whole = /^'(.+)'$/.exec(decodeURIComponent(text));
    if (whole) return { sheet: whole[1]!.replaceAll('\'\'', '\''), column: 0, row: null, whole: true };
    const match = /^'(.+)'!([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/.exec(decodeURIComponent(text))!;
    return { sheet: match[1]!.replaceAll('\'\'', '\''), column: [...match[2]!].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1,
      row: match[3] ? Number(match[3]) : null, whole: false };
  };
  const http = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? 'GET'} ${url.host}${url.pathname.replace(botToken, '<token>')}`);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
      const [header, claims, signature] = assertion.split('.');
      const valid = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature!, 'base64url');
      const body = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { iss: string; scope: string; aud: string };
      if (!valid || body.iss !== robotEmail || body.aud !== 'https://oauth2.googleapis.com/token') return json({ error_description: 'Invalid JWT' }, 400);
      tokens += 1;
      return json({ access_token: 'google-token', expires_in: 3600 });
    }
    if (url.host === 'sheets.googleapis.com') {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer google-token');
      if (options.robotHasAccess === false) return json({ error: { message: 'The caller does not have permission' } }, 403);
      if (options.sheetsApiOff) {
        return json({ error: { message: 'Google Sheets API has not been used in project 123 before or it is disabled.',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }, 403);
      }
      const [, , , id, rest = ''] = url.pathname.split('/');
      const [spreadsheet, action] = id!.split(':');
      if (spreadsheet !== spreadsheetId) return json({ error: { message: 'Not found' } }, 404);
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      if (action === 'batchUpdate') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const replies = (body!.requests as any[]).map((request) => {
          if (request.addSheet) {
            const sheetId = sheets.size * 100;
            sheets.set(request.addSheet.properties.title, { sheetId, rows: [], rules: 0, bands: [], format: null, styled: 0 });
            return { addSheet: { properties: { sheetId } } };
          }
          if (request.moveDimension) {
            const { source: { sheetId, startIndex }, destinationIndex } = request.moveDimension;
            const { rows } = byId(sheetId);
            for (const row of rows) {
              while (row.length < rows[0]!.length) row.push(''); // empty cells exist in a real sheet
              row.splice(destinationIndex, 0, ...row.splice(startIndex, 1));
            }
          }
          if (request.addConditionalFormatRule) byId(request.addConditionalFormatRule.rule.ranges[0].sheetId).rules += 1;
          if (request.deleteConditionalFormatRule) byId(request.deleteConditionalFormatRule.sheetId).rules -= 1;
          if (request.addBanding) byId(request.addBanding.bandedRange.range.sheetId).bands.push(Math.floor(Math.random() * 1e9));
          if (request.deleteBanding) for (const sheet of sheets.values()) sheet.bands = sheet.bands.filter((id) => id !== request.deleteBanding.bandedRangeId);
          if (request.setBasicFilter) byId(request.setBasicFilter.filter.range.sheetId).styled += 1;
          if (request.createDeveloperMetadata) {
            byId(request.createDeveloperMetadata.developerMetadata.location.sheetId).format = request.createDeveloperMetadata.developerMetadata.metadataValue;
          }
          if (request.updateDeveloperMetadata) {
            const sheet = [...sheets.values()].find((item) => item.sheetId + 7 === request.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId)!;
            sheet.format = request.updateDeveloperMetadata.developerMetadata.metadataValue;
          }
          return {};
        });
        return json({ replies });
      }
      if (!rest) {
        expect(url.searchParams.get('fields')).toContain('developerMetadata');
        return json({ properties: { title: 'Svit journal' }, sheets: [...sheets].map(([title, sheet]) => ({
          properties: { title, sheetId: sheet.sheetId }, conditionalFormats: Array.from({ length: sheet.rules }, () => ({})),
          bandedRanges: sheet.bands.map((bandedRangeId) => ({ bandedRangeId })),
          developerMetadata: sheet.format === null ? [] : [{ metadataId: sheet.sheetId + 7, metadataKey: 'svitRunnerSheetFormat', metadataValue: sheet.format }],
        })) });
      }
      const [encodedRange, append] = url.pathname.split('/values/')[1]!.split(':');
      const target = range(encodedRange!);
      const sheet = sheets.get(target.sheet)!;
      if (append === 'append') {
        expect(url.searchParams.get('valueInputOption')).toBe('RAW');
        expect(url.searchParams.get('insertDataOption')).toBe('OVERWRITE');
        sheet.rows.push((body!.values as (string | number)[][])[0]!);
        return json({ updates: { updatedRange: `'${target.sheet}'!A${sheet.rows.length}:AJ${sheet.rows.length}` } });
      }
      if (init.method === 'PUT') {
        const row = target.row ?? 1;
        sheet.rows[row - 1] ??= [];
        (body!.values as (string | number)[][])[0]!.forEach((value, index) => { sheet.rows[row - 1]![target.column + index] = value; });
        return json({});
      }
      if (target.row === 1 && decodeURIComponent(encodedRange!).endsWith('1:1')) return json(sheet.rows[0] ? { values: [sheet.rows[0]] } : {});
      expect(target.whole).toBe(true);
      expect(url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
      // Like Google: trailing empty cells are left out.
      return json({ values: sheet.rows.map((row) => { const copy = [...row]; while (copy.length && copy.at(-1) === '') copy.pop(); return copy; }) });
    }
    if (url.host === 'api.telegram.org') {
      if (!url.pathname.startsWith(`/bot${botToken}/`)) return json({ ok: false, description: 'Unauthorized' }, 401);
      const method = url.pathname.split('/').pop();
      if (method === 'getMe') return json({ ok: true, result: { id: 42, username: 'svit_runner_bot' } });
      if (method === 'getChat') return json({ ok: true, result: { id: -1001234567890, title: 'Svit Runner', username: 'svitrunner', type: 'channel' } });
      if (method === 'getChatMember') {
        return json({ ok: true, result: options.botIsAdmin === false ? { status: 'member' } : { status: 'administrator', can_post_messages: true } });
      }
      if (method === 'sendPhoto') {
        const form = init.body as FormData;
        const photo = form.get('photo') as Blob;
        posts.push({ chatId: String(form.get('chat_id')), caption: String(form.get('caption')), bytes: photo.size });
        return json({ ok: true, result: { message_id: 17, chat: { id: -1001234567890, username: 'svitrunner', type: 'channel' } } });
      }
    }
    throw new Error(`Unexpected request ${url.href}`);
  };
  return { http: http as typeof fetch, sheets, posts, calls, tokens: () => tokens };
}

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function app(services: ReturnType<typeof fakeServices>, edition: 'full' | 'public' = 'full') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'psr-reports-'));
  directories.push(root);
  const realFetch = globalThis.fetch;
  globalThis.fetch = services.http;
  const built = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: null, reportSecretsDir: path.join(root, 'report-secrets'), edition });
  built.addHook('onClose', async () => { globalThis.fetch = realFetch; });
  return { app: built, secrets: path.join(root, 'report-secrets') };
}

describe('report helpers', () => {
  it('reads the sheet link, the channel and the robot key', () => {
    expect(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0`)).toBe(spreadsheetId);
    expect(spreadsheetIdFrom(spreadsheetId)).toBe(spreadsheetId);
    expect(() => spreadsheetIdFrom('https://example.com/sheet')).toThrow('Paste the sheet');
    expect(telegramChatId('@svitrunner')).toBe('@svitrunner');
    expect(telegramChatId('https://t.me/svitrunner')).toBe('@svitrunner');
    expect(telegramChatId('-1001234567890')).toBe('-1001234567890');
    expect(() => telegramChatId('https://t.me/+AbCdEf')).toThrow('@name');
    expect(parseGoogleRobotKey(robotKey).clientEmail).toBe(robotEmail);
    expect(() => parseGoogleRobotKey('{"type":"authorized_user"}')).toThrow('not a robot account key');
    expect(() => parseGoogleRobotKey('nope')).toThrow('not JSON');
    expect(telegramMessageUrl({ id: -1001234567890, type: 'channel' }, 5)).toBe('https://t.me/c/1234567890/5');
  });

  it('describes the run in one row', () => {
    const row = Object.fromEntries(BACKTEST_RUN_COLUMNS.map((column) => [column.header, column.value(report)]));
    expect(row).toMatchObject({
      'Стратегия': '=VWAP Trend', 'Версия': 3, 'Источник': report.sourceUrl, 'Рынок': 'BTCUSDT', 'Дней': 118, 'Итог, %': 12.35,
      'Profit factor': 1.423, 'Размер сделки': '10 % капитала', 'Комиссия за исполнение': '0.05 %', 'Ухудшение цены, %': 0.2,
      'Плечо лонг / шорт': 'x20 / без ограничения', 'Детализация': 'каждая минута', 'Run ID': 'run-1',
    });
  });
});

describe('report routes', () => {
  it('connects the sheet with the robot key, adds a run once and keeps the key out of every answer', async () => {
    const services = fakeServices();
    const { app: server, secrets } = await app(services);
    try {
      expect((await server.inject({ method: 'GET', url: '/api/reports/settings' })).json().google.connected).toBe(false);
      const early = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report });
      expect(early.statusCode).toBe(409);

      const saved = await server.inject({ method: 'PUT', url: '/api/reports/google',
        payload: { sheet: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, serviceAccountKey: robotKey } });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().google).toEqual({ connected: true, robotEmail, spreadsheetTitle: 'Svit journal',
        sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
      expect(saved.body).not.toContain('PRIVATE KEY');
      const sheet = services.sheets.get(BACKTEST_RUNS_SHEET)!;
      expect(sheet.rows[0]).toEqual(BACKTEST_RUN_COLUMNS.map((column) => column.header));
      // Styled once: 4 colored columns with 2 rules each, one band, the look's version on the sheet.
      expect(sheet).toMatchObject({ rules: 8, format: SHEET_FORMAT_VERSION, styled: 1 });
      expect(sheet.bands).toHaveLength(1);
      expect((await stat(secrets)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(secrets, 'google-robot-key.json'))).mode & 0o777).toBe(0o600);
      // Google's own token address, whatever the key file says.
      expect(services.calls).not.toContain('POST evil.example/token');

      const added = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report });
      expect(added.statusCode, added.body).toBe(200);
      expect(added.json()).toEqual({ status: 'added', row: 2, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=100&range=A2` });
      expect(sheet.rows[1]![1]).toBe('=VWAP Trend'); // written as text, never as a formula
      const again = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report });
      expect(again.json()).toMatchObject({ status: 'already', row: 2 });
      expect(sheet.rows).toHaveLength(2);
      expect(services.tokens()).toBe(1);
      expect(sheet.styled).toBe(1); // not restyled on every press

      // The owner moved a column: rows still land under the right headers.
      sheet.rows[0] = [...sheet.rows[0]!.slice(1), sheet.rows[0]![0]!];
      sheet.rows[1] = [...sheet.rows[1]!.slice(1), sheet.rows[1]![0]!];
      // A new run of the same test (later, with another link and library version) is the same row.
      const rerun = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: { ...report, runId: 'run-2',
        backtestedAt: '2026-10-27T18:02:00.000Z', strategyVersion: 4, sourceUrl: 'https://www.tradingview.com/script/other/' } });
      expect(rerun.json()).toMatchObject({ status: 'same-test', row: 2 });
      expect(sheet.rows).toHaveLength(2);
      const other = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: { ...report, runId: 'run-3',
        dateRange: { start: '2026-07-02', end: '2026-10-26' } } });
      expect(other.json()).toMatchObject({ status: 'added', row: 3 });
      expect(sheet.rows[2]!.at(-1)).toBe('2026-10-27 12:34');

      const missingSource = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: { ...report, sourceUrl: '' } });
      expect(missingSource.statusCode).toBe(400);
      expect(missingSource.json().error).toContain('sourceUrl');
      const crossSite = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report,
        headers: { origin: 'https://evil.example', host: 'localhost' } });
      expect(crossSite.statusCode).toBe(403);
    } finally { await server.close(); }
  });

  it('puts a sheet made before the new look into our column order once, data moving with its headers', async () => {
    const services = fakeServices();
    const oldOrder = ['Дата бэктеста (UTC)', 'Стратегия', 'Версия', 'Источник', 'Данные', 'Рынок', 'Таймфрейм', 'С (UTC)', 'По (UTC)', 'Дней', 'Итог, %'];
    services.sheets.set(BACKTEST_RUNS_SHEET, { sheetId: 300, rows: [[...oldOrder], oldOrder.map((header) => `v:${header}`)], rules: 2, bands: [5], format: null, styled: 0 });
    const { app: server } = await app(services);
    try {
      await server.inject({ method: 'PUT', url: '/api/reports/google', payload: { sheet: spreadsheetId, serviceAccountKey: robotKey } });
      const sheet = services.sheets.get(BACKTEST_RUNS_SHEET)!;
      const headers = BACKTEST_RUN_COLUMNS.map((column) => column.header);
      expect(sheet.rows[0]).toEqual(headers);
      expect(sheet.rows[1]!.slice(0, 4)).toEqual(['v:Дата бэктеста (UTC)', 'v:Стратегия', 'v:Источник', 'v:Рынок']);
      expect(sheet.rows[1]![headers.indexOf('Версия')]).toBe('v:Версия');
      expect(sheet).toMatchObject({ rules: 8, format: SHEET_FORMAT_VERSION });
      expect(sheet.bands).toHaveLength(1);
      const added = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report });
      expect(added.json()).toMatchObject({ status: 'added', row: 3 });
      expect(sheet.rows[2]![headers.indexOf('Источник')]).toBe(report.sourceUrl);
      expect(sheet.styled).toBe(1);
    } finally { await server.close(); }
  });

  it('still writes the row when Google refuses the look, and says so', async () => {
    const services = fakeServices();
    const http = services.http;
    services.http = (async (input: string | URL | Request, init: RequestInit = {}) => String(init.body ?? '').includes('setBasicFilter')
      ? new Response(JSON.stringify({ error: { message: 'Invalid requests[3].setBasicFilter' } }), { status: 400 })
      : http(input, init)) as typeof fetch;
    const { app: server } = await app(services);
    try {
      await server.inject({ method: 'PUT', url: '/api/reports/google', payload: { sheet: spreadsheetId, serviceAccountKey: robotKey } });
      const added = await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report });
      expect(added.json()).toMatchObject({ status: 'added', row: 2, styleError: expect.stringContaining('setBasicFilter') });
      expect(services.sheets.get(BACKTEST_RUNS_SHEET)!.format).toBeNull();
    } finally { await server.close(); }
  });

  it('styles the header per group, hides the run id and colors results', () => {
    const headers = BACKTEST_RUN_COLUMNS.map((column) => column.header);
    const { requests } = sheetFormatRequests(9, headers, { conditionalRules: 0, bandIds: [] });
    const text = JSON.stringify(requests);
    expect(text).toContain('"frozenRowCount":1,"frozenColumnCount":2');
    expect(text).toContain('"pattern":"+0.00\\" %\\";-0.00\\" %\\";0.00\\" %\\""');
    const hidden = requests.filter((request) => JSON.stringify(request).includes('"hiddenByUser":true'));
    expect(hidden).toHaveLength(1);
    expect(JSON.stringify(hidden[0])).toContain(`"startIndex":${headers.indexOf('Run ID')}`);
    expect(requests.filter((request) => 'moveDimension' in request)).toHaveLength(0);
  });

  it('explains a sheet the robot cannot open and a switched-off Sheets API', async () => {
    const { app: server } = await app(fakeServices({ robotHasAccess: false }));
    try {
      const saved = await server.inject({ method: 'PUT', url: '/api/reports/google', payload: { sheet: spreadsheetId, serviceAccountKey: robotKey } });
      expect(saved.statusCode).toBe(403);
      expect(saved.json().error).toContain(`add ${robotEmail} and choose Editor`);
      expect((await server.inject({ method: 'GET', url: '/api/reports/settings' })).json().google.connected).toBe(false);
    } finally { await server.close(); }
    const apiOff = await app(fakeServices({ sheetsApiOff: true }));
    try {
      const saved = await apiOff.app.inject({ method: 'PUT', url: '/api/reports/google', payload: { sheet: spreadsheetId, serviceAccountKey: robotKey } });
      expect(saved.statusCode).toBe(403);
      expect(saved.json().error).toContain('Sheets API is switched off');
      expect(saved.json().error).toContain('sheets.googleapis.com?project=project,');
    } finally { await apiOff.app.close(); }
  });

  it('connects the channel only when the bot may post, posts the picture and writes the post link into the run row', async () => {
    const notAdmin = await app(fakeServices({ botIsAdmin: false }));
    try {
      const refused = await notAdmin.app.inject({ method: 'PUT', url: '/api/reports/telegram', payload: { channel: '@svitrunner', botToken } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toContain('Make @svit_runner_bot an administrator');
    } finally { await notAdmin.app.close(); }

    const services = fakeServices();
    const { app: server, secrets } = await app(services);
    try {
      const wrongToken = await server.inject({ method: 'PUT', url: '/api/reports/telegram',
        payload: { channel: 't.me/svitrunner', botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsXX' } });
      expect(wrongToken.json().error).toContain('did not accept the bot token');
      const saved = await server.inject({ method: 'PUT', url: '/api/reports/telegram', payload: { channel: 't.me/svitrunner', botToken } });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().telegram).toEqual({ connected: true, channelTitle: 'Svit Runner', channel: '@svitrunner', botUsername: 'svit_runner_bot' });
      expect(saved.body).not.toContain(botToken);
      expect(JSON.parse(await readFile(path.join(secrets, 'telegram.json'), 'utf8')).botToken).toBe(botToken);

      const post = { report, caption: 'Бэктест: VWAP Trend', imagePngBase64: png.toString('base64') };
      const onlyTelegram = await server.inject({ method: 'POST', url: '/api/reports/backtests/telegram', payload: post });
      expect(onlyTelegram.json()).toEqual({ messageUrl: 'https://t.me/svitrunner/17', sheet: null, sheetError: null });
      expect(services.posts).toEqual([{ chatId: '-1001234567890', caption: 'Бэктест: VWAP Trend', bytes: png.length }]);

      await server.inject({ method: 'PUT', url: '/api/reports/google', payload: { sheet: spreadsheetId, serviceAccountKey: robotKey } });
      await server.inject({ method: 'POST', url: '/api/reports/backtests/sheet', payload: report });
      const both = await server.inject({ method: 'POST', url: '/api/reports/backtests/telegram', payload: post });
      expect(both.json()).toMatchObject({ messageUrl: 'https://t.me/svitrunner/17', sheet: { status: 'already', row: 2 } });
      const rows = services.sheets.get(BACKTEST_RUNS_SHEET)!.rows;
      expect(rows[1]![rows[0]!.indexOf('Пост в Telegram')]).toBe('https://t.me/svitrunner/17');
      // A post of a run not yet in the sheet adds its row with the link.
      const fresh = await server.inject({ method: 'POST', url: '/api/reports/backtests/telegram', payload: { ...post, report: { ...report, runId: 'run-9', symbol: 'ETHUSDT' } } });
      expect(fresh.json().sheet).toMatchObject({ status: 'added', row: 3 });
      expect(rows[2]![rows[0]!.indexOf('Пост в Telegram')]).toBe('https://t.me/svitrunner/17');

      const notPng = await server.inject({ method: 'POST', url: '/api/reports/backtests/telegram',
        payload: { ...post, imagePngBase64: Buffer.alloc(200, 1).toString('base64') } });
      expect(notPng.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('is not part of the public edition', async () => {
    const { app: server } = await app(fakeServices(), 'public');
    try {
      expect((await server.inject({ method: 'GET', url: '/api/reports/settings' })).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
