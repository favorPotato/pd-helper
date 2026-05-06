var SCRIPT_TOKEN = 'bbnuZ9kkjXQ8Ot';

var SHEET_NAMES = {
  tkInfluencers: 'tk博主',
  tkVideos: 'tk视频',
  igInfluencers: 'ig博主',
  igVideos: 'ig视频',
  noxPages: 'nox页码'
};

var INFLUENCER_HEADERS = [
  '频道ID', '用户名', '昵称', '国家', '状态', '性别标签',
  '粉丝数', '视频数', '合格率', '预估月更', '入库数', 'Nox评分',
  '错误信息', '扩展数据', '入库时间', '更新时间'
];

var INFLUENCER_KEYS = [
  'channelId', 'username', 'name', 'country', 'status', 'genderTag',
  'followers', 'totalVideos', 'qualifyingRate', 'postRate', 'archivedVideoCount', 'noxScore',
  'lastError', 'extraData', 'createdAt', 'updatedAt'
];

var VIDEO_HEADERS = ['视频ID', '视频数据'];
var NOX_PAGE_HEADERS = ['URL', '页码', '备注'];

var CLAIM_BATCH_LIMIT = 5;
var USING_RECYCLE_TIMEOUT_MS = 30 * 60 * 1000;

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload;
    var token = body.token;
    if (token !== SCRIPT_TOKEN) return reply({ ok: false, error: 'unauthorized' });
    if (action === 'upsertInfluencers') return reply(withDocumentLock_(function(){ return upsertInfluencers_(payload); }));
    if (action === 'loadInfluencersByStatus') return reply(loadInfluencersByStatus_(payload));
    if (action === 'loadInfluencersByField') return reply(loadInfluencersByField_(payload));
    if (action === 'loadInfluencersMissingGenderTag') return reply(loadInfluencersMissingGenderTag_(payload));
    if (action === 'updateInfluencerStatus') return reply(withDocumentLock_(function(){ return updateInfluencerStatus_(payload); }));
    if (action === 'updateInfluencerStatusBatch') return reply(withDocumentLock_(function(){ return updateInfluencerStatusBatch_(payload); }));
    if (action === 'upsertVideos') return reply(withDocumentLock_(function(){ return upsertVideos_(payload); }));
    if (action === 'getNoxPage') return reply(getNoxPage_(payload));
    if (action === 'upsertNoxPage') return reply(withDocumentLock_(function(){ return upsertNoxPage_(payload); }));
    if (action === 'getCollectedVideoIds') return reply(getCollectedVideoIds_(payload));
    if (action === 'claimUnusedBatch') return reply(withDocumentLock_(function(){ return claimUnusedBatch_(payload); }));
    return reply({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function withDocumentLock_(fn) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    return { ok: false, error: 'lock_timeout' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return reply({ ok: false, error: 'use POST' });
}

function reply(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getInfluencerSheet_(platform) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = platform === 'instagram' ? SHEET_NAMES.igInfluencers : SHEET_NAMES.tkInfluencers;
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, INFLUENCER_HEADERS.length).setValues([INFLUENCER_HEADERS]);
  }
  return sheet;
}

function getVideoSheet_(platform) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = platform === 'instagram' ? SHEET_NAMES.igVideos : SHEET_NAMES.tkVideos;
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, VIDEO_HEADERS.length).setValues([VIDEO_HEADERS]);
  }
  return sheet;
}

function getNoxPageSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.noxPages);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.noxPages);
    sheet.getRange(1, 1, 1, NOX_PAGE_HEADERS.length).setValues([NOX_PAGE_HEADERS]);
  }
  return sheet;
}

function getHeaderMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    map[headers[i]] = i;
  }
  return map;
}

function buildInfluencerItemFromRow_(row, headerMap) {
  var item = {};
  for (var k = 0; k < INFLUENCER_KEYS.length; k++) {
    var label = INFLUENCER_HEADERS[k];
    var colIdx = headerMap[label];
    if (colIdx !== undefined) item[INFLUENCER_KEYS[k]] = row[colIdx];
  }
  return item;
}

