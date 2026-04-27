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

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload;
    var token = body.token;
    if (token !== SCRIPT_TOKEN) return reply({ ok: false, error: 'unauthorized' });
    if (action === 'upsertInfluencers') return reply(upsertInfluencers_(payload));
    if (action === 'loadInfluencersByStatus') return reply(loadInfluencersByStatus_(payload));
    if (action === 'loadInfluencersByField') return reply(loadInfluencersByField_(payload));
    if (action === 'loadInfluencersMissingGenderTag') return reply(loadInfluencersMissingGenderTag_(payload));
    if (action === 'updateInfluencerStatus') return reply(updateInfluencerStatus_(payload));
    if (action === 'upsertVideos') return reply(upsertVideos_(payload));
    if (action === 'getNoxPage') return reply(getNoxPage_(payload));
    if (action === 'upsertNoxPage') return reply(upsertNoxPage_(payload));
    if (action === 'getCollectedVideoIds') return reply(getCollectedVideoIds_(payload));
    return reply({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
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

  for (var r = 0; r < allRows.length; r++) {
    if (allRows[r][channelIdCol]) existingIds[String(allRows[r][channelIdCol])] = r + 2;
  }

  var added = 0;
  var skipped = 0;
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

    var newRow = new Array(sheet.getLastColumn()).fill('');
    newRow = applyInfluencerPatchToRow_(newRow, inf, headerMap);
    if (!newRow[headerMap['入库时间']]) newRow[headerMap['入库时间']] = new Date().toISOString();
    newRow[headerMap['更新时间']] = new Date().toISOString();
    if (!newRow[headerMap['状态']]) newRow[headerMap['状态']] = 'unused';
    sheet.appendRow(newRow);
    existingIds[cid] = sheet.getLastRow();
    allRows.push(newRow);
    added++;
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
  var limit = payload.limit || 200;
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
    } else if (operator === 'in') {
      matched = inValues.indexOf(cellStr) !== -1;
    } else {
      matched = cellStr === String(value || '').trim();
    }

    if (!matched) continue;
    items.push(buildInfluencerItemFromRow_(allRows[r], headerMap));
    if (items.length >= limit) break;
  }

  return { ok: true, items: items };
}

function updateInfluencerStatus_(payload) {
  var platform = payload.platform || 'tiktok';
  var channelId = String(payload.channelId || '');
  var patch = payload.patch || {};
  if (!channelId) return { ok: false, error: 'missing channelId' };

  var sheet = getInfluencerSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var channelIdCol = headerMap['频道ID'];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'not found' };

  var idVals = sheet.getRange(2, channelIdCol + 1, lastRow - 1, 1).getValues();
  for (var r = 0; r < idVals.length; r++) {
    if (String(idVals[r][0]) !== channelId) continue;
    var rowNum = r + 2;
    patch.updatedAt = new Date().toISOString();
    var lastCol = sheet.getLastColumn();
    var rowData = sheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
    for (var key in patch) {
      var idx = INFLUENCER_KEYS.indexOf(key);
      if (idx === -1) continue;
      var label = INFLUENCER_HEADERS[idx];
      var colIdx = headerMap[label];
      if (colIdx === undefined) continue;
      rowData[colIdx] = patch[key];
    }
    sheet.getRange(rowNum, 1, 1, lastCol).setValues([rowData]);
    return { ok: true };
  }

  return { ok: false, error: 'not found' };
}

function upsertVideos_(payload) {
  var platform = payload.platform || 'tiktok';
  var videos = payload.videos || [];
  var sheet = getVideoSheet_(platform);
  var headerMap = getHeaderMap_(sheet);
  var videoIdCol = headerMap['视频ID'];
  var lastRow = sheet.getLastRow();
  var existingIds = {};

  if (lastRow > 1) {
    var idVals = sheet.getRange(2, videoIdCol + 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < idVals.length; r++) {
      if (idVals[r][0]) existingIds[String(idVals[r][0])] = true;
    }
  }

  var added = 0;
  var skipped = 0;
  for (var i = 0; i < videos.length; i++) {
    var vid = videos[i];
    var videoId = String(vid.videoId || '');
    if (!videoId) continue;
    if (existingIds[videoId]) {
      skipped++;
      continue;
    }
    var jsonStr = typeof vid.videoJson === 'string' ? vid.videoJson : JSON.stringify(vid);
    sheet.appendRow([videoId, jsonStr]);
    existingIds[videoId] = true;
    added++;
  }

  return { ok: true, added: added, skipped: skipped };
}

function upsertNoxPage_(payload) {
  var url = String(payload.url || '').trim();
  var pageNum = payload.pageNum;
  if (!url) return { ok: false, error: 'missing url' };

  var sheet = getNoxPageSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var urls = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < urls.length; i++) {
      if (String(urls[i][0] || '').trim() !== url) continue;
      sheet.getRange(i + 2, 2).setValue(pageNum);
      return { ok: true, updated: true };
    }
  }

  sheet.appendRow([url, pageNum, '']);
  return { ok: true, added: true };
}

function getNoxPage_(payload) {
  var url = String(payload.url || '').trim();
  if (!url) return { ok: false, error: 'missing url' };

  var sheet = getNoxPageSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, found: false };

  var rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() !== url) continue;
    return { ok: true, found: true, pageNum: Number(rows[i][1]) || 1 };
  }
  return { ok: true, found: false };
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