function applyInfluencerPatchToRow_(row, inf, headerMap) {
  for (var k = 0; k < INFLUENCER_KEYS.length; k++) {
    var key = INFLUENCER_KEYS[k];
    if (!Object.prototype.hasOwnProperty.call(inf, key)) continue;
    var label = INFLUENCER_HEADERS[k];
    var colIdx = headerMap[label];
    if (colIdx === undefined) continue;
    var val = inf[key];
    if (val === undefined || val === null) val = '';
    row[colIdx] = val;
  }
  return row;
}

function upsertInfluencers_(payload) {
  var platform = payload.platform || 'tiktok';
  var influencers = payload.influencers || [];
  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var channelIdCol = headerMap['频道ID'];
  var lastRow = sheet.getLastRow();
  var allRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues() : [];
  var existingIds = {};
  var colCount = sheet.getLastColumn();

  for (var r = 0; r < allRows.length; r++) {
    if (allRows[r][channelIdCol]) existingIds[String(allRows[r][channelIdCol])] = r + 2;
  }

  var added = 0;
  var skipped = 0;
  var newRows = [];
  for (var i = 0; i < influencers.length; i++) {
    var inf = influencers[i];
    var cid = String(inf.channelId || '');
    if (!cid) continue;

    if (existingIds[cid]) {
      var rowNum = existingIds[cid];
      var existingRow = allRows[rowNum - 2].slice();
      var mergedRow = applyInfluencerPatchToRow_(existingRow, inf, headerMap);
      mergedRow[headerMap['更新时间']] = new Date().toISOString();
      sheet.getRange(rowNum, 1, 1, mergedRow.length).setValues([mergedRow]);
      allRows[rowNum - 2] = mergedRow;
      skipped++;
      continue;
    }

    var newRow = new Array(colCount).fill('');
    newRow = applyInfluencerPatchToRow_(newRow, inf, headerMap);
    if (!newRow[headerMap['入库时间']]) newRow[headerMap['入库时间']] = new Date().toISOString();
    newRow[headerMap['更新时间']] = new Date().toISOString();
    if (!newRow[headerMap['状态']]) newRow[headerMap['状态']] = 'unused';
    newRows.push(newRow);
    existingIds[cid] = lastRow + newRows.length;
    allRows.push(newRow);
    added++;
  }

  if (newRows.length > 0) {
    sheet.getRange(lastRow + 1, 1, newRows.length, colCount).setValues(newRows);
  }

  return { ok: true, added: added, skipped: skipped };
}

function loadInfluencersByStatus_(payload) {
  var platform = payload.platform || 'tiktok';
  var status = payload.status || 'unused';
  return loadInfluencersByField_({
    platform: platform,
    field: 'status',
    operator: 'eq',
    value: status,
    limit: payload.limit || 500
  });
}

function loadInfluencersMissingGenderTag_(payload) {
  payload = payload || {};
  payload.field = 'genderTag';
  payload.operator = 'empty';
  return loadInfluencersByField_(payload);
}

function loadInfluencersByField_(payload) {
  var platform = payload.platform || 'tiktok';
  var field = String(payload.field || '').trim();
  var operator = String(payload.operator || 'eq').trim();
  var value = payload.value;
  var limit = payload.limit === undefined ? 200 : Number(payload.limit);
  var hasLimit = limit > 0;
  var fieldIdx = INFLUENCER_KEYS.indexOf(field);
  if (fieldIdx === -1) return { ok: false, error: 'invalid field' };

  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, items: [] };

  var label = INFLUENCER_HEADERS[fieldIdx];
  var targetCol = headerMap[label];
  if (targetCol === undefined) return { ok: false, error: 'field column not found' };

  var allRows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var items = [];
  var inValues = [];

  if (operator === 'in') {
    inValues = Array.isArray(value) ? value : [];
    inValues = inValues.map(function (v) { return String(v || '').trim(); }).filter(Boolean);
    if (inValues.length === 0) return { ok: true, items: [] };
  }

  for (var r = 0; r < allRows.length; r++) {
    var cell = allRows[r][targetCol];
    var cellStr = String(cell || '').trim();
    var matched = false;

    if (operator === 'empty') {
      matched = !cellStr;
    } else if (operator === 'notEmpty') {
      matched = !!cellStr;
    } else if (operator === 'in') {
      matched = inValues.indexOf(cellStr) !== -1;
    } else {
      matched = cellStr === String(value || '').trim();
    }

    if (!matched) continue;
    items.push(buildInfluencerItemFromRow_(allRows[r], headerMap));
    if (hasLimit && items.length >= limit) break;
  }

  return { ok: true, items: items };
}

function findInfluencerRow_(sheet, headerMap, channelId, lastRow) {
  var channelIdCol = headerMap['频道ID'];
  if (channelIdCol === undefined) return -1;
  var range = sheet.getRange(2, channelIdCol + 1, lastRow - 1, 1);
  var found = range.createTextFinder(channelId)
    .matchEntireCell(true).matchCase(true).matchFormulaText(false).findNext();
  return found ? found.getRow() : -1;
}

function applyPatchToRowData_(rowData, patch, headerMap) {
  for (var key in patch) {
    var idx = INFLUENCER_KEYS.indexOf(key);
    if (idx === -1) continue;
    var label = INFLUENCER_HEADERS[idx];
    var colIdx = headerMap[label];
    if (colIdx === undefined) continue;
    rowData[colIdx] = patch[key];
  }
}

function applyIncrementToRowData_(rowData, increment, headerMap) {
  if (!increment) return;
  for (var key in increment) {
    var idx = INFLUENCER_KEYS.indexOf(key);
    if (idx === -1) continue;
    var label = INFLUENCER_HEADERS[idx];
    var colIdx = headerMap[label];
    if (colIdx === undefined) continue;
    var oldVal = Number(rowData[colIdx]) || 0;
    var addVal = Number(increment[key]) || 0;
    rowData[colIdx] = oldVal + addVal;
  }
}

function updateInfluencerStatus_(payload) {
  var platform = payload.platform || 'tiktok';
  var channelId = String(payload.channelId || '');
  var patch = payload.patch || {};
  var increment = payload.increment || null;
  if (!channelId) return { ok: false, error: 'missing channelId' };

  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'not found' };

  var rowNum = findInfluencerRow_(sheet, headerMap, channelId, lastRow);
  if (rowNum < 0) return { ok: false, error: 'not found' };

  patch.updatedAt = new Date().toISOString();
  var lastCol = sheet.getLastColumn();
  var rowData = sheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  applyPatchToRowData_(rowData, patch, headerMap);
  applyIncrementToRowData_(rowData, increment, headerMap);
  sheet.getRange(rowNum, 1, 1, lastCol).setValues([rowData]);
  return { ok: true };
}

function updateInfluencerStatusBatch_(payload) {
  var platform = payload.platform || 'tiktok';
  var updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (!updates.length) return { ok: true, updated: 0, notFound: 0 };

  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { ok: false, error: 'empty sheet' };

  var nowIso = new Date().toISOString();
  var channelIdCol = headerMap['频道ID'];

  var idVals = sheet.getRange(2, channelIdCol + 1, lastRow - 1, 1).getValues();
  var idToRow = {};
  for (var r = 0; r < idVals.length; r++) {
    var v = String(idVals[r][0] || '');
    if (v) idToRow[v] = r + 2;
  }

  var resolved = [];
  var notFoundCnt = 0;
  for (var i = 0; i < updates.length; i++) {
    var cid = String(updates[i].channelId || '');
    if (!cid || !idToRow[cid]) { notFoundCnt++; continue; }
    resolved.push({
      rowNum: idToRow[cid],
      patch: updates[i].patch || {},
      increment: updates[i].increment || null
    });
  }
  if (!resolved.length) return { ok: true, updated: 0, notFound: notFoundCnt };

  resolved.sort(function (a, b) { return a.rowNum - b.rowNum; });
  var minRow = resolved[0].rowNum;
  var maxRow = resolved[resolved.length - 1].rowNum;
  var allData = sheet.getRange(minRow, 1, maxRow - minRow + 1, lastCol).getValues();
  for (var k = 0; k < resolved.length; k++) {
    var idx = resolved[k].rowNum - minRow;
    var patch = resolved[k].patch;
    patch.updatedAt = nowIso;
    applyPatchToRowData_(allData[idx], patch, headerMap);
    applyIncrementToRowData_(allData[idx], resolved[k].increment, headerMap);
  }
  sheet.getRange(minRow, 1, maxRow - minRow + 1, lastCol).setValues(allData);

  return { ok: true, updated: resolved.length, notFound: notFoundCnt };
}

function upsertVideos_(payload) {
  var platform = payload.platform || 'tiktok';
  var videos = payload.videos || [];
  var sheet = getVideoSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var videoIdCol = headerMap['视频ID'];
  var videoJsonCol = headerMap['视频数据'];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var existingIds = {};

  if (lastRow > 1) {
    var idVals = sheet.getRange(2, videoIdCol + 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < idVals.length; r++) {
      if (idVals[r][0]) existingIds[String(idVals[r][0])] = true;
    }
  }

  var skipped = 0;
  var newRows = [];
  for (var i = 0; i < videos.length; i++) {
    var vid = videos[i];
    var videoId = String(vid.videoId || '');
    if (!videoId) continue;
    if (existingIds[videoId]) {
      skipped++;
      continue;
    }
    var jsonStr = typeof vid.videoJson === 'string' ? vid.videoJson : JSON.stringify(vid);
    var row = new Array(lastCol).fill('');
    row[videoIdCol] = videoId;
    row[videoJsonCol] = jsonStr;
    newRows.push(row);
    existingIds[videoId] = true;
  }

  if (newRows.length > 0) {
    sheet.getRange(lastRow + 1, 1, newRows.length, lastCol).setValues(newRows);
  }

  return { ok: true, added: newRows.length, skipped: skipped };
}

function findNoxPageRow_(sheet, url, lastRow) {
  if (lastRow < 2) return -1;
  var range = sheet.getRange(2, 1, lastRow - 1, 1);
  var found = range.createTextFinder(url)
    .matchEntireCell(true).matchCase(true).matchFormulaText(false).findNext();
  return found ? found.getRow() : -1;
}

function upsertNoxPage_(payload) {
  var url = String(payload.url || '').trim();
  var pageNum = payload.pageNum;
  if (!url) return { ok: false, error: 'missing url' };

  var sheet = getNoxPageSheet_();
  var lastRow = sheet.getLastRow();
  var rowNum = findNoxPageRow_(sheet, url, lastRow);
  if (rowNum > 0) {
    sheet.getRange(rowNum, 2).setValue(pageNum);
    return { ok: true, updated: true };
  }

  sheet.appendRow([url, pageNum, '']);
  return { ok: true, added: true };
}

function getNoxPage_(payload) {
  var url = String(payload.url || '').trim();
  if (!url) return { ok: false, error: 'missing url' };

  var sheet = getNoxPageSheet_();
  var lastRow = sheet.getLastRow();
  var rowNum = findNoxPageRow_(sheet, url, lastRow);
  if (rowNum < 0) return { ok: true, found: false };
  var pageNum = sheet.getRange(rowNum, 2).getValue();
  return { ok: true, found: true, pageNum: Number(pageNum) || 1 };
}

function getCollectedVideoIds_(payload) {
  var platform = payload.platform || 'tiktok';
  var sheet = getVideoSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var videoIdCol = headerMap['视频ID'];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, ids: [] };

  var idVals = sheet.getRange(2, videoIdCol + 1, lastRow - 1, 1).getValues();
  var ids = [];
  for (var r = 0; r < idVals.length; r++) {
    if (idVals[r][0]) ids.push(String(idVals[r][0]));
  }

  return { ok: true, ids: ids };
}

function claimUnusedBatch_(payload) {
  var platform = payload.platform || 'tiktok';
  var requested = Number(payload.limit) || CLAIM_BATCH_LIMIT;
  var limit = Math.max(1, Math.min(requested, CLAIM_BATCH_LIMIT));

  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, items: [], claimed: 0, recycled: 0 };

  var lastCol = sheet.getLastColumn();
  var statusCol = headerMap['状态'];
  var updatedAtCol = headerMap['更新时间'];
  if (statusCol === undefined || updatedAtCol === undefined) {
    return { ok: false, error: 'missing required columns' };
  }

  var statusVals = sheet.getRange(2, statusCol + 1, lastRow - 1, 1).getValues();
  var targetRows = [];
  for (var r = 0; r < statusVals.length && targetRows.length < limit; r++) {
    if (String(statusVals[r][0] || '').trim() === 'unused') {
      targetRows.push(r + 2);
    }
  }
  if (targetRows.length === 0) return { ok: true, items: [], claimed: 0, recycled: 0 };

  var nowIso = new Date().toISOString();
  var items = [];
  var minR = targetRows[0];
  var maxR = targetRows[targetRows.length - 1];
  var spanSize = maxR - minR + 1;

  if (spanSize <= 100) {
    var span = sheet.getRange(minR, 1, spanSize, lastCol).getValues();
    for (var i = 0; i < targetRows.length; i++) {
      var rn = targetRows[i];
      var rowData = span[rn - minR].slice();
      rowData[statusCol] = 'using';
      rowData[updatedAtCol] = nowIso;
      items.push(buildInfluencerItemFromRow_(rowData, headerMap));
    }
  } else {
    for (var i = 0; i < targetRows.length; i++) {
      var rn = targetRows[i];
      var rowData = sheet.getRange(rn, 1, 1, lastCol).getValues()[0];
      rowData[statusCol] = 'using';
      rowData[updatedAtCol] = nowIso;
      items.push(buildInfluencerItemFromRow_(rowData, headerMap));
    }
  }

  for (var j = 0; j < targetRows.length; j++) {
    var rnW = targetRows[j];
    sheet.getRange(rnW, statusCol + 1).setValue('using');
    sheet.getRange(rnW, updatedAtCol + 1).setValue(nowIso);
  }

  return { ok: true, items: items, claimed: items.length, recycled: 0 };
}

function recycleStaleUsing_() {
  var platforms = ['tiktok', 'instagram'];
  for (var i = 0; i < platforms.length; i++) {
    withDocumentLock_(function (p) {
      return function () { return recycleStaleUsingForPlatform_(p); };
    }(platforms[i]));
  }
}

function recycleStaleUsingForPlatform_(platform) {
  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, recycled: 0 };

  var statusCol = headerMap['状态'];
  var updatedAtCol = headerMap['更新时间'];
  var lastErrorCol = headerMap['错误信息'];
  if (statusCol === undefined || updatedAtCol === undefined) {
    return { ok: false, error: 'missing required columns' };
  }

  var statusVals = sheet.getRange(2, statusCol + 1, lastRow - 1, 1).getValues();
  var updatedVals = sheet.getRange(2, updatedAtCol + 1, lastRow - 1, 1).getValues();

  var nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();
  var staleRows = [];
  for (var r = 0; r < statusVals.length; r++) {
    if (String(statusVals[r][0] || '').trim() !== 'using') continue;
    var ts = updatedVals[r][0];
    var ms = ts ? new Date(ts).getTime() : 0;
    if (!ms || (nowMs - ms) <= USING_RECYCLE_TIMEOUT_MS) continue;
    staleRows.push(r + 2);
  }

  for (var i = 0; i < staleRows.length; i++) {
    var rn = staleRows[i];
    sheet.getRange(rn, statusCol + 1).setValue('unused');
    sheet.getRange(rn, updatedAtCol + 1).setValue(nowIso);
    if (lastErrorCol !== undefined) sheet.getRange(rn, lastErrorCol + 1).setValue('auto_recycled');
  }

  return { ok: true, recycled: staleRows.length };
}

function installRecycleTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'recycleStaleUsing_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('recycleStaleUsing_').timeBased().everyMinutes(10).create();
  return { ok: true };
}
